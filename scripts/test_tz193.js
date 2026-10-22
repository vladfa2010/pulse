// ТЗ-193 — backend-чеклист advisor_notes: лента заметок (до 5), CRUD, лимит,
// ownership, архив, миграция из advisor_clients.notes, каскад, идемпотентность.
// Прогон: npm run build && node scripts/test_tz193.js
//
// Фазы:
//   A. In-process seed (SQLite/sql.js, до подъёма сервера): advisor_clients
//      (с legacy-колонкой notes) + легаси-клиент с заметкой, план/юзеры.
//   B. HTTP против дочернего сервера: boot-DDL advisor_notes, CRUD, лимит 5,
//      400/403/404, archived, миграция legacy-колонки (re-boot), идемпотентность
//      двойного boot, ON DELETE CASCADE.
//   C. PG-smoke (TEST_PG_URL): advisor_notes, FK CASCADE, индекс. Без env — SKIP.
//
// ВАЖНО про sql.js: сервер держит БД в памяти и пишет файл при выходе —
// внешние записи в файл ПОКА сервер работает ему невидимы. Поэтому сид —
// in-process до старта, а запись легаси-клиента — в сиде (миграция
// отработает на boot сервера), каскад-проверка — после остановки сервера.
process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/tz193-smoke/pulse.db';
process.env.JWT_SECRET = 'test';
process.env.TELEGRAM_BOT_TOKEN = 'test:token12345';
process.env.CRON_SECRET_KEY = 'test-cron-secret';
delete process.env.KIMI_API_KEY;

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = 3913;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = '/tmp/tz193-smoke';
const DBFILE = `${DIR}/pulse.db`;
const SQLITE_EXEC = path.join(__dirname, 'lib', 'sqlite-exec.js');
let passed = 0;
let query;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

const uuid = () => crypto.randomUUID();

/** Read-only запросы к файлу БД (свежий процесс sql.js; только пока сервер стоит). */
function dbExec(...sqls) {
  const res = spawnSync(process.execPath, [SQLITE_EXEC, DBFILE, ...sqls], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`sqlite-exec failed: ${res.stderr}\nSQL: ${sqls.join(' | ')}`);
  return JSON.parse(res.stdout);
}

async function api(method, p, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + p, { method, headers, body });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* не-JSON (204) */ }
  return { status: res.status, json, text };
}

// ─── Фаза A: seed in-process ─────────────────────────────────────────────────
async function seed() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  query = sqlite.query;

  // advisor_clients — та же форма, что в boot-миграции (ТЗ-182): серверу
  // безразлично (CREATE IF NOT EXISTS), в сиде нужна для легаси-клиента.
  await query(`CREATE TABLE IF NOT EXISTS advisor_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, advisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, notes TEXT, is_archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, last_alert_neg_at TEXT, last_alert_pos_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);

  const ids = { main: uuid(), other: uuid() };

  // Кастомный план с явным энтитлментом multi_portfolio (boot-seed'овые планы
  // имеют features без multi_portfolio, авто-флаг выставляется только при NULL —
  // поэтому как в ТЗ-182 задаём явно) + активная подписка (иначе hasFeature → false)
  await query(
    `INSERT INTO subscription_plans (id, name, price, tag_limit, portfolio_limit, plan_level, features, display_order, is_active)
     VALUES ('tz193plan','TZ193 Plan',0,10,5,1,'{"multi_portfolio":true}',95,1)`,
  );
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  for (const [id, email] of [[ids.main, 'tz193-main@test.ru'], [ids.other, 'tz193-other@test.ru']]) {
    await query(
      `INSERT INTO users (id, email, username, password_hash, is_admin, is_verified, subscription_plan, subscription_active, subscription_expires_at)
       VALUES ($1,$2,$3,'x',0,1,'tz193plan',1,$4)`,
      [id, email, email.split('@')[0], expires],
    );
  }

  // Легаси-клиент с одиночной заметкой в колонке (миграция ТЗ-193 отработает на boot)
  await query(
    `INSERT INTO advisor_clients (advisor_user_id, name, notes, sort_order) VALUES ($1,'Легаси клиент','Старая заметка из колонки',50)`,
    [ids.main],
  );
  return ids;
}

// ─── Фаза B: HTTP против дочернего сервера ──────────────────────────────────
async function startServer(logBuf) {
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...process.env,
      USE_SQLITE: 'true',
      SQLITE_FILE: DBFILE,
      UPLOADS_DIR: `${DIR}/uploads`,
      JWT_SECRET: 'test',
      SIGNED_URL_SECRET: 'test',
      TELEGRAM_BOT_TOKEN: 'test:token12345',
      CRON_SECRET_KEY: 'test-cron-secret',
      STORAGE_MIN_FREE_PCT: '0',
      PORT: String(PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => logBuf.push(`[out] ${d}`));
  server.stderr.on('data', (d) => logBuf.push(`[err] ${d}`));
  const deadline = Date.now() + 90000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        await new Promise((r2) => setTimeout(r2, 1500));
        return server;
      }
    } catch (e) { lastErr = e.message; }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  throw new Error(`server did not become healthy: ${lastErr}\n${logBuf.join('')}`);
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || server.killed) return resolve();
    server.once('exit', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* уже умер */ } }, 5000).unref();
  });
}

async function phaseB(ids) {
  const tokens = {
    main: jwt.sign({ userId: ids.main, email: 'tz193-main@test.ru' }, 'test'),
    other: jwt.sign({ userId: ids.other, email: 'tz193-other@test.ru' }, 'test'),
  };

  const logBuf = [];
  let server = await startServer(logBuf);
  let legacyId;
  try {
    // ── B1. Boot-DDL + миграция legacy-колонки ─────────────────────────────
    const cols = dbExec(`SELECT name FROM pragma_table_info('advisor_notes') ORDER BY name`)[0].map((r) => r.name);
    assert.deepStrictEqual(cols, ['client_id', 'created_at', 'id', 'text', 'updated_at'], `колонки advisor_notes: ${cols}`);
    const idx = dbExec(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_advisor_notes_client'`)[0];
    assert(idx.length === 1, 'idx_advisor_notes_client на месте');
    ok('B1: boot-DDL advisor_notes + индекс (обе ветки по коду миграции)');

    let r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    const legacy = r.json.clients.find((c) => c.name === 'Легаси клиент');
    assert(legacy && legacy.notes_count === 1, 'миграция: notes_count=1 у легаси-клиента');
    assert(!('notes' in legacy), 'скалярного notes в списке нет');
    legacyId = legacy.id;
    r = await api('GET', `/api/advisor/clients/${legacyId}`, { token: tokens.main });
    assert(r.json.notes.length === 1 && r.json.notes[0].text === 'Старая заметка из колонки', 'текст мигрирован дословно, notes[] DESC');
    ok('B2: миграция advisor_clients.notes → первая запись ленты (данные не потеряны)');

    // ── B3. CRUD + detail/список ────────────────────────────────────────────
    r = await api('POST', '/api/advisor/clients', { token: tokens.main, body: { name: 'Иванова Ольга' } });
    assert(r.status === 201, `create client → 201, got ${r.status}: ${r.text}`);
    const clientId = r.json.client.id;
    assert(r.json.client.notes_count === 0, 'create отдаёт notes_count=0');

    r = await api('POST', `/api/advisor/clients/${clientId}/notes`, { token: tokens.main, body: { text: '  Первая заметка  ' } });
    assert(r.status === 201 && r.json.note.text === 'Первая заметка', 'POST note → 201, trim применён');
    const note1 = r.json.note;
    assert(note1.updated_at === null, 'updated_at NULL до первой правки');
    assert(typeof note1.created_at === 'string', 'created_at ISO');

    r = await api('GET', `/api/advisor/clients/${clientId}`, { token: tokens.main });
    assert(r.status === 200 && r.json.notes.length === 1 && r.json.notes[0].id === note1.id, 'detail отдаёт notes[]');
    assert(r.json.counts.notes === 1, 'counts.notes');

    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    const inList = r.json.clients.find((c) => c.id === clientId);
    assert(inList && inList.notes_count === 1, 'список отдаёт notes_count=1');
    ok('B3: POST note (201, trim, ISO), detail notes[], список notes_count без скаляра');

    // ── B4. Лимит 5 ─────────────────────────────────────────────────────────
    for (let i = 2; i <= 5; i++) {
      r = await api('POST', `/api/advisor/clients/${clientId}/notes`, { token: tokens.main, body: { text: `Заметка ${i}` } });
      assert(r.status === 201, `заметка ${i}/5 → 201`);
    }
    r = await api('POST', `/api/advisor/clients/${clientId}/notes`, { token: tokens.main, body: { text: 'Шестая' } });
    assert(r.status === 403 && r.json.error === 'note_limit_reached' && r.json.limit === 5, `6-я → 403 note_limit_reached, got ${r.status} ${r.text}`);
    r = await api('POST', `/api/advisor/clients/${clientId}/notes`, { token: tokens.main, body: { text: '   ' } });
    assert(r.status === 400 && r.json.error === 'invalid_note_text', 'whitespace-only → 400 invalid_note_text');
    r = await api('POST', `/api/advisor/clients/${clientId}/notes`, { token: tokens.main, body: {} });
    assert(r.status === 400, 'без текста → 400 (zod)');
    ok('B4: лимит 5 (6-я → 403 note_limit_reached), пустой текст → 400');

    // ── B5. Inline-edit: PATCH + updated_at ─────────────────────────────────
    r = await api('PATCH', `/api/advisor/notes/${note1.id}`, { token: tokens.main, body: { text: 'Отредактировано' } });
    assert(r.status === 200 && r.json.note.text === 'Отредактировано' && r.json.note.updated_at !== null, 'PATCH → 200, updated_at проставлен');
    r = await api('PATCH', `/api/advisor/notes/${note1.id}`, { token: tokens.main, body: { text: '  ' } });
    assert(r.status === 400 && r.json.error === 'invalid_note_text', 'PATCH whitespace → 400');
    r = await api('PATCH', '/api/advisor/notes/999999', { token: tokens.main, body: { text: 'X' } });
    assert(r.status === 404 && r.json.error === 'advisor_note_not_found', 'несуществующая → 404 advisor_note_not_found');
    ok('B5: PATCH note (updated_at), whitespace → 400, несуществующая → 404');

    // ── B6. Владение и архив ────────────────────────────────────────────────
    r = await api('POST', '/api/advisor/clients', { token: tokens.other, body: { name: 'Чужой клиент' } });
    const foreignClient = r.json.client.id;
    r = await api('POST', `/api/advisor/clients/${foreignClient}/notes`, { token: tokens.other, body: { text: 'чужая заметка' } });
    const foreignNote = r.json.note.id;
    r = await api('PATCH', `/api/advisor/notes/${foreignNote}`, { token: tokens.main, body: { text: 'взлом' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_forbidden', 'чужая заметка PATCH → 403 forbidden');
    r = await api('DELETE', `/api/advisor/notes/${foreignNote}`, { token: tokens.main });
    assert(r.status === 403 && r.json.error === 'advisor_client_forbidden', 'чужая заметка DELETE → 403 forbidden');

    r = await api('PATCH', `/api/advisor/clients/${clientId}`, { token: tokens.main, body: { is_archived: true } });
    assert(r.status === 200, 'архивация → 200');
    r = await api('POST', `/api/advisor/clients/${clientId}/notes`, { token: tokens.main, body: { text: 'в архив' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_archived', 'архив: POST note → 403 archived');
    r = await api('PATCH', `/api/advisor/notes/${note1.id}`, { token: tokens.main, body: { text: 'правка в архиве' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_archived', 'архив: PATCH note → 403 archived');
    r = await api('GET', `/api/advisor/clients/${clientId}`, { token: tokens.main });
    assert(r.status === 200 && r.json.notes.length === 5, 'архив читается: notes[] на месте');
    ok('B6: ownership (чужая → 403), архив (write → 403 advisor_client_archived, read ок)');

    // ── B7. Удаление ────────────────────────────────────────────────────────
    r = await api('DELETE', `/api/advisor/notes/${note1.id}`, { token: tokens.main });
    assert(r.status === 403 && r.json.error === 'advisor_client_archived', 'архив: DELETE note → 403 archived (read-only)');
    r = await api('PATCH', `/api/advisor/clients/${clientId}`, { token: tokens.main, body: { is_archived: false } });
    assert(r.status === 200, 'разархивация → 200');
    r = await api('DELETE', `/api/advisor/notes/${note1.id}`, { token: tokens.main });
    assert(r.status === 204, 'DELETE → 204');
    r = await api('DELETE', `/api/advisor/notes/${note1.id}`, { token: tokens.main });
    assert(r.status === 404, 'повторный DELETE → 404');
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.json.clients.find((c) => c.id === clientId).notes_count === 4, 'после удаления notes_count=4');
    ok('B7: DELETE 204, повторный → 404, счётчик уменьшился');

    // ── B8. Идемпотентность двойного boot ───────────────────────────────────
    const before = dbExec(`SELECT COUNT(*) AS cnt FROM advisor_notes WHERE client_id = ${legacyId}`)[0];
    assert(Number(before[0].cnt) === 1, 'у легаси ровно 1 заметка');
    await stopServer(server);
    server = await startServer(logBuf);
    r = await api('GET', `/api/advisor/clients/${legacyId}`, { token: tokens.main });
    assert(r.json.notes.length === 1 && r.json.notes[0].text === 'Старая заметка из колонки', 're-boot: заметка на месте, без дублей');
    ok('B8: двойной boot не дублирует мигрированную заметку');
  } finally {
    await stopServer(server);
  }

  // ── B9. Каскад (сервер остановлен — файл актуален) ─────────────────────────
  dbExec(`DELETE FROM advisor_clients WHERE id = ${legacyId}`);
  const left = dbExec(`SELECT COUNT(*) AS cnt FROM advisor_notes WHERE client_id = ${legacyId}`)[0];
  assert(Number(left[0].cnt) === 0, 'ON DELETE CASCADE: заметки легаси-клиента удалены');
  const total = dbExec('SELECT COUNT(*) AS cnt FROM advisor_notes')[0];
  assert(Number(total[0].cnt) === 5, 'заметки живых клиентов не пострадали (4 у основного + 1 у чужого юзера)');
  ok('B9: ON DELETE CASCADE клиент→заметки');
}

// ─── Фаза C: PG-smoke (TEST_PG_URL) ─────────────────────────────────────────
async function phaseC() {
  const pgUrl = process.env.TEST_PG_URL;
  if (!pgUrl) {
    console.log('SKIP: PG-smoke (TEST_PG_URL не задан) — живой PG-прогон на этой машине невозможен (нет Docker/локального PostgreSQL)');
    return;
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: pgUrl, ssl: /localhost|127\.0\.0\.1/.test(pgUrl) ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='advisor_notes' ORDER BY column_name`);
    const names = cols.rows.map((r) => r.column_name);
    assert.deepStrictEqual(names, ['client_id', 'created_at', 'id', 'text', 'updated_at'], `advisor_notes колонки: ${names}`);
    ok('C1: PG — advisor_notes на месте с ожидаемыми колонками');

    const fk = await client.query(
      `SELECT rc.delete_rule FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
       WHERE tc.table_schema='public' AND tc.table_name='advisor_notes' AND ccu.table_name='advisor_clients'`);
    assert(fk.rows.length > 0 && fk.rows.every((r) => r.delete_rule === 'CASCADE'), 'FK advisor_notes→advisor_clients CASCADE');
    ok('C2: PG — FK advisor_notes→advisor_clients ON DELETE CASCADE');

    const idx = await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_advisor_notes_client'`);
    assert(idx.rows.length === 1, 'idx_advisor_notes_client на месте');
    ok('C3: PG — индекс idx_advisor_notes_client');
  } finally {
    await client.end();
  }
}

(async () => {
  try {
    const ids = await seed();
    await phaseB(ids);
    await phaseC();
    console.log(`\nOK ${passed}: все проверки ТЗ-193 пройдены`);
    process.exit(0);
  } catch (e) {
    console.error('\nTZ193 FAIL:', e);
    process.exit(1);
  }
})();
