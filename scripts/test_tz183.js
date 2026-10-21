// ТЗ-183 v7 Задача 10 (по ТЗ-191 Задача 2) — backend-чеклист advisor:
// TG-алерты, дайджест/новости, weekly, задачи/напоминания, ICS, TG-привязка.
// Прогон: npm run build && node scripts/test_tz183.js
//
// Фазы:
//   A. In-process (SQLite/sql.js, мок TG/email через подмену exports
//      dist/services/telegram.js и dist/services/email.js ДО require модулей):
//      алерты 10.1–10.4 (пороги 60/70 и ≥5, cooldown 12 ч, штамп ПОСЛЕ
//      отправки, notify_prefs), дайджест/новости 10.2–10.3 (чанкование ≤4000,
//      dedup, all-empty skip), weekly 10.5/10.8, напоминания 10.9
//      (идемпотентность по reminded_at, is_done-фильтр, per-channel failed),
//      TG-токен привязки (HMAC userId:timestamp:signature, TTL 15 мин).
//   B. HTTP: dist/index.js дочерним процессом — задачи 10.5, заметки 10.6,
//      reminder-эндпоинт 10.9 (400-коды), ICS 10.10, deep-link TG, prefs,
//      ownership (403), лог регистрации кронов (вс 13:00 МСК, */5).
//   C. PG-smoke (TEST_PG_URL): notification_subscriptions/users без новых
//      колонок, advisor-таблицы/индексы. Без env — SKIP.
process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/tz183-smoke/pulse.db';
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
const PORT = 3912;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = '/tmp/tz183-smoke';
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
const isoHoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const isoHoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

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

// ─── Фаза A: seed + in-process проверки (мок TG/email) ──────────────────────
async function seedAndPhaseA() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  query = sqlite.query;

  await query(`ALTER TABLE news ADD COLUMN slug TEXT`);
  await query(`ALTER TABLE news ADD COLUMN source_count INTEGER DEFAULT 1`);
  await query(`ALTER TABLE news ADD COLUMN all_sources TEXT`);
  await query(`CREATE TABLE IF NOT EXISTS news_tag_links (
    id TEXT PRIMARY KEY, news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
    tag_id VARCHAR(50) NOT NULL, impact_score INTEGER, impact_reasoning TEXT,
    link_source VARCHAR(20) NOT NULL DEFAULT 'keyword', link_version INTEGER DEFAULT 1,
    linked_at TEXT DEFAULT (datetime('now')), UNIQUE(news_id, tag_id, link_source))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_links_news_id ON news_tag_links(news_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_links_tag_id ON news_tag_links(tag_id)`);
  await query(`CREATE TABLE IF NOT EXISTS user_defined_tags (
    tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL,
    tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT DEFAULT '{}',
    enriched_data TEXT, created_by VARCHAR(100), created_at TEXT DEFAULT (datetime('now')))`);
  // advisor_* — те же CREATE TABLE, что и в boot-миграциях (см. test_tz182)
  await query(`CREATE TABLE IF NOT EXISTS advisor_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, advisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, notes TEXT, is_archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, last_alert_neg_at TEXT, last_alert_pos_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_client_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE, tag_id TEXT, tag_name TEXT NOT NULL, tag_type TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_client_tags_uniq ON advisor_client_tags(client_id, tag_name)`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_summaries (client_id INTEGER NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE, period_hours INTEGER NOT NULL, summary TEXT NOT NULL, articles_count INTEGER NOT NULL, sentiment_mix TEXT, tags_snapshot TEXT, generated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (client_id, period_hours))`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES advisor_clients(id) ON DELETE CASCADE, advisor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, due_date TEXT, source_event_id TEXT, is_done INTEGER NOT NULL DEFAULT 0, remind_at TEXT, remind_channels TEXT, reminded_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_tasks_event ON advisor_tasks(client_id, source_event_id) WHERE source_event_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_advisor_tasks_user ON advisor_tasks(advisor_user_id) WHERE is_done = 0`);
  await query(`CREATE INDEX IF NOT EXISTS idx_advisor_tasks_remind ON advisor_tasks(remind_at) WHERE reminded_at IS NULL AND is_done = 0`);
  await query(`CREATE TABLE IF NOT EXISTS advisor_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, summary_slots TEXT, telegram_chat_id TEXT, notify_prefs TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  // Энтитлмент в реестре фич (на проде ставит boot-миграция; in-process — seed)
  await query(`INSERT OR IGNORE INTO features_registry (id, label, description, is_active) VALUES ('multi_portfolio','Клиентские портфели','ТЗ-182',1)`);

  const ids = {};
  const insertUser = async (id, email, plan = 'pro') => {
    await query(
      `INSERT INTO users (id, email, username, password_hash, is_admin, is_verified,
                          subscription_plan, subscription_active, subscription_expires_at)
       VALUES ($1,$2,$3,'x',0,1,$4,1,$5)`,
      [id, email, email.split('@')[0], plan, isoHoursAhead(24 * 30)],
    );
  };
  ids.a = uuid();  // основной советник (chat 111001)
  ids.b = uuid();  // chat 222002, advisor_alert_neg=false (prefs)
  ids.c = uuid();  // БЕЗ chat (молчит, telegram_not_linked)
  ids.d = uuid();  // chat 444004 — TG-мок возвращает false (failed-отправка)
  ids.e = uuid();  // БЕЗ chat, email-подписка weekly_report (weekly по email)
  ids.w = uuid();  // weekly: 3 клиента без тегов (3 блока)
  ids.f = uuid();  // weekly выключен в prefs
  ids.g = uuid();  // все клиенты пустые — дайджест не уходит
  for (const k of Object.keys(ids)) {
    await insertUser(ids[k], `tz183-${k}@test.ru`, k === 'b' ? 'premium' : 'pro');
  }

  // Мок TG/email ПЕРЕД require модулей advisor (свойство читается на вызове,
  // поэтому подмена exports работает и для уже скомпилированных require-цепочек)
  const tgLog = [];
  const emailLog = [];
  const telegramService = require(path.join(DIST, 'services', 'telegram'));
  telegramService.sendTelegramMessage = async (chatId, text) => {
    tgLog.push({ chatId, text, at: Date.now() });
    return chatId !== '444004'; // чат uD — симулирует 403/blocked от TG API
  };
  telegramService.sendTelegramPhoto = async () => true;
  const emailService = require(path.join(DIST, 'services', 'email'));
  emailService.sendEmail = async (to, subject, html) => {
    emailLog.push({ to, subject, html });
    return true;
  };

  const insertClient = async (userId, name, sort = 1) => (
    await query(`INSERT INTO advisor_clients (advisor_user_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, [userId, name, sort])
  ).rows[0].id;
  const insertSummary = async (clientId, articles, mix, text = 'Саммари клиента') => {
    await query(
      `INSERT INTO advisor_summaries (client_id, period_hours, summary, articles_count, sentiment_mix, generated_at)
       VALUES ($1,12,$2,$3,$4,$5)`,
      [clientId, text, articles, JSON.stringify(mix), isoHoursAgo(1)],
    );
  };

  ids.al1 = await insertClient(ids.a, 'Ольга', 1);
  ids.al2 = await insertClient(ids.a, 'Дмитрий', 2);
  ids.al3 = await insertClient(ids.a, 'Иван', 3);
  ids.al4 = await insertClient(ids.a, 'Степан', 4); // без саммари — пустая строка в дайджесте
  await query(`INSERT INTO advisor_client_tags (client_id, tag_id, tag_name, tag_type) VALUES ($1,'sber','Сбербанк','company')`, [ids.al1]);
  await query(`INSERT INTO advisor_client_tags (client_id, tag_id, tag_name, tag_type) VALUES ($1,'gazp','Газпром','company')`, [ids.al2]);
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id) VALUES ($1,'111001')`, [ids.a]);

  ids.bl1 = await insertClient(ids.b, 'Борис', 1);
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id, notify_prefs) VALUES ($1,'222002',$2)`, [ids.b, JSON.stringify({ advisor_alert_neg: false })]);

  ids.cl1 = await insertClient(ids.c, 'Виктор', 1);

  ids.dl1 = await insertClient(ids.d, 'Григорий', 1);
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id) VALUES ($1,'444004')`, [ids.d]);

  ids.el1 = await insertClient(ids.e, 'Елена', 1);
  await query(`INSERT INTO notification_subscriptions (user_id, product, channel, enabled) VALUES ($1,'weekly_report','email',1)`, [ids.e]);

  ids.w1 = await insertClient(ids.w, 'В1', 1);
  ids.w2 = await insertClient(ids.w, 'В2', 2);
  ids.w3 = await insertClient(ids.w, 'В3', 3);
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id) VALUES ($1,'777007')`, [ids.w]);

  ids.fl1 = await insertClient(ids.f, 'Ф1', 1);
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id, notify_prefs) VALUES ($1,'666006',$2)`, [ids.f, JSON.stringify({ advisor_weekly: false })]);

  ids.gl1 = await insertClient(ids.g, 'Г1', 1);
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id) VALUES ($1,'555005')`, [ids.g]);

  // Саммари для алертов (период 12 ч):
  //  AL1: 6 статей, neg 60% -> негативный алерт; AL2: 5 статей, pos 70% -> позитивный;
  //  AL3: 4 статьи, neg 100% -> мало статей (<5), молчит;
  //  BL1: 6, neg 80% + prefs neg=false -> молчит; CL1: 6, neg 80%, без chat -> молчит;
  //  DL1: 6, neg 80%, TG-мок failed -> штампа НЕТ.
  await insertSummary(ids.al1, 6, { pos: 20, neg: 60, neu: 20 });
  await insertSummary(ids.al2, 5, { pos: 70, neg: 10, neu: 20 });
  await insertSummary(ids.al3, 4, { pos: 0, neg: 100, neu: 0 });
  await insertSummary(ids.bl1, 6, { pos: 10, neg: 80, neu: 10 });
  await insertSummary(ids.cl1, 6, { pos: 10, neg: 80, neu: 10 });
  await insertSummary(ids.dl1, 6, { pos: 10, neg: 80, neu: 10 });

  // Новости для дайджеста новостей (10.3): одна новость матчит Ольгу и Дмитрия
  await query(`INSERT INTO user_defined_tags (tag_id, tag_name, tag_type) VALUES ('sber','Сбербанк','company'),('gazp','Газпром','company')`);
  for (const [slug, title, tags, h] of [
    ['n-sber', 'Свежая новость Сбера', ['sber'], 1],
    ['n-gazp', 'Свежая новость Газпрома', ['gazp'], 2],
    ['n-both', 'Сводная новость Сбер+Газпром', ['sber', 'gazp'], 3],
  ]) {
    await query(
      `INSERT INTO news (id, title_ru, slug, url, source, source_id, published_at, matched_tags, sentiment, summary_ru)
       VALUES ($1,$2,$3,'https://example.com/' || $3,'tz183','tz183',$4,$5,'neutral','summary')`,
      [uuid(), title, `tz183-${slug}`, isoHoursAgo(h), JSON.stringify(tags)],
    );
  }

  const alerts = require(path.join(DIST, 'advisor', 'alerts'));
  const digest = require(path.join(DIST, 'advisor', 'digest'));
  const weekly = require(path.join(DIST, 'advisor', 'weekly'));
  const reminders = require(path.join(DIST, 'advisor', 'tasks'));
  const advisorTg = require(path.join(DIST, 'advisor', 'telegram'));

  // ── A1. Алерты 10.1–10.4 ────────────────────────────────────────────────
  const tgCount = () => tgLog.length;
  await alerts.maybeSendSentimentAlert(ids.a, ids.al1);
  assert(tgCount() === 1 && tgLog[0].chatId === '111001', 'негативный алерт ушёл в TG');
  assert(tgLog[0].text.includes('Ольга') && tgLog[0].text.includes('всплеск негатива') && tgLog[0].text.includes('60%'), 'текст негативного алерта (порог 60%, ≥5 статей)');
  let st = await query(`SELECT last_alert_neg_at, last_alert_pos_at FROM advisor_clients WHERE id = $1`, [ids.al1]);
  assert(st.rows[0].last_alert_neg_at && !st.rows[0].last_alert_pos_at, 'last_alert_neg_at штампнут ПОСЛЕ успешной отправки');

  const stamp1 = st.rows[0].last_alert_neg_at;
  await alerts.maybeSendSentimentAlert(ids.a, ids.al1);
  assert(tgCount() === 1, 'повтор в окне cooldown 12 ч — не отправляется');
  st = await query(`SELECT last_alert_neg_at FROM advisor_clients WHERE id = $1`, [ids.al1]);
  assert(st.rows[0].last_alert_neg_at === stamp1, 'штамп не перезаписан без отправки');

  await alerts.maybeSendSentimentAlert(ids.a, ids.al2);
  assert(tgCount() === 2 && tgLog[1].text.includes('сильный позитив') && tgLog[1].text.includes('70%'), 'позитивный алерт (порог 70%) — отдельное сообщение');
  st = await query(`SELECT last_alert_pos_at FROM advisor_clients WHERE id = $1`, [ids.al2]);
  assert(st.rows[0].last_alert_pos_at, 'last_alert_pos_at штампнут');

  const before = tgCount();
  await alerts.maybeSendSentimentAlert(ids.a, ids.al3); // 4 статьи < 5
  await alerts.maybeSendSentimentAlert(ids.b, ids.bl1); // prefs neg=false
  await alerts.maybeSendSentimentAlert(ids.c, ids.cl1); // нет chat
  assert(tgCount() === before, '<5 статей / выключенный флаг / без chat — молчат');
  st = await query(`SELECT last_alert_neg_at FROM advisor_clients WHERE id IN ($1,$2,$3)`, [ids.al3, ids.bl1, ids.cl1]);
  assert(st.rows.every((r) => !r.last_alert_neg_at), 'штампов нет у немых клиентов');

  // cooldown 12 ч: штамп 13 часов назад -> алерт уходит снова
  await query(`UPDATE advisor_clients SET last_alert_neg_at = $1 WHERE id = $2`, [isoHoursAgo(13), ids.al1]);
  await alerts.maybeSendSentimentAlert(ids.a, ids.al1);
  assert(tgCount() === before + 1, 'после 13 ч (> cooldown) алерт уходит повторно');

  // failed-отправка НЕ штампует (alerts.ts: штамп строго после успеха)
  await alerts.maybeSendSentimentAlert(ids.d, ids.dl1);
  st = await query(`SELECT last_alert_neg_at FROM advisor_clients WHERE id = $1`, [ids.dl1]);
  assert(!st.rows[0].last_alert_neg_at, 'failed-отправка не штампует last_alert_*_at');
  ok('A1: алерты — ≥5 статей и 60%/70%, cooldown 12 ч на направление, штамп ПОСЛЕ успеха, failed не штампует, notify_prefs уважается');

  // ── A2. Чанкование TG ≤4000 (10.2/10.7) ─────────────────────────────────
  const longText = Array.from({ length: 950 }, (_, i) => `Абзац номер ${i} с достаточно длинным текстом для проверки разбиения.`).join('\n\n');
  const chunks = advisorTg.splitAdvisorMessage(longText);
  assert(chunks.length > 1 && chunks.every((c) => c.length <= 4000), 'splitAdvisorMessage: все чанки ≤ 4000');
  const rejoined = chunks.join('\n\n');
  assert(rejoined.includes('Абзац номер 0 ') && rejoined.includes('Абзац номер 949'), 'склейка чанков сохраняет текст');
  const sendOk = await advisorTg.sendAdvisorTelegram('111001', longText);
  assert(sendOk === true, 'sendAdvisorTelegram ок при успешном моке');
  const lastChunks = tgLog.slice(-chunks.length);
  assert(lastChunks.every((m) => m.text.length <= 4000), 'отправленные части ≤ 4000');
  ok('A2: чанкование 4000 (лимит TG 4096 с запасом) — split и отправка по частям');

  // ── A3. Дайджест (10.2) ─────────────────────────────────────────────────
  const dig = await digest.sendAdvisorSlotMessages(ids.a, 8);
  assert(dig.digest === true && dig.news === true, 'дайджест и новости отправлены');
  const digMsg = tgLog.find((m) => m.chatId === '111001' && m.text.includes('📊 Обзор по клиентам'));
  assert(digMsg, 'сообщение дайджеста есть');
  assert(digMsg.text.includes('08:00 мск'), 'шапка со слотом МСК');
  assert(digMsg.text.includes('▸ Ольга (6 новостей)'), 'блок с именем и числом новостей');
  assert(digMsg.text.includes('▸ Степан — без значимых событий'), 'пустый клиент одной строкой');
  assert(digMsg.text.includes('Все карточки: pulse.inside-trade.ru/adviser'), 'футер-ссылка на Adviser (не /clients)');
  const newsMsg = tgLog.find((m) => m.chatId === '111001' && m.text.includes('📰 Важные новости по клиентам'));
  assert(newsMsg, 'блок новостей есть');
  assert(newsMsg.text.includes('▸ [Ольга, Дмитрий] Сводная новость Сбер+Газпром'), 'dedup: одна новость для двух клиентов — одна строка с двумя именами');
  const digAllEmpty = await digest.sendAdvisorSlotMessages(ids.g, 8);
  assert(digAllEmpty.digest === false && digAllEmpty.news === false, 'все клиенты пустые — дайджест не уходит');
  assert(!tgLog.some((m) => m.chatId === '555005'), 'пустому пользователю сообщений нет');
  // prefs: advisor_digest=false глушит дайджест, advisor_news=false — новости
  await query(`INSERT INTO advisor_settings (user_id, telegram_chat_id, notify_prefs) VALUES ($1,'333003',$2)
               ON CONFLICT (user_id) DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, notify_prefs = EXCLUDED.notify_prefs`, [ids.c, JSON.stringify({ advisor_digest: false, advisor_news: false })]);
  const digPrefs = await digest.sendAdvisorSlotMessages(ids.c, 8);
  assert(digPrefs.digest === false && digPrefs.news === false, 'notify_prefs выключает каналы дайджеста');
  ok('A3: дайджест — формат блоков, пустой клиент одной строкой, all-empty skip, dedup новостей, prefs');

  // ── A4. Weekly (10.5/10.8) ──────────────────────────────────────────────
  const subsBefore = await query(`SELECT COUNT(*) AS cnt FROM notification_subscriptions`);
  const weeklyRes = await weekly.runAdvisorWeekly();
  assert(weeklyRes.users >= 3, `weekly обработал пользователей: ${weeklyRes.users}`);
  assert(weeklyRes.skippedEmpty >= 3, 'skip-empty без LLM (0 статей — без LLM)');
  const wMsg = tgLog.find((m) => m.chatId === '777007' && m.text.includes('📅 Неделя по клиентам'));
  assert(wMsg, 'weekly-сообщение ушло пользователю с 3 клиентами');
  assert(wMsg.text.includes('▸ В1 — без значимых событий') && wMsg.text.includes('▸ В2 — без значимых событий') && wMsg.text.includes('▸ В3 — без значимых событий'), '3 блока по клиентам');
  assert(wMsg.text.includes('Все карточки: pulse.inside-trade.ru/adviser'), 'футер Adviser');
  assert(!wMsg.text.includes('Мой портфель'), '«Мой портфель» в отчёт не включается');
  assert(!tgLog.some((m) => m.chatId === '666006' && m.text.includes('📅 Неделя')), 'advisor_weekly=false — пользователь исключён');
  const wEmail = emailLog.find((m) => m.to === 'tz183-e@test.ru' && m.subject.includes('неделя'));
  assert(wEmail, 'email-канал weekly по notification_subscriptions (read-only чтение подписки)');
  assert(wEmail.html.includes('Елена'), 'email содержит блок клиента');
  const subsAfter = await query(`SELECT COUNT(*) AS cnt FROM notification_subscriptions`);
  assert(Number(subsAfter.rows[0].cnt) === Number(subsBefore.rows[0].cnt), 'notification_subscriptions НЕ изменена (только чтение)');
  const subsAdvisor = await query(`SELECT COUNT(*) AS cnt FROM notification_subscriptions WHERE product LIKE 'advisor%' OR channel LIKE 'advisor%'`);
  assert(Number(subsAdvisor.rows[0].cnt) === 0, 'записей advisor_* в ядерной таблице нет');
  ok('A4: weekly — 3 блока одним сообщением, prefs-исключение, email по read-only подписке, notification_subscriptions не тронута');

  // ── A5. Напоминания (10.9, крон-логика) ─────────────────────────────────
  await query(
    `INSERT INTO advisor_tasks (client_id, advisor_user_id, title, due_date, remind_at, remind_channels)
     VALUES ($1,$2,'Позвонить Ивану','2026-11-05',$3,'["telegram","email"]')`,
    [ids.al3, ids.a, isoHoursAgo(1)],
  );
  const tDone = (
    await query(`INSERT INTO advisor_tasks (client_id, advisor_user_id, title, due_date, remind_at, remind_channels, is_done)
                 VALUES ($1,$2,'Сделанная задача','2026-11-05',$3,'["telegram"]',1) RETURNING id`, [ids.al3, ids.a, isoHoursAgo(1)])
  ).rows[0].id;
  await query(
    `INSERT INTO advisor_tasks (client_id, advisor_user_id, title, remind_at, remind_channels)
     VALUES ($1,$2,'Без chat TG',$3,'["telegram"]')`,
    [ids.el1, ids.e, isoHoursAgo(1)],
  );
  await query(
    `INSERT INTO advisor_tasks (client_id, advisor_user_id, title, remind_at, remind_channels)
     VALUES ($1,$2,'Будущее напоминание',$3,'["telegram"]')`,
    [ids.al3, ids.a, isoHoursAhead(2)],
  );
  const tgBefore = tgLog.length;
  const emailBefore = emailLog.length;
  const run1 = await reminders.runAdvisorTaskReminders();
  assert(run1.due === 2, `due=2 (готовые + failed-chat), got ${run1.due}`);
  assert(run1.sent === 2 && run1.failed === 1, `sent=2 (TG+email) failed=1 (TG без chat), got ${JSON.stringify(run1)}`);
  const remMsg = tgLog.slice(tgBefore).find((m) => m.chatId === '111001' && m.text.includes('⏰ Напоминание: Позвонить Ивану'));
  assert(remMsg && remMsg.text.includes('Иван') && remMsg.text.includes('pulse.inside-trade.ru/adviser'), 'TG-текст напоминания с клиентом и ссылкой');
  assert(emailLog.slice(emailBefore).some((m) => m.to === 'tz183-a@test.ru' && m.subject.includes('напоминание')), 'email-канал напоминания');
  assert(tgLog.slice(tgBefore).every((m) => m.chatId !== '222002'), 'failed-канал (нет chat) не «отправлен», логируется failed');
  let taskRow = await query(`SELECT reminded_at, is_done FROM advisor_tasks WHERE title = 'Позвонить Ивану'`);
  assert(taskRow.rows[0].reminded_at && Number(taskRow.rows[0].is_done) === 0, 'reminded_at проставлен после обработки');
  taskRow = await query(`SELECT reminded_at FROM advisor_tasks WHERE id = $1`, [tDone]);
  assert(!taskRow.rows[0].reminded_at, 'is_done = FALSE фильтр: сделанная задача не тронута');
  const run2 = await reminders.runAdvisorTaskReminders();
  assert(run2.due === 0 && run2.sent === 0, `повторный прогон — идемпотентно (due=0), got ${JSON.stringify(run2)}`);
  // смена remind_at (сброс reminded_at) → шлёт снова в новый срок
  await query(`UPDATE advisor_tasks SET remind_at = $1, reminded_at = NULL WHERE title = 'Позвонить Ивану'`, [isoHoursAgo(0.5)]);
  const run3 = await reminders.runAdvisorTaskReminders();
  assert(run3.due === 1 && run3.sent === 2, `смена remind_at после отправки — отправка повторяется, got ${JSON.stringify(run3)}`);
  const idxRow = await query(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_advisor_tasks_remind'`);
  assert(/WHERE.*reminded_at IS NULL AND is_done = 0/i.test(idxRow.rows[0].sql), 'частичный индекс idx_advisor_tasks_remind');
  ok('A5: напоминания — выборка по индексу, is_done-фильтр, per-channel failed-лог, идемпотентность по reminded_at, смена срока повторяет');

  // ── A6. TG-привязка: HMAC userId:timestamp:signature, TTL 15 мин (Задача 2) ─
  const token = advisorTg.generateAdvisorLinkToken(ids.a);
  const parts = token.split(':');
  assert(parts.length === 3 && parts[0] === ids.a && /^\d+$/.test(parts[1]) && /^[a-f0-9]{16}$/.test(parts[2]), 'формат userId:timestamp:signature');
  assert(advisorTg.verifyAdvisorLinkToken(parts[0], parts[1], parts[2]) === 'ok', 'свежий токен — ok');
  assert(advisorTg.verifyAdvisorLinkToken(parts[0], parts[1], '0000000000000000') === 'bad_signature', 'подделанная сигнатура — bad_signature');
  const oldTs = String(Date.now() - 16 * 60 * 1000);
  const oldSig = crypto.createHmac('sha256', process.env.TELEGRAM_BOT_TOKEN).update(`${ids.a}:${oldTs}`).digest('hex').slice(0, 16);
  assert(advisorTg.verifyAdvisorLinkToken(parts[0], oldTs, oldSig) === 'expired', 'TTL 15 мин: старый токен — expired');
  const futureTs = String(Date.now() + 30 * 1000);
  const futureSig = crypto.createHmac('sha256', process.env.TELEGRAM_BOT_TOKEN).update(`${ids.a}:${futureTs}`).digest('hex').slice(0, 16);
  assert(advisorTg.verifyAdvisorLinkToken(ids.a, futureTs, futureSig) === 'ok', 'небольшой допуск на часы вперёд (≤60 с)');
  const farFutureTs = String(Date.now() + 2 * 60 * 1000);
  const farFutureSig = crypto.createHmac('sha256', process.env.TELEGRAM_BOT_TOKEN).update(`${ids.a}:${farFutureTs}`).digest('hex').slice(0, 16);
  assert(advisorTg.verifyAdvisorLinkToken(ids.a, farFutureTs, farFutureSig) === 'expired', 'более чем на 60 с вперёд — expired');
  assert(advisorTg.ADVISOR_TG_LINK_TTL_MS === 15 * 60 * 1000, 'TTL-константа 15 минут');
  ok('A6: TG-токен — HMAC userId:timestamp:signature, TTL 15 мин, bad_signature/expired, допуск вперёд');

  // ── A7. TG-очередь: ≥1 с между сообщениями одному чату (10.7) ────────────
  const mark = tgLog.length;
  for (let i = 0; i < 5; i++) {
    await advisorTg.sendAdvisorTelegram('999000', `Сообщение очереди ${i}`);
  }
  const queue = tgLog.slice(mark).filter((m) => m.chatId === '999000');
  assert(queue.length === 5, '5 сообщений ушли');
  for (let i = 1; i < queue.length; i++) {
    assert(queue[i].at - queue[i - 1].at >= 1000, `пауза ≥1 с между сообщениями (${queue[i].at - queue[i - 1].at}ms)`);
  }
  ok('A7: TG-очередь — 5 сообщений одному чату с задержкой ≥1 с (rate limit TG API)');

  sqlite.saveDb();
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
    a: jwt.sign({ userId: ids.a, email: 'tz183-a@test.ru' }, 'test'),
    b: jwt.sign({ userId: ids.b, email: 'tz183-b@test.ru' }, 'test'),
    c: jwt.sign({ userId: ids.c, email: 'tz183-c@test.ru' }, 'test'),
    e: jwt.sign({ userId: ids.e, email: 'tz183-e@test.ru' }, 'test'),
  };

  const logBuf = [];
  let server = await startServer(logBuf);
  try {
    const log1 = logBuf.join('');
    assert(log1.includes('Advisor weekly scheduled Sunday at 13:00 Europe/Moscow'), 'крон weekly: вс 13:00 МСК (зеркало ядра)');
    assert(log1.includes('Advisor task reminders scheduled every 5 minutes Europe/Moscow'), 'крон напоминаний */5 Europe/Moscow');
    ok('B0: кроны модуля зарегистрированы (weekly вс 13:00 МСК, reminders */5 МСК)');

    // ── B1. Задачи (10.5) ───────────────────────────────────────────────────
    const eventId = uuid();
    let r = await api('POST', `/api/advisor/clients/${ids.al3}/tasks`, { token: tokens.a, body: { title: 'Созвон по сделке', due_date: '2026-11-01', source_event_id: eventId } });
    assert(r.status === 201 && r.json.task.source_event_id === eventId && r.json.alreadyExists === false, `POST task из события → 201, got ${r.status} ${r.text.slice(0, 150)}`);
    const taskId = r.json.task.id;
    assert(r.json.task.due_date === '2026-11-01', 'due_date сохранён');
    r = await api('POST', `/api/advisor/clients/${ids.al3}/tasks`, { token: tokens.a, body: { title: 'Дубль события', due_date: '2026-11-01', source_event_id: eventId } });
    assert(r.status === 200 && r.json.alreadyExists === true && r.json.task.id === taskId && r.json.task.title === 'Созвон по сделке', `повтор того же source_event_id → 200 без дубля, got ${r.status} ${r.text.slice(0, 150)}`);
    r = await api('POST', `/api/advisor/clients/${ids.al3}/tasks`, { token: tokens.a, body: { title: 'Без события' } });
    assert(r.status === 201, 'POST без source_event_id → 201');
    const taskNoEvent = r.json.task.id;
    r = await api('POST', `/api/advisor/clients/${ids.al3}/tasks`, { token: tokens.a, body: { title: '   ' } });
    assert(r.status === 400 && r.json.error === 'invalid_title', `пустой title → 400 invalid_title, got ${r.status}`);
    r = await api('POST', `/api/advisor/clients/${ids.al3}/tasks`, { token: tokens.a, body: { title: 'X', due_date: 'не-дата' } });
    assert(r.status === 400 && r.json.error === 'invalid_due_date', 'невалидный due_date → 400 invalid_due_date');
    r = await api('POST', `/api/advisor/clients/${ids.bl1}/tasks`, { token: tokens.a, body: { title: 'Чужой клиент' } });
    assert(r.status === 403 && r.json.error === 'advisor_client_forbidden', 'чужой клиент → 403 advisor_client_forbidden');

    r = await api('GET', '/api/advisor/tasks', { token: tokens.a });
    assert(r.status === 200, `GET /tasks → 200, got ${r.status}`);
    const titles = r.json.tasks.map((t) => t.title);
    assert(titles.includes('Созвон по сделке') && titles.includes('Без события') && titles.includes('Позвонить Ивану'), 'открытые задачи всех не-архивных клиентов с client_name');
    const aggTask = r.json.tasks.find((t) => t.id === taskId);
    assert(aggTask.client_name === 'Иван', 'client_name в агрегате «Мои задачи»');
    assert(!titles.includes('Сделанная задача'), 'done не попадают');
    r = await api('PATCH', `/api/advisor/tasks/${taskNoEvent}`, { token: tokens.a, body: { is_done: true } });
    assert(r.status === 200 && r.json.task.is_done === true, 'PATCH done → 200');
    r = await api('GET', '/api/advisor/tasks', { token: tokens.a });
    assert(!r.json.tasks.some((t) => t.id === taskNoEvent), 'после done задача исчезает из списка');
    r = await api('GET', '/api/advisor/tasks', { token: tokens.b });
    assert(r.status === 200 && !r.json.tasks.some((t) => t.client_name === 'Иван'), 'чужие задачи не попадают');
    // задачи архивного клиента не попадают
    r = await api('PATCH', `/api/advisor/clients/${ids.bl1}`, { token: tokens.b, body: { is_archived: true } });
    assert(r.status === 200, 'архивация клиента uB');
    r = await api('GET', '/api/advisor/tasks', { token: tokens.b });
    assert(r.status === 200 && r.json.tasks.length === 0, 'задачи архивного клиента не попадают в «Мои задачи»');
    r = await api('PATCH', `/api/advisor/clients/${ids.bl1}`, { token: tokens.b, body: { is_archived: false } });
    assert(r.status === 200, 'восстановление клиента uB');
    ok('B1: задачи — POST из события, идемпотентность по source_event_id, PATCH done, 400-коды, чужой клиент → 403, агрегат с client_name');

    // ── B2. Заметки (10.6) ──────────────────────────────────────────────────
    r = await api('PATCH', `/api/advisor/clients/${ids.al1}`, { token: tokens.a, body: { notes: 'Любит дивидендные истории' } });
    assert(r.status === 200, 'PATCH notes → 200');
    r = await api('GET', '/api/advisor/clients', { token: tokens.a });
    assert(r.json.clients.find((c) => c.id === ids.al1).notes === 'Любит дивидендные истории', 'notes присутствует в GET /clients');
    r = await api('PATCH', `/api/advisor/clients/${ids.al1}`, { token: tokens.a, body: { notes: '' } });
    assert(r.status === 200, 'PATCH notes=\'\' → 200');
    const notesNull = dbExec(`SELECT notes FROM advisor_clients WHERE id = ${ids.al1}`)[0];
    assert(notesNull.length === 1 && notesNull[0].notes === null, 'пустая строка → NULL в БД');
    ok('B2: заметки — сохранение, отдача в списке, пустая строка → NULL');

    // ── B3. Reminder-эндпоинт (10.9) ────────────────────────────────────────
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.a, body: { remind_at: '2020-01-01T00:00:00Z', channels: ['telegram'] } });
    assert(r.status === 400 && r.json.error === 'remind_at_in_past', `remind_at в прошлом → 400 remind_at_in_past, got ${r.status} ${r.text.slice(0, 100)}`);
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.a, body: { remind_at: isoHoursAhead(1), channels: ['smoke'] } });
    assert(r.status === 400 && r.json.error === 'invalid_channels', 'канал вне списка → 400 invalid_channels');
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.a, body: { remind_at: isoHoursAhead(1), channels: [] } });
    assert(r.status === 400 && r.json.error === 'invalid_channels', 'пустой channels → 400 invalid_channels');
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.a, body: { remind_at: isoHoursAhead(1), channels: ['telegram', 'telegram'] } });
    assert(r.status === 400 && r.json.error === 'invalid_channels', 'дубль канала → 400 invalid_channels');
    const eTask = (await api('POST', `/api/advisor/clients/${ids.el1}/tasks`, { token: tokens.e, body: { title: 'Задача Елены' } })).json.task.id;
    r = await api('PATCH', `/api/advisor/tasks/${eTask}/reminder`, { token: tokens.e, body: { remind_at: isoHoursAhead(1), channels: ['telegram'] } });
    assert(r.status === 400 && r.json.error === 'telegram_not_linked', `TG без привязки → 400 telegram_not_linked, got ${r.status} ${r.text.slice(0, 120)}`);
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.a, body: { remind_at: isoHoursAhead(1), channels: ['telegram', 'email'] } });
    assert(r.status === 200 && r.json.task.remind_at && r.json.task.remind_channels.join(',') === 'telegram,email' && r.json.task.reminded_at === null, `валидный reminder → 200, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.a, body: { remind_at: null } });
    assert(r.status === 200 && r.json.task.remind_at === null && r.json.task.remind_channels === null && r.json.task.reminded_at === null, 'remind_at=null сбрасывает напоминание и reminded_at');
    ok('B3: reminder — 400 remind_at_in_past/invalid_channels×3/telegram_not_linked, 200 с каналами, null-сброс');

    // ── B4. ICS (10.10) ─────────────────────────────────────────────────────
    const icsRes = await fetch(`${BASE}/api/advisor/tasks/${taskId}/ics`, { headers: { Authorization: `Bearer ${tokens.a}` } });
    const ics = await icsRes.text();
    assert(icsRes.status === 200, `ICS → 200, got ${icsRes.status}`);
    assert(icsRes.headers.get('content-type').includes('text/calendar'), 'Content-Type text/calendar');
    assert(icsRes.headers.get('content-disposition').includes(`advisor-task-${taskId}.ics`), 'Content-Disposition с именем файла');
    assert(ics.startsWith('BEGIN:VCALENDAR') && ics.includes('VERSION:2.0') && ics.includes('PRODID:-//PULSE//Advisor Tasks//RU'), 'валидный VCALENDAR-скелет');
    assert(ics.includes('BEGIN:VEVENT') && ics.includes(`UID:advisor-task-${taskId}@pulse.inside-trade.ru`), 'VEVENT + UID с id задачи');
    assert(ics.includes('DTSTART;VALUE=DATE:20261101'), 'дата совпадает с due_date');
    assert(ics.includes('SUMMARY:Созвон по сделке'), 'SUMMARY с title');
    assert(ics.includes('DESCRIPTION:Клиент: Иван') && ics.includes('Иван\\nИсточник:'), 'DESCRIPTION с именем клиента и экранированным переносом');
    assert(ics.trim().endsWith('END:VCALENDAR'), 'END:VCALENDAR');
    // stateless: повторный запрос — тот же VEVENT (кроме DTSTAMP)
    const ics2 = await (await fetch(`${BASE}/api/advisor/tasks/${taskId}/ics`, { headers: { Authorization: `Bearer ${tokens.a}` } })).text();
    const stripStamp = (s) => s.split('\r\n').filter((l) => !l.startsWith('DTSTAMP')).join('\r\n');
    assert(stripStamp(ics) === stripStamp(ics2), 'эндпоинт стейтлесс: повторный ICS идентичен');
    const noDue = (await api('POST', `/api/advisor/clients/${ids.al3}/tasks`, { token: tokens.a, body: { title: 'Без дедлайна' } })).json.task.id;
    r = await api('GET', `/api/advisor/tasks/${noDue}/ics`, { token: tokens.a });
    assert(r.status === 400 && r.json.error === 'no_due_date', 'задача без due_date → 400 no_due_date');
    ok('B4: ICS — валидный VCALENDAR/VEVENT, UID/дата/SUMMARY, stateless, no_due_date → 400');

    // ── B5. Ownership задач (10.5/10.10) ────────────────────────────────────
    r = await api('PATCH', `/api/advisor/tasks/${taskId}`, { token: tokens.b, body: { is_done: true } });
    assert(r.status === 403 && r.json.error === 'advisor_task_forbidden', `чужая задача PATCH → 403 advisor_task_forbidden, got ${r.status} ${r.text.slice(0, 100)}`);
    r = await api('PATCH', `/api/advisor/tasks/${taskId}/reminder`, { token: tokens.b, body: { remind_at: isoHoursAhead(1), channels: ['email'] } });
    assert(r.status === 403 && r.json.error === 'advisor_task_forbidden', 'чужая задача reminder → 403');
    r = await api('GET', `/api/advisor/tasks/${taskId}/ics`, { token: tokens.b });
    assert(r.status === 403 && r.json.error === 'advisor_task_forbidden', 'чужая задача ICS → 403');
    r = await api('PATCH', '/api/advisor/tasks/999999', { token: tokens.b, body: { is_done: true } });
    assert(r.status === 404 && r.json.error === 'advisor_task_not_found', 'несуществующая задача → 404');
    ok('B5: ownership задач — чужая → 403 advisor_task_forbidden, несуществующая → 404');

    // ── B6. TG-привязка: deep-link smoke (Задача 2) ─────────────────────────
    r = await api('GET', '/api/advisor/telegram/status', { token: tokens.a });
    assert(r.status === 200 && r.json.linked === true, 'status: привязанный чат виден (linked=true)');
    r = await api('POST', '/api/advisor/telegram/link', { token: tokens.e });
    assert(r.status === 200 && r.json.linked === false && r.json.botUsername === 'Insidepulse_bot', 'link для непривязанного → linked=false');
    const m = r.json.deepLink && r.json.deepLink.match(/^https:\/\/t\.me\/Insidepulse_bot\?start=([^:]+):(\d+):([a-f0-9]{16})$/);
    assert(m && m[1] === ids.e, `deep-link формат https://t.me/Insidepulse_bot?start=userId:timestamp:signature, got ${r.json.deepLink}`);
    assert(r.json.expiresIn === '15m', 'expiresIn=15m');
    const { verifyAdvisorLinkToken } = require(path.join(DIST, 'advisor', 'telegram'));
    assert(verifyAdvisorLinkToken(m[1], m[2], m[3]) === 'ok', 'токен из deep-link проходит verifyAdvisorLinkToken (HMAC)');
    r = await api('POST', '/api/advisor/telegram/link', { token: tokens.a });
    assert(r.status === 200 && r.json.linked === true && r.json.deepLink === null, 'для привязанного deep-link не выдаётся (одноразовость по признаку chat_id)');
    r = await api('POST', '/api/advisor/telegram/unlink', { token: tokens.a });
    assert(r.status === 200 && r.json.linked === false, 'unlink → 200');
    r = await api('GET', '/api/advisor/telegram/status', { token: tokens.a });
    assert(r.json.linked === false, 'после unlink status linked=false');
    r = await api('POST', '/api/advisor/telegram/link', { token: tokens.a });
    assert(r.status === 200 && r.json.deepLink && r.json.linked === false, 'после unlink deep-link снова выдаётся');
    ok('B6: TG-привязка — deep-link формат, TTL 15m, одноразовость по chat_id, unlink/status');

    // ── B7. notify_prefs (Задача 1) ─────────────────────────────────────────
    r = await api('GET', '/api/advisor/prefs', { token: tokens.a });
    assert(r.status === 200, `GET /prefs → 200, got ${r.status}`);
    assert(r.json.notify_prefs.advisor_digest === true && r.json.notify_prefs.advisor_weekly === true && r.json.notify_prefs.advisor_alert_neg === true, 'дефолты пакета ON');
    assert(!('advisor_tg_enabled' in r.json.notify_prefs) && !('advisor_tg_failed_count' in r.json.notify_prefs), 'служебные ключи авто-отключения фронту не отдаются');
    r = await api('PATCH', '/api/advisor/prefs', { token: tokens.a, body: { advisor_news: false, advisor_tg_enabled: true } });
    assert(r.status === 200 && r.json.notify_prefs.advisor_news === false && !('advisor_tg_enabled' in r.json.notify_prefs), 'PATCH merge: advisor_news=false, служебный ключ проигнорирован');
    r = await api('PUT', '/api/advisor/notify-prefs', { token: tokens.a, body: { prefs: { advisor_news: true } } });
    assert(r.status === 200 && r.json.notify_prefs.advisor_news === true, 'PUT /notify-prefs алиас с {prefs:{}}');
    r = await api('PATCH', '/api/advisor/prefs', { token: tokens.a, body: { unknown_key: true } });
    assert(r.status === 400 && r.json.error === 'invalid_prefs', 'пустой patch → 400 invalid_prefs');
    r = await api('GET', '/api/advisor/prefs', { token: tokens.a });
    assert(r.json.notify_prefs.advisor_news === true && r.json.notify_prefs.advisor_digest === true, 'merge не ломает остальные флаги');
    ok('B7: notify_prefs — дефолты ON, merge UPSERT, служебные ключи скрыты, PUT-алиас, 400');

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
    // Изоляция ядра (10.1): у users/notification_subscriptions нет колонок модуля
    for (const table of ['users', 'notification_subscriptions']) {
      const cols = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name LIKE '%advisor%'`,
        [table]);
      assert(cols.rows.length === 0, `${table}: advisor-колонок нет (песочница)`);
    }
    const coreCols = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name = 'notification_subscriptions' ORDER BY ordinal_position`);
    assert(coreCols.rows.length > 0, 'notification_subscriptions существует');
    ok('C1: PG — изоляция ядра: users/notification_subscriptions без advisor-колонок');

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'advisor_%'`);
    assert(tables.rows.length === 5, '5 таблиц advisor_*');
    const idx = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_advisor%'`);
    const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
    assert(/WHERE \(source_event_id IS NOT NULL\)/.test(byName.idx_advisor_tasks_event || ''), 'частичный unique idx_advisor_tasks_event');
    assert(/WHERE \(\(reminded_at IS NULL\) AND \(is_done = false\)\)/i.test(byName.idx_advisor_tasks_remind || ''), 'частичный idx_advisor_tasks_remind');
    ok('C2: PG — advisor-таблицы и частичные индексы напоминаний/идемпотентности');
  } finally {
    await client.end();
  }
}

(async () => {
  try {
    const ids = await seedAndPhaseA();
    await phaseB(ids);
    await phaseC();
    console.log(`\nOK ${passed}: все проверки ТЗ-183 Задача 10 пройдены`);
    process.exit(0);
  } catch (e) {
    console.error('\nTZ183 FAIL:', e);
    process.exit(1);
  }
})();
