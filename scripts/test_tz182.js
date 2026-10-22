// ТЗ-182 v16 Задача 9 (по ТЗ-191 Задача 1) — backend-чеклист advisor-модуля.
// Прогон: npm run build && node scripts/test_tz182.js
//
// Фазы:
//   A. In-process (SQLite/sql.js, до подъёма сервера): DDL advisor_* (как в
//      boot-миграциях), библиотека саммари, слоты-хэши, ON DELETE CASCADE,
//      downgrade-хук (включая падение модуля), partial unique idx_advisor_tasks_event.
//   B. HTTP: dist/index.js дочерним процессом — schema-diff ядра, регрессия ядра,
//      CRUD/владение/архив/лимиты/гейты, эквивалентность библиотеки, summaries,
//      refresh 429, слоты крона, события, kill-switch drill, повторный boot.
//   C. PG-smoke (TEST_PG_URL): UUID-FK, частичные индексы. Без env — SKIP.
process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/tz182-smoke/pulse.db';
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
const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = '/tmp/tz182-smoke';
const DBFILE = `${DIR}/pulse.db`;
const SECRET = 'test-cron-secret';
const SQLITE_EXEC = path.join(__dirname, 'lib', 'sqlite-exec.js');
let passed = 0;
let query;
let sqlite;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

const uuid = () => crypto.randomUUID();
/** UUID с заданным остатком первых 8 hex % 3 (детерминированные слоты крона). */
function uuidWithMod(mod) {
  for (let i = 0; i < 10000; i++) {
    const id = crypto.randomUUID();
    if (parseInt(id.replace(/-/g, '').slice(0, 8), 16) % 3 === mod) return id;
  }
  throw new Error(`uuidWithMod(${mod}) not found`);
}

/** Read-only запросы к файлу БД сервера (свежий процесс sql.js). */
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
  let text = '';
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch { /* не-JSON ответ */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function tableColumnsInProcess(table) {
  const r = await query(`PRAGMA table_info(${table})`);
  return r.rows.map((row) => row.name).sort();
}

// ─── Фаза A: seed + in-process проверки ──────────────────────────────────────
async function seedAndPhaseA() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  query = sqlite.query;

  // Колонки, которые сервер доводит boot-миграциями; в seed нужны раньше
  await query(`ALTER TABLE news ADD COLUMN slug TEXT`);
  await query(`ALTER TABLE news ADD COLUMN source_count INTEGER DEFAULT 1`);
  await query(`ALTER TABLE news ADD COLUMN all_sources TEXT`);
  // Таблицы из schema.sql, которых нет в initSQLiteSchema (нужны ядру: getUserTagsFull и т.п.)
  await query(`CREATE TABLE IF NOT EXISTS news_tag_links (
    id TEXT PRIMARY KEY, news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
    tag_id VARCHAR(50) NOT NULL, impact_score INTEGER, impact_reasoning TEXT,
    link_source VARCHAR(20) NOT NULL DEFAULT 'keyword', link_version INTEGER DEFAULT 1,
    linked_at TEXT DEFAULT (datetime('now')), UNIQUE(news_id, tag_id, link_source))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_links_news_id ON news_tag_links(news_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_links_tag_id ON news_tag_links(tag_id)`);
  await query(`ALTER TABLE portfolios ADD COLUMN is_frozen INTEGER NOT NULL DEFAULT 0`);
  // user_defined_tags создаётся серверной миграцией при старте; в seed нужна раньше
  await query(`CREATE TABLE IF NOT EXISTS user_defined_tags (
    tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL,
    tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT DEFAULT '{}',
    enriched_data TEXT, created_by VARCHAR(100), created_at TEXT DEFAULT (datetime('now')))`);
  // calendar_events в финальной форме (иначе SQLite-ребилд V2 не сработает)
  await query(`CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    date DATE NOT NULL, weekday VARCHAR(2) NOT NULL, title TEXT NOT NULL,
    kind VARCHAR(10) NOT NULL, status VARCHAR(10) NOT NULL, company TEXT NOT NULL,
    ticker TEXT NOT NULL, uploaded_at TIMESTAMP DEFAULT (datetime('now')),
    sources TEXT, possible_duplicate INTEGER DEFAULT 0, tag_ids TEXT, matched_via TEXT,
    UNIQUE (date, title, kind, ticker))`);
  // advisor_* — те же CREATE TABLE, что и в boot-миграциях (index.ts, ТЗ-182):
  // в seed нужны раньше для in-process проверок каскада/даунгрейда; серверу
  // они безразличны (CREATE TABLE IF NOT EXISTS идемпотентны).
  await query(`CREATE TABLE IF NOT EXISTS advisor_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, advisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, notes TEXT, is_archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, last_alert_neg_at TEXT, last_alert_pos_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_advisor_clients_user ON advisor_clients(advisor_user_id)`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_client_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE, tag_id TEXT, tag_name TEXT NOT NULL, tag_type TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_client_tags_uniq ON advisor_client_tags(client_id, tag_name)`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_summaries (client_id INTEGER NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE, period_hours INTEGER NOT NULL, summary TEXT NOT NULL, articles_count INTEGER NOT NULL, sentiment_mix TEXT, tags_snapshot TEXT, generated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (client_id, period_hours))`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE, advisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, due_date TEXT, source_event_id TEXT, is_done INTEGER NOT NULL DEFAULT 0, remind_at TEXT, remind_channels TEXT, reminded_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_tasks_event ON advisor_tasks(client_id, source_event_id) WHERE source_event_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_advisor_tasks_user ON advisor_tasks(advisor_user_id) WHERE is_done = 0`);
  await query(`CREATE INDEX IF NOT EXISTS idx_advisor_tasks_remind ON advisor_tasks(remind_at) WHERE reminded_at IS NULL AND is_done = 0`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, summary_slots TEXT, telegram_chat_id TEXT, notify_prefs TEXT, created_at TEXT DEFAULT (datetime('now')))`);

  const ids = {};
  const insertUser = async (id, email, plan, { admin = 0, active = 1, expiresDays = 30, expiresPast = false } = {}) => {
    const expires = expiresPast
      ? new Date(Date.now() - 24 * 3600 * 1000).toISOString()
      : new Date(Date.now() + expiresDays * 24 * 3600 * 1000).toISOString();
    await query(
      `INSERT INTO users (id, email, username, password_hash, is_admin, is_verified,
                          subscription_plan, subscription_active, subscription_expires_at)
       VALUES ($1,$2,$3,'x',$4,1,$5,$6,$7)`,
      [id, email, email.split('@')[0], admin, plan, active, expires],
    );
  };

  ids.admin = uuid();
  ids.main = uuidWithMod(1);  // pro: лимит 20; дефолт-слоты [7,18]
  ids.other = uuidWithMod(1); // premium: лимит 3; слоты [7,18] (не пересекаются с тестовыми часами)
  ids.slot = uuidWithMod(0);  // club: дефолт-слоты [6,17]
  ids.gate = uuidWithMod(1);  // кастомный план лимит 0 + multi_portfolio; слоты [7,18]
  ids.down = uuidWithMod(1);    // downgrade-хук; слоты [7,18] — вне тестовых часов 6/10/20
  ids.down2 = uuidWithMod(1);   // downgrade-хук с падением модуля; слоты [7,18]
  ids.cascade = uuid();

  // 'base': portfolio_limit=0, без multi_portfolio — boot-миграция free→premium
  // трогает только 'free', поэтому для гейт-теста берём 'base'
  await insertUser(ids.admin, 'tz182-admin@test.ru', 'base', { admin: 1 });
  await insertUser(ids.main, 'tz182-main@test.ru', 'pro');
  await insertUser(ids.other, 'tz182-other@test.ru', 'premium');
  await insertUser(ids.slot, 'tz182-slot@test.ru', 'club');
  await query(`INSERT INTO advisor_clients (advisor_user_id, name, sort_order) VALUES ($1,'Слот-клиент',1)`, [ids.slot]);
  // План гейта: portfolio_limit=0, но энтитлмент multi_portfolio выставлен явно
  await query(
    `INSERT INTO subscription_plans (id, name, price, tag_limit, portfolio_limit, plan_level, features, display_order, is_active)
     VALUES ('tz182gate','TZ182 Gate',0,10,0,1,'{"telegram":false,"push":false,"multi_portfolio":true}',90,1)`,
  );
  await insertUser(ids.gate, 'tz182-gate@test.ru', 'tz182gate');
  // Планы даунгрейда: 10 -> 2
  for (const [pid, limit] of [['tz182down', 10], ['tz182down2', 2]]) {
    await query(
      `INSERT INTO subscription_plans (id, name, price, tag_limit, portfolio_limit, plan_level, features, display_order, is_active)
       VALUES ($1,'TZ182 Down',0,10,$2,1,'{"multi_portfolio":true}',91,1)`,
      [pid, limit],
    );
  }
  await insertUser(ids.down, 'tz182-down@test.ru', 'tz182down', { expiresPast: true });
  await insertUser(ids.down2, 'tz182-down2@test.ru', 'tz182down', { expiresPast: true });
  await query(`UPDATE users SET scheduled_plan_downgrade = 'tz182down2' WHERE id IN ($1,$2)`, [ids.down, ids.down2]);
  await insertUser(ids.cascade, 'tz182-cascade@test.ru', 'free', { active: 0 });

  // Портфель ядра для эквивалентности summary (модульные теги = sber)
  await query(
    `INSERT INTO portfolios (id, user_id, tag_id, tag_name, tag_type, is_frozen)
     VALUES ($1,$2,'sber','Сбербанк','company',0)`,
    [uuid(), ids.main],
  );

  // Фиксированный датасет новостей
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const newsFix = [
    ['sber-1', 'Сбер: новость 1', ['sber'], 1],
    ['sber-2', 'Сбер: новость 2', ['sber'], 2],
    ['sber-3', 'Сбер: новость 3', ['sber'], 3],
    ['sber-gazp', 'Сбер и Газпром', ['sber', 'gazp'], 4],
    ['gazp-1', 'Газпром: новость', ['gazp'], 2.5],
    ['lkoh-1', 'Лукойл: новость', ['lkoh'], 1.5],
    ['sber-old', 'Сбер: старая', ['sber'], 48],
    ['no-tags', 'Новость без тегов', [], 1],
  ];
  for (const [slug, title, tags, h] of newsFix) {
    await query(
      `INSERT INTO news (id, title_ru, slug, url, source, source_id, published_at, matched_tags, sentiment, summary_ru)
       VALUES ($1,$2,$3,'https://example.com/' || $3,'tz182','tz182',$4,$5,'neutral','краткое содержание')`,
      [uuid(), title, `tz182-${slug}`, hoursAgo(h), JSON.stringify(tags)],
    );
  }
  await query(`INSERT INTO user_defined_tags (tag_id, tag_name, tag_type) VALUES ('sber','Сбербанк','company'),('gazp','Газпром','company'),('lkoh','Лукойл','company')`);

  // События календаря для ТЗ-182 9.10
  const mskDate = (offsetDays) => new Date(Date.now() + 3 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
  await query(
    `INSERT INTO calendar_events (id, date, weekday, title, kind, status, company, ticker, tag_ids, matched_via, sources)
     VALUES ('ev-sber',$1,'ср','Отчётность Сбера','МСФО','expected','Сбер','SBER','["sber"]','manual','["tz182"]')`, [mskDate(3)]);
  await query(
    `INSERT INTO calendar_events (id, date, weekday, title, kind, status, company, ticker, tag_ids, matched_via, sources)
     VALUES ('ev-gazp',$1,'ср','Собрание Газпрома','СА','confirmed','Газпром','GAZP','["gazp"]','manual','["tz182"]')`, [mskDate(3)]);
  await query(
    `INSERT INTO calendar_events (id, date, weekday, title, kind, status, company, ticker, tag_ids, matched_via, sources)
     VALUES ('ev-none',$1,'ср','Событие без матчинга','Другое','confirmed','X','XXX',NULL,NULL,'["tz182"]')`, [mskDate(3)]);

  // Клиенты даунгрейд-пользователей
  for (let i = 1; i <= 4; i++) {
    await query(`INSERT INTO advisor_clients (advisor_user_id, name, sort_order) VALUES ($1,$2,$3)`, [ids.down, `Даун-${i}`, i]);
  }
  for (let i = 1; i <= 2; i++) {
    await query(`INSERT INTO advisor_clients (advisor_user_id, name, sort_order) VALUES ($1,$2,$3)`, [ids.down2, `Даун2-${i}`, i]);
  }
  // Клиент каскадного пользователя
  ids.cascadeClient = (
    await query(`INSERT INTO advisor_clients (advisor_user_id, name, sort_order) VALUES ($1,'Cascade',1) RETURNING id`, [ids.cascade])
  ).rows[0].id;

  // Снапшот колонок ядра до boot-миграций (схема-diff, ТЗ-182 9.1)
  const coreTables = ['users', 'portfolios', 'notification_subscriptions', 'user_news_reads', 'news'];
  const before = {};
  for (const t of coreTables) before[t] = await tableColumnsInProcess(t);
  const plansBefore = await tableColumnsInProcess('subscription_plans');
  sqlite.saveDb();
  ids.coreBefore = before;
  ids.plansBefore = plansBefore;

  // ── A1/A2. Библиотека Задачи 5: selectNewsByTags / buildSummaryPrompt ──────
  const { selectNewsByTags, buildSummaryPrompt } = require(path.join(DIST, 'services', 'userSummary'));

  const libSber = await selectNewsByTags(['sber'], 12);
  assert.deepStrictEqual(libSber.map((a) => a.slug), ['tz182-sber-1', 'tz182-sber-2', 'tz182-sber-3', 'tz182-sber-gazp']);
  const times = libSber.map((a) => new Date(a.published_at).getTime());
  assert.deepStrictEqual(times, [...times].sort((x, y) => y - x), 'ORDER BY published_at DESC');
  const libBoth = await selectNewsByTags(['sber', 'gazp'], 12);
  assert(libBoth.some((a) => a.slug === 'tz182-gazp-1'), 'gazp-1 по тегу gazp');
  assert(!libBoth.some((a) => a.slug === 'tz182-lkoh-1'), 'lkoh-1 отсутствует');
  assert(!libBoth.some((a) => a.slug === 'tz182-no-tags'), 'новость без тегов отсутствует');
  assert(!libBoth.some((a) => a.slug === 'tz182-sber-old'), 'новость 48ч вне окна 12ч отсутствует');
  ids.expectedSberSlugs = ['tz182-sber-1', 'tz182-sber-2', 'tz182-sber-3', 'tz182-sber-gazp'];
  ok('A1: selectNewsByTags — фиксированный датасет, окно 12 ч, ORDER BY published_at DESC, чужие теги/вне окна отсутствуют');

  const prompt12 = buildSummaryPrompt(['Сбербанк'], libSber, 12);
  assert(prompt12.includes('Ты — инвестиционный аналитик PULSE'), 'промпт ядра');
  assert(prompt12.includes('Активы клиента: Сбербанк'), 'список активов');
  assert(prompt12.includes('Новости за последние 12 часов:'), 'окно 12 часов');
  const prompt72 = buildSummaryPrompt(['Сбербанк'], libSber, 72);
  assert(prompt72.includes('за последние 72 часов'), 'окно параметризовано (72)');
  assert(prompt72.includes('За последние 72 часов значимых событий по вашим активам не зафиксировано.'), 'fallback-строка параметризована');
  ok('A2: buildSummaryPrompt — hours=12 идентичен хардкоду ядра, окно параметризовано');

  // ── A3. Слоты: 3 корзины по первым 8 hex UUID % 3 ──────────────────────────
  const { defaultSlotsForUser } = require(path.join(DIST, 'advisor', 'summaries'));
  for (const mod of [0, 1, 2]) {
    const a = uuidWithMod(mod);
    const b = uuidWithMod(mod);
    assert.deepStrictEqual(defaultSlotsForUser(a), defaultSlotsForUser(b), `детерминизм mod=${mod}`);
    assert.deepStrictEqual(defaultSlotsForUser(a), [6 + mod, 17 + mod], `слоты [6+${mod},17+${mod}]`);
  }
  assert.deepStrictEqual(defaultSlotsForUser('not-a-hex-uuid'), [6, 17]);
  assert.deepStrictEqual(defaultSlotsForUser(ids.slot), [6, 17], 'seed slot-user → [6,17]');
  assert.deepStrictEqual(defaultSlotsForUser(ids.main), [7, 18], 'seed main-user → [7,18]');
  ok('A3: defaultSlotsForUser — детерминированные слоты [6+m,17+m], m = hex8(UUID) % 3, все 3 корзины');

  // ── A4/A5. ON DELETE CASCADE ───────────────────────────────────────────────
  await query(`INSERT INTO advisor_client_tags (client_id, tag_id, tag_name, tag_type) VALUES ($1,'sber','Сбербанк','company')`, [ids.cascadeClient]);
  await query(`INSERT INTO advisor_summaries (client_id, period_hours, summary, articles_count) VALUES ($1,12,'x',1)`, [ids.cascadeClient]);
  await query(`INSERT INTO advisor_tasks (client_id, advisor_user_id, title) VALUES ($1,$2,'задача')`, [ids.cascadeClient, ids.cascade]);
  await query(`INSERT INTO advisor_settings (user_id, summary_slots) VALUES ($1,'[8]')`, [ids.cascade]);

  await query(`DELETE FROM advisor_clients WHERE id = $1`, [ids.cascadeClient]);
  for (const [table, where] of [
    ['advisor_client_tags', `client_id = ${ids.cascadeClient}`],
    ['advisor_summaries', `client_id = ${ids.cascadeClient}`],
    ['advisor_tasks', `client_id = ${ids.cascadeClient}`],
  ]) {
    const r = await query(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}`);
    assert(Number(r.rows[0].cnt) === 0, `${table}: каскад не сработал`);
  }
  ok('A4: DELETE клиента каскадно сносит теги/саммари/задачи (ON DELETE CASCADE)');

  await query(`DELETE FROM users WHERE id = $1`, [ids.cascade]);
  const st = await query(`SELECT COUNT(*) AS cnt FROM advisor_settings WHERE user_id = $1`, [ids.cascade]);
  assert(Number(st.rows[0].cnt) === 0, 'advisor_settings не снесены каскадом');
  ok('A5: DELETE пользователя каскадно сносит advisor_settings (9.6)');

  // ── A6/A7. Downgrade-хук (ТЗ-182 9.5) ──────────────────────────────────────
  const advisorService = require(path.join(DIST, 'advisor', 'service'));
  const subscription = require(path.join(DIST, 'services', 'subscription'));

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    await subscription.applyDowngradeNow(ids.down, 'tz182down2');
  } finally {
    console.log = origLog;
  }
  const downClients = await query(
    `SELECT name, is_archived FROM advisor_clients WHERE advisor_user_id = $1 ORDER BY sort_order`, [ids.down]);
  assert.deepStrictEqual(downClients.rows.map((r) => [r.name, r.is_archived]), [
    ['Даун-1', 0], ['Даун-2', 0], ['Даун-3', 1], ['Даун-4', 1],
  ], 'архивируются поздние по sort_order сверх лимита 2');
  const downUser = await query(`SELECT subscription_plan FROM users WHERE id = $1`, [ids.down]);
  assert(downUser.rows[0].subscription_plan === 'tz182down2', 'план пользователя сменился');
  assert(logs.some((l) => l.includes('action=downgrade_archive') && l.includes(`user=${ids.down}`)), 'аудит downgrade_archive');
  assert(logs.some((l) => l.includes('Downgrade archive') && l.includes('archived=2')), 'лог сводки архивации');
  const restored = await advisorService.archiveExcessAdvisorClients(ids.down, 10);
  assert(restored === 0, 'archiveExcessAdvisorClients не восстанавливает');
  const still = await query(`SELECT COUNT(*) AS cnt FROM advisor_clients WHERE advisor_user_id = $1 AND is_archived = 1`, [ids.down]);
  assert(Number(still.rows[0].cnt) === 2, 'архивные клиенты остались архивными');
  ok('A6: downgrade 10→2 — поздние по sort_order архивированы, аудит есть, upgrade не восстанавливает, данные не удалены');

  const origArchive = advisorService.archiveExcessAdvisorClients;
  advisorService.archiveExcessAdvisorClients = async () => { throw new Error('TZ182 forced module failure'); };
  const errors = [];
  const origErr = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await subscription.applyDowngradeNow(ids.down2, 'tz182down2');
  } finally {
    console.error = origErr;
    advisorService.archiveExcessAdvisorClients = origArchive;
  }
  const down2User = await query(`SELECT subscription_plan FROM users WHERE id = $1`, [ids.down2]);
  assert(down2User.rows[0].subscription_plan === 'tz182down2', 'даунгрейд применился несмотря на падение модуля');
  const down2Active = await query(`SELECT COUNT(*) AS cnt FROM advisor_clients WHERE advisor_user_id = $1 AND is_archived = 0`, [ids.down2]);
  assert(Number(down2Active.rows[0].cnt) === 2, 'клиенты не тронуты при падении модуля');
  assert(errors.some((l) => l.includes('archiveExcessAdvisorClients failed')), 'ошибка модуля залогирована');
  ok('A7: исключение в модуле не роняет обработчик даунгрейда (try/catch, лог, биллинг завершён)');

  // ── A8. Partial unique idx_advisor_tasks_event (SQLite-часть, PG — фаза C) ──
  const idxClient = (
    await query(`INSERT INTO advisor_clients (advisor_user_id, name, sort_order) VALUES ($1,'Idx',1) RETURNING id`, [ids.down])
  ).rows[0].id;
  const eventId = uuid();
  await query(`INSERT INTO advisor_tasks (client_id, advisor_user_id, title, source_event_id) VALUES ($1,$2,'e1',$3)`, [idxClient, ids.down, eventId]);
  // query() логирует ошибку БД и не бросает — проверяем факт отклонения дубля.
  // Ошибка ожидаемая: приглушаем вывод, чтобы не маскировать настоящие
  // падения в будущих прогонах (нит ревью ТЗ-191, закрыт в ТЗ-192).
  {
    const origErr = console.error;
    console.error = () => {};
    try {
      await query(`INSERT INTO advisor_tasks (client_id, advisor_user_id, title, source_event_id) VALUES ($1,$2,'e2',$3)`, [idxClient, ids.down, eventId]);
    } finally {
      console.error = origErr;
    }
  }
  console.log('  (expected) дубль (client_id, source_event_id) отклонён БД — ошибка выше подавлена намеренно');
  const dupCount = await query(`SELECT COUNT(*) AS cnt FROM advisor_tasks WHERE client_id = $1 AND source_event_id = $2`, [idxClient, eventId]);
  assert(Number(dupCount.rows[0].cnt) === 1, 'повтор (client_id, source_event_id) отклонён partial unique');
  await query(`INSERT INTO advisor_tasks (client_id, advisor_user_id, title, source_event_id) VALUES ($1,$2,'null-1',NULL)`, [idxClient, ids.down]);
  await query(`INSERT INTO advisor_tasks (client_id, advisor_user_id, title, source_event_id) VALUES ($1,$2,'null-2',NULL)`, [idxClient, ids.down]);
  const idxRow = await query(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_advisor_tasks_event'`);
  assert(/WHERE.*source_event_id IS NOT NULL/i.test(idxRow.rows[0].sql), 'partial index с предикатом');
  ok('A8: idx_advisor_tasks_event — partial unique: дубль события отклонён, NULL source_event_id дублируется свободно');

  sqlite.saveDb();
  // Сид-процесс завершается раньше сервера — его exit-хуки sql.js затирали бы файл
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

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
      CRON_SECRET_KEY: SECRET,
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

async function phaseB(ids) {
  const tokens = {
    admin: jwt.sign({ userId: ids.admin, email: 'tz182-admin@test.ru' }, 'test'),
    main: jwt.sign({ userId: ids.main, email: 'tz182-main@test.ru' }, 'test'),
    other: jwt.sign({ userId: ids.other, email: 'tz182-other@test.ru' }, 'test'),
    slot: jwt.sign({ userId: ids.slot, email: 'tz182-slot@test.ru' }, 'test'),
    gate: jwt.sign({ userId: ids.gate, email: 'tz182-gate@test.ru' }, 'test'),
  };

  const logBuf = [];
  let server = await startServer(logBuf);
  try {
    // ── B1. Schema-diff (9.1) + регистрация кронов ──────────────────────────
    const CORE_DIFF_TABLES = ['users', 'portfolios', 'notification_subscriptions', 'user_news_reads', 'news', 'calendar_events'];
    const sqls = [
      ...CORE_DIFF_TABLES.map((t) => `SELECT name FROM pragma_table_info('${t}') ORDER BY name`),
      `SELECT name FROM pragma_table_info('subscription_plans') WHERE name='portfolio_limit'`,
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'advisor_%' ORDER BY name`,
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_advisor%' ORDER BY name`,
    ];
    const snap = dbExec(...sqls);
    const afterCols = Object.fromEntries(CORE_DIFF_TABLES.map((t, i) => [t, snap[i].map((r) => r.name)]));
    // Boot-миграции ядра (src/index.ts) выполняются только при старте сервера —
    // в in-process снапшоте их нет. Разрешаем только этот известный набор.
    const BOOT_ADDED = ['article_type', 'content_hash', 'is_political', 'needs_translation', 'sentiment_reasoning', 'sentiment_source', 'source_type', 'tag_impact', 'url_normalized'];
    for (const t of Object.keys(ids.coreBefore)) {
      const added = afterCols[t].filter((c) => !ids.coreBefore[t].includes(c));
      assert(added.every((c) => BOOT_ADDED.includes(c)), `ядро ${t}: новые колонки вне allowlist boot-миграций: ${added}`);
      assert(ids.coreBefore[t].every((c) => afterCols[t].includes(c)), `ядро ${t}: колонка исчезла после boot`);
    }
    const plCol = snap[CORE_DIFF_TABLES.length];
    assert(plCol.length === 1, 'subscription_plans.portfolio_limit добавлена');
    const advisorTables = snap[CORE_DIFF_TABLES.length + 1].map((r) => r.name);
    assert.deepStrictEqual(advisorTables, ['advisor_client_tags', 'advisor_clients', 'advisor_notes', 'advisor_settings', 'advisor_summaries', 'advisor_tasks'], 'ровно 6 таблиц advisor_*');
    const advisorIndexes = snap[CORE_DIFF_TABLES.length + 2];
    for (const idx of ['idx_advisor_clients_user', 'idx_advisor_client_tags_uniq', 'idx_advisor_tasks_event', 'idx_advisor_tasks_user', 'idx_advisor_tasks_remind']) {
      assert(advisorIndexes.some((r) => r.name === idx), `индекс ${idx} создан`);
    }
    assert(/WHERE.*source_event_id IS NOT NULL/i.test(advisorIndexes.find((r) => r.name === 'idx_advisor_tasks_event').sql), 'partial index с предикатом (server boot)');
    const log1 = logBuf.join('');
    assert(log1.includes('Advisor summaries precompute scheduled hourly at :07 Europe/Moscow'), 'cron advisorPrecompute 7 * * * * Europe/Moscow');
    assert(log1.includes('Advisor task reminders scheduled every 5 minutes Europe/Moscow'), 'cron advisorTaskReminders */5 Europe/Moscow');
    assert(log1.includes('Advisor weekly scheduled Sunday at 13:00 Europe/Moscow'), 'cron advisorWeekly вс 13:00 МСК (зеркало ядра)');
    ok('B1: schema-diff — у ядра нет новых ALTER, новое только advisor_* + portfolio_limit; кроны зарегистрированы');

    // ── B2. Регрессия ядра (9.1) ────────────────────────────────────────────
    let r = await api('GET', '/api/calendar');
    assert(r.status === 200 && r.json && typeof r.json === 'object', `публичный /api/calendar → 200, got ${r.status} ${r.text.slice(0, 120)}`);
    const calendarShape = Object.keys(r.json).sort();
    r = await api('POST', '/api/user/tags', { token: tokens.main, body: { tagId: 'gazp', tagName: 'Газпром', tagType: 'company' } });
    assert(r.status === 201 || r.status === 200, `core POST tag → 201/200, got ${r.status} ${r.text.slice(0, 120)}`);
    r = await api('GET', '/api/user/tags', { token: tokens.main });
    assert(r.status === 200 && JSON.stringify(r.json).includes('gazp'), 'core GET tags содержит gazp');
    r = await api('DELETE', '/api/user/tags/gazp', { token: tokens.main });
    assert(r.status === 200 || r.status === 204, `core DELETE tag → 200/204, got ${r.status}`);
    r = await api('GET', '/api/news?limit=5', { token: tokens.main });
    assert(r.status === 200, `лента новостей → 200, got ${r.status}`);
    r = await api('GET', '/api/user/summary?hours=12', { token: tokens.main });
    assert(r.status === 200 && r.json.articles_count === 4, `ядро summary через библиотеку: articles_count=4, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(String(r.json.summary).includes('LLM недоступен'), 'fallback ядра без LLM-ключа');
    r = await api('GET', '/api/calendar');
    assert.deepStrictEqual(Object.keys(r.json).sort(), calendarShape, 'контракт /api/calendar до/после advisor-вызовов без изменений');
    ok('B2: регрессия ядра — теги CRUD, лента, summary (articles_count=4), публичный календарь стабилен');

    // ── B3. Тарифный гейт (9.4) ─────────────────────────────────────────────
    r = await api('GET', '/api/advisor/clients', { token: tokens.admin });
    assert(r.status === 403, `админ без энтитлмента → 403, got ${r.status} ${r.text.slice(0, 100)}`);
    const ghostToken = jwt.sign({ userId: uuid(), email: 'ghost@test.ru' }, 'test');
    r = await api('GET', '/api/advisor/clients', { token: ghostToken });
    assert(r.status === 403 || r.status === 401, `JWT без записи пользователя → 401/403, got ${r.status}`);
    r = await api('GET', '/api/advisor/clients');
    assert(r.status === 401, `без токена → 401, got ${r.status}`);
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.status === 200, `entitled → 200, got ${r.status}`);
    ok('B3: гейт — админ без multi_portfolio → 403, аноним → 401, entitled → 200 (API-гейт независим от UI)');

    // ── B4. CRUD + meta (ТЗ-191 Задача 4) ───────────────────────────────────
    r = await api('POST', '/api/advisor/clients', { token: tokens.main, body: { name: 'Ольга Петрова' } });
    assert(r.status === 201 && r.json.client.id, `create → 201, got ${r.status} ${r.text}`);
    const mc1 = r.json.client.id;
    assert(r.json.client.sort_order === 1 && r.json.client.active_tags === 0, 'sort_order=1, active_tags=0');
    r = await api('POST', '/api/advisor/clients', { token: tokens.main, body: { name: 'Иван Сидоров' } });
    const mc2 = r.json.client.id;
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.status === 200 && r.json.clients.length === 2, 'list: 2 клиента');
    const meta = r.json.meta;
    assert(meta && meta.portfolio_limit === 20 && meta.active_count === 2, `meta {portfolio_limit:20, active_count:2}, got ${JSON.stringify(meta)}`);
    const c1 = r.json.clients.find((c) => c.id === mc1);
    // ТЗ-193: скалярный notes убран из списка — вместо него notes_count;
    // правка заметки через PATCH clients убрана (лента /clients/:id/notes)
    for (const k of ['id', 'name', 'notes_count', 'is_archived', 'sort_order', 'created_at', 'active_tags', 'last_alert_neg_at', 'last_alert_pos_at']) {
      assert(k in c1, `клиент без поля ${k}`);
    }
    assert(!('notes' in c1), 'скалярного notes в списке нет (ТЗ-193)');
    assert(c1.notes_count === 0, 'notes_count свежего клиента = 0');
    assert(c1.last_alert_neg_at === null && c1.last_alert_pos_at === null, 'alert-line поля null у свежего клиента');
    r = await api('PATCH', `/api/advisor/clients/${mc1}`, { token: tokens.main, body: { name: 'Ольга П.', notes: 'игнорируемое legacy-поле' } });
    assert(r.status === 200 && r.json.client.name === 'Ольга П.', 'patch rename → 200 (поле notes из схемы удалено)');
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.json.clients.find((c) => c.id === mc1).notes_count === 0, 'PATCH с notes ничего не создаёт (ТЗ-193)');
    ok('B4: CRUD create/list/patch + meta {portfolio_limit, active_count} + alert-line поля в каждом клиенте');

    // ── B5. Владение (9.3) ──────────────────────────────────────────────────
    r = await api('GET', `/api/advisor/clients/${mc1}`, { token: tokens.other });
    assert(r.status === 403 && r.json.error === 'advisor_client_forbidden', `чужой GET detail → 403 advisor_client_forbidden, got ${r.status} ${r.text.slice(0, 100)}`);
    r = await api('PATCH', `/api/advisor/clients/${mc1}`, { token: tokens.other, body: { name: 'Хак' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_forbidden', 'чужой PATCH → 403 advisor_client_forbidden');
    r = await api('GET', `/api/advisor/clients/${mc1}/news`, { token: tokens.other });
    assert(r.status === 403, 'чужая лента новостей → 403');
    r = await api('POST', '/api/advisor/summaries/refresh', { token: tokens.other, body: { client_id: mc1 } });
    assert(r.status === 403, 'чужой refresh → 403');
    ok('B5: ownership — чужой client_id на всех эндпоинтах → 403 advisor_client_forbidden');

    // ── B6. Архивный клиент (9.3) ───────────────────────────────────────────
    r = await api('PATCH', `/api/advisor/clients/${mc2}`, { token: tokens.main, body: { is_archived: true } });
    assert(r.status === 200 && r.json.client.is_archived === true, 'archive → 200');
    r = await api('PATCH', `/api/advisor/clients/${mc2}`, { token: tokens.main, body: { name: 'X' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_archived', `write в архивный → 403 advisor_client_archived, got ${r.status} ${r.text.slice(0, 100)}`);
    r = await api('POST', `/api/advisor/clients/${mc2}/tags`, { token: tokens.main, body: { tag_name: 'Сбербанк' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_archived', 'тег в архивный → 403');
    r = await api('GET', `/api/advisor/clients/${mc2}`, { token: tokens.main });
    assert(r.status === 200, 'архивный читается (GET detail)');
    r = await api('PATCH', `/api/advisor/clients/${mc2}`, { token: tokens.main, body: { is_archived: false } });
    assert(r.status === 200 && r.json.client.is_archived === false, 'restore → 200');
    ok('B6: архивный — write → 403 advisor_client_archived, read/restore разрешены');

    // ── B7. Лимит портфелей (9.3) ───────────────────────────────────────────
    r = await api('GET', '/api/advisor/clients', { token: tokens.gate });
    assert(r.status === 200 && r.json.meta.portfolio_limit === 0 && r.json.clients.length === 0, 'gate-план: list 200, meta.portfolio_limit=0');
    r = await api('POST', '/api/advisor/clients', { token: tokens.gate, body: { name: 'Гейт' } });
    assert(r.status === 403 && r.json.error === 'advisor_limit_reached', `portfolio_limit=0 → 403 advisor_limit_reached, got ${r.status} ${r.text.slice(0, 100)}`);
    r = await api('PATCH', '/api/admin/plans/tz182gate', { token: tokens.admin, body: { portfolio_limit: 5 } });
    assert(r.status === 200 && r.json.plan.portfolio_limit === 5, `admin PATCH план → portfolio_limit=5, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('GET', '/api/admin/plans', { token: tokens.admin });
    const plansList = r.json.plans ?? r.json;
    const gatePlan = Array.isArray(plansList) ? plansList.find((p) => p.id === 'tz182gate') : null;
    assert(gatePlan && Number(gatePlan.portfolio_limit) === 5, 'admin GET plans отдаёт portfolio_limit');
    r = await api('POST', '/api/advisor/clients', { token: tokens.gate, body: { name: 'Гейт' } });
    assert(r.status === 201, `после поднятия лимита create → 201, got ${r.status} ${r.text.slice(0, 100)}`);
    ok('B7: тарифный гейт — limit 0 → 403 advisor_limit_reached; admin-план принимает/отдаёт portfolio_limit; после 5 → 201');

    // ── B8. Теги клиента (реестр + tag_limit) ───────────────────────────────
    r = await api('POST', `/api/advisor/clients/${mc1}/tags`, { token: tokens.main, body: { tag_name: 'Сбербанк' } });
    assert(r.status === 201 && r.json.tag.tag_id === 'sber' && r.json.alreadyAdded === false, `tag add → 201 с tag_id=sber, got ${r.status} ${r.text.slice(0, 150)}`);
    const tagRowId = r.json.tag.id;
    r = await api('POST', `/api/advisor/clients/${mc1}/tags`, { token: tokens.main, body: { tag_name: 'Сбербанк' } });
    assert(r.status === 200 && r.json.alreadyAdded === true && r.json.tag.id === tagRowId, 'повторный тот же тег → 200 alreadyAdded (идемпотентно)');
    r = await api('GET', `/api/advisor/clients/${mc1}/tags`, { token: tokens.main });
    assert(r.status === 200 && r.json.tags.length === 1 && r.json.tags[0].tag_name === 'Сбербанк', 'GET tags');
    const regRows = dbExec(`SELECT tag_id FROM user_defined_tags WHERE tag_id = 'sber'`)[0];
    assert(regRows.length === 1, 'тег резолвится в глобальный реестр user_defined_tags');
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.json.clients.find((c) => c.id === mc1).active_tags === 1, 'active_tags=1 в списке');
    // ТЗ-192: список отдаёт живые теги (не tags_snapshot саммари) — чипы карточки
    // обновляются сразу после POST/DELETE, без регенерации саммари
    const snapBefore = Number(dbExec('SELECT COUNT(*) AS cnt FROM advisor_summaries')[0][0].cnt);
    let listClient = r.json.clients.find((c) => c.id === mc1);
    assert(Array.isArray(listClient.tags) && listClient.tags.length === 1 && listClient.tags[0].name === 'Сбербанк',
      `GET / отдаёт живые tags: ${JSON.stringify(listClient.tags)}`);
    r = await api('DELETE', `/api/advisor/clients/${mc1}/tags/${tagRowId}`, { token: tokens.main });
    assert(r.status === 200 && r.json.deleted === true, 'DELETE tag → 200');
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    listClient = r.json.clients.find((c) => c.id === mc1);
    assert(listClient.active_tags === 0 && Array.isArray(listClient.tags) && listClient.tags.length === 0,
      `после DELETE теги в списке пустые сразу: ${JSON.stringify(listClient.tags)}`);
    const snapAfter = Number(dbExec('SELECT COUNT(*) AS cnt FROM advisor_summaries')[0][0].cnt);
    assert(snapAfter === snapBefore, `advisor_summaries не тронута (${snapBefore} → ${snapAfter})`);
    r = await api('DELETE', `/api/advisor/clients/${mc1}/tags/${tagRowId}`, { token: tokens.main });
    assert(r.status === 404 && r.json.error === 'advisor_tag_not_found', 'повторный DELETE → 404');
    // tag_limit тарифа: временный план с tag_limit=1, other на него, свой клиент
    r = await api('POST', '/api/admin/plans', {
      token: tokens.admin,
      body: { id: 'tz182tag1', name: 'TZ182 Tag1', price: 0, tag_limit: 1, portfolio_limit: 5, plan_level: 1, display_order: 92 },
    });
    assert(r.status === 201, `создание плана с tag_limit=1 → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('POST', `/api/admin/users/${ids.other}/change-plan`, { token: tokens.admin, body: { planId: 'tz182tag1' } });
    assert(r.status === 200, `change-plan other → tz182tag1: 200, got ${r.status} ${r.text.slice(0, 150)}`);
    r = await api('POST', `/api/advisor/clients/${mc1}/tags`, { token: tokens.other, body: { tag_name: 'Газпром' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_forbidden', 'чужой клиент + tags → 403 (владение раньше лимита)');
    const otherClient = (await api('POST', '/api/advisor/clients', { token: tokens.other, body: { name: 'Клиент Other' } })).json.client.id;
    r = await api('POST', `/api/advisor/clients/${otherClient}/tags`, { token: tokens.other, body: { tag_name: 'Газпром' } });
    assert(r.status === 201, 'первый тег other → 201');
    r = await api('POST', `/api/advisor/clients/${otherClient}/tags`, { token: tokens.other, body: { tag_name: 'Лукойл' } });
    assert(r.status === 403 && r.json.error === 'tag_limit_reached', `второй тег сверх tag_limit=1 → 403 tag_limit_reached, got ${r.status} ${r.text.slice(0, 100)}`);
    r = await api('POST', `/api/admin/users/${ids.other}/change-plan`, { token: tokens.admin, body: { planId: 'premium' } });
    assert(r.status === 200, 'возврат other на premium');
    ok('B8: теги — реестр ядра, идемпотентность UNIQUE(client_id,tag_name), DELETE/404, tag_limit_reached; ТЗ-192: живые tags в списке без регенерации саммари');

    // ── B9. Эквивалентность библиотеки через HTTP (9.2) ─────────────────────
    await api('POST', `/api/advisor/clients/${mc1}/tags`, { token: tokens.main, body: { tag_name: 'Сбербанк' } });
    r = await api('GET', `/api/advisor/clients/${mc1}/news?limit=30`, { token: tokens.main });
    // Лента клиента намеренно использует окно 90 дней (как основная лента ядра,
    // см. комментарий в clients.ts), а не окно 12 ч саммари — sber-old (48 ч) входит.
    const expectedFeedSlugs = [...ids.expectedSberSlugs, 'tz182-sber-old'];
    assert(r.status === 200 && r.json.articles.length === 5, `лента клиента = 5 новостей (окно 90 дн.), got ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    assert.deepStrictEqual(r.json.articles.map((a) => a.slug), expectedFeedSlugs, 'HTTP-лента модуля === selectNewsByTags(tagIds, 2160) на тех же тегах (slug, порядок DESC)');
    for (const a of r.json.articles) {
      for (const k of ['id', 'slug', 'title_ru', 'summary_ru', 'published_at', 'matched_tags', 'sentiment']) {
        assert(k in a, `статья без поля ${k}`);
      }
    }
    r = await api('GET', `/api/advisor/clients/${mc2}/news`, { token: tokens.main });
    assert(r.status === 200 && r.json.articles.length === 0 && r.json.hasMore === false, 'клиент без тегов → пустая лента без LLM');
    ok('B9: эквивалентность — /clients/:id/news отдаёт ровно выдачу selectNewsByTags с окном ленты 90 дн. (те же slug/порядок), без LLM');

    // ── B10. Summaries read-only + schedule (приёмка 5/9) ───────────────────
    const t0 = Date.now();
    r = await api('GET', '/api/advisor/summaries', { token: tokens.main });
    const elapsed = Date.now() - t0;
    assert(r.status === 200 && Array.isArray(r.json.clients), `GET summaries → 200, got ${r.status}`);
    assert(r.json.clients.length === 2, '2 не-архивных клиента');
    const s1 = r.json.clients.find((c) => c.client_id === mc1);
    assert(s1.articles_count === 0 && (s1.summary === null || typeof s1.summary === 'string'), 'read-only: articles_count=0, summary null до первой генерации');
    assert(r.json.schedule && Array.isArray(r.json.schedule.slots) && r.json.schedule.last_run_at === null, 'schedule.slots + last_run_at');
    assert(r.json.schedule.next_run_at && !Number.isNaN(new Date(r.json.schedule.next_run_at).getTime()), 'next_run_at ISO');
    assert(elapsed < 300, `read-only < 300 мс, got ${elapsed}ms`);
    r = await api('PATCH', '/api/advisor/summaries/schedule', { token: tokens.main, body: { slots: [7, 20] } });
    assert(r.status === 200 && JSON.stringify(r.json.slots) === '[7,20]', `PATCH schedule [7,20] → 200, got ${r.status} ${r.text.slice(0, 120)}`);
    r = await api('GET', '/api/advisor/summaries', { token: tokens.main });
    assert(JSON.stringify(r.json.schedule.slots) === '[7,20]', 'GET summaries возвращает слоты [7,20]');
    r = await api('PATCH', '/api/advisor/summaries/schedule', { token: tokens.main, body: { slots: [3] } });
    assert(r.status === 400 && r.json.error === 'invalid_slots', `slots [3] вне ALLOWED → 400 invalid_slots, got ${r.status}`);
    r = await api('PATCH', '/api/advisor/summaries/schedule', { token: tokens.main, body: { slots: [8, 8] } });
    assert(r.status === 400 && r.json.error === 'invalid_slots', 'slots [8,8] дубль → 400');
    ok('B10: summaries read-only (<300 мс, schedule/last_run_at/next_run_at), PATCH schedule 200/400');

    // ── B11. Refresh + rate limit (9.9) ─────────────────────────────────────
    r = await api('POST', '/api/advisor/summaries/refresh', { token: tokens.main, body: { client_id: mc2 } });
    assert(r.status === 200 && r.json.skipped_empty === true && r.json.generated === false, `refresh пустого → 200 skipped_empty, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('POST', '/api/advisor/summaries/refresh', { token: tokens.main, body: { client_id: mc2 } });
    assert(r.status === 429 && r.json.error === 'rate_limit' && Number(r.json.retry_after_sec) > 0, `повтор <5 мин → 429 rate_limit, got ${r.status} ${r.text.slice(0, 150)}`);
    assert(Number(r.headers.get('retry-after')) > 0, 'Retry-After заголовок');
    r = await api('POST', '/api/advisor/summaries/refresh', { token: tokens.main, body: { client_id: mc1 } });
    assert(r.status !== 429, `refresh другого клиента не ограничен чужим кулдауном, got ${r.status}`);
    r = await api('GET', '/api/advisor/summaries', { token: tokens.main });
    assert(String(r.json.clients.find((c) => c.client_id === mc2).summary).includes('не зафиксировано'), 'шаблон пустого саммари сохранён UPSERT');
    ok('B11: refresh — 200 skipped_empty без LLM, повтор в окне 5 мин → 429 + Retry-After, кулдаун на клиента');

    // ── B12. Слоты крона-диспетчера (9.8) ───────────────────────────────────
    const slotSummary = await api('GET', '/api/advisor/summaries', { token: tokens.slot });
    assert.deepStrictEqual(slotSummary.json.schedule.slots, [6, 17], 'слоты NULL → дефолт-хэш [6,17]');
    const trig = async (hour, secret = SECRET) => {
      const res = await fetch(`${BASE}/trigger/advisor-precompute?hour=${hour}&secret=${secret}`);
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    let t = await trig(6);
    assert(t.json && t.json.users === 1 && t.json.clients === 1 && t.json.skippedEmpty === 1, `триггер 06MSK (хэш-слот) → users=1, got ${JSON.stringify(t.json)}`);
    t = await trig(10);
    assert(t.json && t.json.users === 0 && t.json.clients === 0, `триггер 10MSK (вне слотов) → users=0, got ${JSON.stringify(t.json)}`);
    t = await trig(99);
    assert(t.status === 400, `hour=99 → 400, got ${t.status}`);
    t = await trig(6, 'wrong-secret');
    assert(t.status === 401, 'триггер с неверным секретом → 401');
    // main со слотом [7,20] (PATCH в B10) срабатывает только в 20:00
    t = await trig(20);
    assert(t.json && t.json.users === 1 && t.json.clients === 2, `main [7,20]: триггер 20MSK → users=1 clients=2, got ${JSON.stringify(t.json)}`);
    t = await trig(8);
    assert(t.json && t.json.users === 0, `триггер 08MSK (вне слотов) → users=0, got ${JSON.stringify(t.json)}`);
    // пользователь со слотом [20] — только в 20:00
    r = await api('PATCH', '/api/advisor/summaries/schedule', { token: tokens.slot, body: { slots: [20] } });
    assert(r.status === 200, 'slot-user → слот [20]');
    t = await trig(8);
    assert(t.json && t.json.users === 0, `слот [20]: триггер 08MSK → users=0, got ${JSON.stringify(t.json)}`);
    // 20MSK: оба пользователя слота (main [7,20] + slot [20]), 3 клиента
    t = await trig(20);
    assert(t.json && t.json.users === 2 && t.json.clients === 3, `20MSK: users=2 clients=3, got ${JSON.stringify(t.json)}`);
    assert(logBuf.join('').includes('[AdvisorSummaries] slot=20MSK'), 'лог slot=20MSK users=… clients=…');
    ok('B12: слоты — hash-слот в выборке/вне её users=0, summary_slots=[20] только 20MSK, лог slot=HHMSK, секрет');

    // ── B13. События (9.10) ─────────────────────────────────────────────────
    r = await api('GET', '/api/advisor/events?days=14', { token: tokens.main });
    assert(r.status === 200 && Array.isArray(r.json.groups), `events → 200, got ${r.status} ${r.text.slice(0, 120)}`);
    const group = r.json.groups.find((g) => g.client_id === mc1);
    assert(group, 'группа клиента MC1 есть (тег sber)');
    // NB: boot мигрирует calendar_events → raw и пересобирает канон с
    // детерминированными hash-id — идентифицируем события по заголовку.
    assert(group.events.some((e) => e.title === 'Отчётность Сбера'), 'событие по тегу клиента в группе');
    assert(!group.events.some((e) => e.title === 'Собрание Газпрома'), 'событие вне тегов группы не возвращается');
    const allTitles = r.json.groups.flatMap((g) => g.events.map((e) => e.title));
    assert(!allTitles.includes('Событие без матчинга'), 'событие без matched_via/tag_ids не возвращается НИКОГДА');
    r = await api('GET', '/api/advisor/clients', { token: tokens.gate });
    const gateClient = r.json.clients.find((c) => c.name === 'Гейт');
    r = await api('POST', `/api/advisor/clients/${gateClient.id}/tags`, { token: tokens.gate, body: { tag_name: 'Газпром' } });
    assert(r.status === 201, 'тег Газпром клиенту Гейт → 201');
    r = await api('GET', '/api/advisor/events?days=45', { token: tokens.gate });
    assert(r.status === 200 && r.json.groups.length === 1, `группы только по своим клиентам, got ${JSON.stringify(r.json.groups).slice(0, 200)}`);
    assert(r.json.groups[0].events.some((e) => e.title === 'Собрание Газпрома'), 'своё событие по тегу на месте');
    assert(!JSON.stringify(r.json.groups).includes('Отчётность Сбера'), 'чужие события не протекают между пользователями');
    ok('B13: события — только в пределах тегов группы, без матчинга не возвращаются, нет протечек между пользователями');

    // ── B14. Kill-switch drill (9.11, учения через фичефлаг) ────────────────
    r = await api('PUT', '/api/admin/features/multi_portfolio', { token: tokens.admin, body: { is_active: false } });
    assert(r.status === 200 && r.json.feature.is_active === false, `фичефлаг OFF → 200, got ${r.status} ${r.text.slice(0, 120)}`);
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.status === 403, `роуты модуля недоступны (entitled → 403), got ${r.status}`);
    r = await api('GET', '/health');
    assert(r.status === 200, 'ядро: /health ок');
    r = await api('GET', '/api/calendar');
    assert(r.status === 200, 'ядро: публичный календарь ок');
    r = await api('GET', '/api/user/summary?hours=12', { token: tokens.main });
    assert(r.status === 200, 'ядро: summary ок при выключенном модуле');
    r = await api('PUT', '/api/admin/features/multi_portfolio', { token: tokens.admin, body: { is_active: true } });
    assert(r.status === 200 && r.json.feature.is_active === true, 'фичефлаг ON → 200');
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.status === 200 && r.json.clients.length === 2, 'роуты модуля вернулись');
    ok('B14: kill-switch drill — multi_portfolio OFF: /api/advisor/* → 403, ядро (health/calendar/summary) работает; ON — модуль вернулся');

    // ── B15. Повторный boot: идемпотентность миграций (9.7) ─────────────────
    const beforeClients = (await api('GET', '/api/advisor/clients', { token: tokens.main })).json;
    server.kill('SIGTERM');
    await new Promise((r2) => setTimeout(r2, 1200));
    const logBuf2 = [];
    server = await startServer(logBuf2);
    r = await api('GET', '/api/advisor/clients', { token: tokens.main });
    assert(r.status === 200, 'после повторного boot сервер здоров');
    assert.deepStrictEqual(r.json.clients.map((c) => c.id), beforeClients.clients.map((c) => c.id), 'клиенты не продублированы');
    assert.deepStrictEqual(r.json.meta, beforeClients.meta, 'meta стабильна');
    const warnAdvisor = logBuf2.join('').split('\n').filter((l) => l.includes('Migration warning') && /advisor|portfolio_limit|multi_portfolio/i.test(l));
    assert(warnAdvisor.length === 0, `advisor-миграции второго boot чисты: ${warnAdvisor.join('; ')}`);
    r = await api('GET', '/api/advisor/summaries', { token: tokens.main });
    assert(String(r.json.clients.find((c) => c.client_id === mc2).summary).includes('не зафиксировано'), 'саммари пережили перезапуск');
    ok('B15: два boot подряд — без ошибок и дублей, advisor-данные целы (9.7, SQLite-часть)');

    server.kill('SIGTERM');
    await new Promise((r2) => setTimeout(r2, 800));
    server = null;
  } finally {
    if (server) server.kill('SIGTERM');
  }
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
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'advisor_%'`);
    const names = tables.rows.map((r) => r.table_name).sort();
    assert.deepStrictEqual(names, ['advisor_client_tags', 'advisor_clients', 'advisor_notes', 'advisor_settings', 'advisor_summaries', 'advisor_tasks'], '6 таблиц advisor_*');
    ok('C1: PG — таблицы advisor_* на месте');

    const cols = await client.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name LIKE 'advisor_%' AND (column_name IN ('advisor_user_id','user_id'))`);
    const uuidCols = cols.rows.filter((r) => r.data_type === 'uuid').map((r) => `${r.table_name}.${r.column_name}`).sort();
    assert(uuidCols.includes('advisor_clients.advisor_user_id'), 'advisor_clients.advisor_user_id — uuid');
    assert(uuidCols.includes('advisor_settings.user_id'), 'advisor_settings.user_id — uuid');
    assert(uuidCols.includes('advisor_tasks.advisor_user_id'), 'advisor_tasks.advisor_user_id — uuid');
    ok('C2: PG — UUID-ссылки на users (advisor_clients/advisor_tasks/advisor_settings)');

    const fks = await client.query(
      `SELECT tc.table_name, ccu.table_name AS ref_table, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
       WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY' AND tc.table_name LIKE 'advisor_%'`);
    for (const pair of [['advisor_client_tags', 'advisor_clients'], ['advisor_notes', 'advisor_clients'], ['advisor_summaries', 'advisor_clients'], ['advisor_tasks', 'advisor_clients'], ['advisor_clients', 'users'], ['advisor_tasks', 'users'], ['advisor_settings', 'users']]) {
      const fk = fks.rows.find((r) => r.table_name === pair[0] && r.ref_table === pair[1]);
      assert(fk && fk.delete_rule === 'CASCADE', `FK ${pair[0]}→${pair[1]} ON DELETE CASCADE`);
    }
    ok('C3: PG — все FK advisor_* ON DELETE CASCADE (клиент→теги/саммари/задачи, user→всё)');

    const idx = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_advisor%'`);
    const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
    assert(/WHERE \(source_event_id IS NOT NULL\)/.test(byName.idx_advisor_tasks_event || ''), 'частичный unique idx_advisor_tasks_event');
    assert(/WHERE \(\(reminded_at IS NULL\) AND \(is_done = false\)\)/i.test(byName.idx_advisor_tasks_remind || ''), 'частичный idx_advisor_tasks_remind');
    assert(/WHERE \(is_done = false\)/i.test(byName.idx_advisor_tasks_user || ''), 'частичный idx_advisor_tasks_user');
    assert(/UNIQUE/.test(byName.idx_advisor_client_tags_uniq || ''), 'unique idx_advisor_client_tags_uniq');
    ok('C4: PG — частичные индексы (idx_advisor_tasks_event/remind/user) с предикатами');
  } finally {
    await client.end();
  }
}

(async () => {
  try {
    const ids = await seedAndPhaseA();
    await phaseB(ids);
    await phaseC();
    console.log(`\nOK ${passed}: все проверки ТЗ-182 Задача 9 пройдены`);
    process.exit(0);
  } catch (e) {
    console.error('\nTZ182 FAIL:', e);
    process.exit(1);
  }
})();
