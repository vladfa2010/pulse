// Smoke: ТЗ-186 — уведомление пользователя при записи на курс админом
// (POST /courses/:id/enrollments → notify_channels;
//  POST /courses/:id/enrollments/:userId/notify).
// Запуск: npm run build && node scripts/smoke-enroll-notify.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Провайдеры email/TG/push в тест-окружении не сконфигурированы — отправки
// не происходит: проверяем флаги каналов, skipped для неподключённого канала,
// 400/404, событие education.enroll_notified. Реальная доставка — live-пробой.
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/enroll-notify-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/enroll-notify-smoke/pulse.db';
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

function uuid() { return crypto.randomUUID(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + p, { method, headers, body, redirect: 'manual' });
  let json = null;
  let text = '';
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch { /* пустой/не-JSON */ }
  return { status: res.status, json, text };
}

// Снапшот строк из файла БД (in-memory sql.js — сервер ходит в своём).
async function rowsOf(sql, ...params) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_FILE));
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  db.close();
  return out;
}

async function seedDatabase() {
  process.env.SQLITE_FILE = DB_FILE;
  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  const q = sqlite.query;

  // admin — админ; plain — только аккаунтный email; tgUser — подключённый
  // Telegram; adminToken — JWT админа (is_admin в БД, роль в токене не нужна).
  const ids = { admin: uuid(), plain: uuid(), tg: uuid() };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin,
                        subscription_plan, subscription_active, created_at) VALUES
     ($1,'admin-en@test.ru','admin','x',1,'free',0,datetime('now')),
     ($2,'plain-en@test.ru','plain','x',0,'free',0,datetime('now')),
     ($3,'tg-en@test.ru','tguser','x',0,'free',0,datetime('now'))`,
    [ids.admin, ids.plain, ids.tg],
  );

  // Telegram подключён у tgUser (активная строка user_channels)
  await q(
    `INSERT INTO user_channels (id, user_id, channel, target, is_active, created_at)
     VALUES ($1,$2,'telegram','12345',1,datetime('now'))`,
    [uuid(), ids.tg],
  );

  const C = { main: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES
     ($1,'Курс уведомлений','enotify',0,'published','public')`,
    [C.main],
  );

  sqlite.saveDb();
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/dist/')) delete require.cache[m];
  }
  return { ids, C };
}

async function startServer(logBuf) {
  const { spawn } = require('child_process');
  // Провайдеры доставки глушим: смоук не должен слать реальные письма/пуши
  // (локальное окружение/.env могут содержать боевые ключи). Пустые строки
  // dotenv не перезаписывает — провайдеры останутся «не сконфигурированными».
  const env = { ...process.env };
  env.RESEND_API_KEY = '';
  env.EMAIL_PROVIDER = '';
  env.TELEGRAM_BOT_TOKEN = '';
  env.GOOGLE_APPLICATION_CREDENTIALS = '';
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = '';
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...env,
      USE_SQLITE: 'true',
      SQLITE_FILE: DB_FILE,
      UPLOADS_DIR: '/tmp/enroll-notify-smoke/uploads',
      SIGNED_URL_SECRET: 'test',
      JWT_SECRET: 'test',
      STORAGE_MIN_FREE_PCT: '0',
      CRON_SECRET_KEY: 'test',
      PORT: String(PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => logBuf.push(`[out] ${d}`));
  server.stderr.on('data', (d) => logBuf.push(`[err] ${d}`));
  const deadline = Date.now() + 60000;
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
  throw new Error(`server not healthy: ${lastErr}\n${logBuf.join('')}`);
}

async function scenario() {
  console.log('\n═══════ SMOKE ТЗ-186: уведомление при записи админом ═══════');
  fs.rmSync('/tmp/enroll-notify-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/enroll-notify-smoke/uploads', { recursive: true });

  const { ids, C } = await seedDatabase();
  const token = (id, email) => jwt.sign({ userId: id, email }, 'test');
  const adminJwt = token(ids.admin, 'admin-en@test.ru');
  const plainJwt = token(ids.plain, 'plain-en@test.ru');

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Запись админом → 201 + notify_channels (у plain только email)
    let r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments`,
      { token: adminJwt, body: { user_id: ids.plain } });
    assert(r.status === 201, `запись → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.source === 'admin_grant', `source='admin_grant': ${r.text.slice(0, 200)}`);
    assert(r.json.notify_channels
      && r.json.notify_channels.email === true
      && r.json.notify_channels.push === false
      && r.json.notify_channels.telegram === false,
      `notify_channels только email: ${r.text.slice(0, 300)}`);
    ok('1: запись админом → 201, notify_channels = {email:true, push:false, telegram:false}');

    // ── 2. Повторная запись → 200 already_enrolled + notify_channels тоже
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments`,
      { token: adminJwt, body: { user_id: ids.plain } });
    assert(r.status === 200 && r.json.already_enrolled === true,
      `повторная запись → 200 already_enrolled, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.notify_channels && typeof r.json.notify_channels.email === 'boolean',
      `notify_channels присутствует: ${r.text.slice(0, 300)}`);
    ok('2: already_enrolled → 200, notify_channels тоже в ответе');

    // ── 3. Юзер с подключённым Telegram → telegram=true
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments`,
      { token: adminJwt, body: { user_id: ids.tg } });
    assert(r.status === 201 && r.json.notify_channels.telegram === true,
      `telegram подключён → true: ${r.text.slice(0, 300)}`);
    ok('3: пользователь с активным user_channels telegram → notify_channels.telegram=true');

    // ── 4. notify по неподключённому каналу → skipped, отправки нет
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments/${ids.plain}/notify`,
      { token: adminJwt, body: { channels: ['telegram'] } });
    assert(r.status === 200 && r.json.skipped && r.json.skipped.telegram === 'channel_not_connected'
      && !r.json.sent.telegram,
      `notify telegram (не подключён) → skipped: ${r.text.slice(0, 300)}`);
    ok('4: notify по неподключённому каналу → skipped.channel_not_connected');

    // ── 5. notify по email (провайдер не сконфигурирован) → структура ответа
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments/${ids.plain}/notify`,
      { token: adminJwt, body: { channels: ['email'] } });
    assert(r.status === 200 && r.json.sent && r.json.skipped && r.json.failed,
      `notify email → 200 {sent, skipped, failed}: ${r.text.slice(0, 300)}`);
    assert(!r.json.sent.email, `email не помечен sent без провайдера: ${r.text.slice(0, 300)}`);
    ok('5: notify email → корректная структура {sent, skipped, failed}');

    // ── 6. Событие education.enroll_notified записано
    await sleep(600);
    const ev = await rowsOf(
      `SELECT event_data FROM user_events WHERE event_type = 'education.enroll_notified'`,
    );
    assert(ev.length >= 1, `событие enroll_notified есть: ${JSON.stringify(ev)}`);
    const evData = JSON.parse(ev[ev.length - 1].event_data);
    assert(evData.course_id === C.main && evData.target_user_id === ids.plain
      && Array.isArray(evData.channels),
      `enroll_notified {course_id, target_user_id, channels}: ${ev[ev.length - 1].event_data}`);
    ok('6: событие education.enroll_notified с course_id/target_user_id/channels');

    // ── 7. Валидация: пустые/мусорные channels → 400
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments/${ids.plain}/notify`,
      { token: adminJwt, body: { channels: [] } });
    assert(r.status === 400, `пустой channels → 400, got ${r.status}`);
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments/${ids.plain}/notify`,
      { token: adminJwt, body: { channels: ['smoke-signal'] } });
    assert(r.status === 400, `неизвестный канал → 400, got ${r.status}`);
    ok('7: channels [] и неизвестный канал → 400');

    // ── 8. Без enrollment → 404; гость → 401
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments/${uuid()}/notify`,
      { token: adminJwt, body: { channels: ['email'] } });
    assert(r.status === 404, `notify незаписанному → 404, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('POST', `/api/admin/education/courses/${C.main}/enrollments/${ids.plain}/notify`,
      { body: { channels: ['email'] } });
    assert(r.status === 401, `notify без токена → 401, got ${r.status}`);
    ok('8: нет enrollment → 404, гость → 401');

    console.log(`\nOK ${passed}: все проверки ТЗ-186 пройдены`);
  } finally {
    server.kill('SIGTERM');
  }
}

scenario().catch((err) => {
  console.error('\nTZ186 FAIL:', err.message);
  process.exit(1);
});
