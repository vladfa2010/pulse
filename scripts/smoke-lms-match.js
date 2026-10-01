// Smoke-проверка ТЗ-103 (LMS: мэтчинг курсов с новостями и календарём) по HTTP.
// Запуск: npm run build && node scripts/smoke-lms-match.js
// Паттерн — scripts/smoke-lms-step2.js: каждый прогон — дочерний процесс
// (sql.js держит SQLite в памяти процесса), сервер поднимается отдельным
// дочерним процессом (dist/index.js, SQLite-режим), проверки — HTTP.
//
// Прогон flagoff: EDUCATION_MATCH_ENABLED не задан → все эндпоинты ТЗ-103 → 404
// (критерии 7, 15), migrate-lms-matching идемпотентен.
// Прогон flagon: EDUCATION_MATCH_ENABLED=true → без KIMI_API_KEY LLM не ходит
// (деградация: пары по тег-матчу со score NULL — штатно, критерий 8/§3.2):
// publish курса → suggestions (source tag), attach → news_course_links +
// публичная карточка курса, dismiss не воскресает (ON CONFLICT), календарный
// мэтчинг по тегам + кэш (один compute на два запроса).
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(__dirname, '..', 'dist');
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(method, p, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  let text = '';
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch {
    /* не-JSON ответ */
  }
  return { status: res.status, json, text };
}

/** НЕ ИСПОЛЬЗУЕТСЯ напрямую: см. srvToday в seedDatabase. */

async function seedDatabase(DIR) {
  process.env.USE_SQLITE = 'true';
  process.env.SQLITE_FILE = `${DIR}/pulse.db`;
  process.env.UPLOADS_DIR = `${DIR}/uploads`;
  process.env.SIGNED_URL_SECRET = 'test';
  process.env.JWT_SECRET = 'test';

  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  await sqlite.query(`ALTER TABLE news ADD COLUMN slug TEXT`);
  const q = sqlite.query;
  const uuid = () => crypto.randomUUID();

  const ids = { admin: uuid(), user: uuid() };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin)
     VALUES ($1,'admin@test.ru','admin','x',1),($2,'user@test.ru','user','x',0)`,
    [ids.admin, ids.user],
  );

  // user_defined_tags создаётся серверной миграцией при старте; в seed нужна раньше.
  // keywords — для календаря: сервер при boot пересобирает calendar_events из raw
  // и выводит tag_ids через keyword-матчинг (smartMatchTagsWithVia), поэтому теги
  // обязаны матчить заголовки событий по границам слова.
  await sqlite.query(
    `CREATE TABLE IF NOT EXISTS user_defined_tags (
       tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL,
       tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT DEFAULT '{}',
       enriched_data TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  );
  await q(
    `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords) VALUES
     ('dividendy','Дивиденды','asset','["дивиденды"]'),
     ('obligatsii','Облигации','asset','["мсфо","облигации"]'),
     ('akcii','Акции','asset','["акции"]')`,
  );

  // Новости за последние часы (retention 14 дней); matched_tags — JSON (SQLite)
  const news = {};
  const seedNews = [
    ['n1', 'Газпром объявил дивиденды за полугодие', ['dividendy'], 1],
    ['n2', 'Облигации и дивиденды: куда вкладывать', ['dividendy', 'obligatsii'], 2],
    ['n3', 'Минфин разместил ОФЗ', ['obligatsii'], 3],
    ['n4', 'Акции технологического сектора выросли', ['akcii'], 1],
  ];
  for (const [key, title, tags, hoursAgo] of seedNews) {
    const id = uuid();
    news[key] = id;
    await q(
      `INSERT INTO news (id, title_ru, slug, url, source, source_id, published_at, matched_tags)
       VALUES ($1,$2,$3,$4,'smoke','smoke',$5,$6)`,
      [id, title, `smoke-${key}`, `https://example.com/${key}`,
        new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(), JSON.stringify(tags)],
    );
  }

  // Календарь: события сегодня/завтра/вчера (таблицу сервер создаёт при старте,
  // seed готовит раньше — DDL зеркалит index.ts). «Сегодня по МСК» считаем ТЕМ
  // ЖЕ способом, что серверный getMskDateString() (calendar.ts:212): SQLite
  // datetime('now') парсится new Date как ЛОКАЛЬНОЕ время, потом +3 ч — на
  // машинах с TZ ≠ UTC/MSK итоговая дата смещена, и независимый расчёт в
  // тесте дал бы другой «сегодня». Здесь и в сиде — одна формула.
  const srvNowRow = await q(`SELECT datetime('now') AS now`);
  const srvToday = new Date(new Date(srvNowRow.rows[0].now).getTime() + 3 * 3600 * 1000)
    .toISOString().slice(0, 10);
  const day = (offset) => new Date(new Date(`${srvToday}T00:00:00Z`).getTime() + offset * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  await sqlite.query(
    `CREATE TABLE IF NOT EXISTS calendar_events (
       id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
       date TEXT NOT NULL, weekday TEXT NOT NULL, title TEXT NOT NULL,
       kind TEXT NOT NULL, status TEXT NOT NULL, company TEXT NOT NULL,
       ticker TEXT NOT NULL, uploaded_at TEXT, sources TEXT,
       possible_duplicate INTEGER DEFAULT 0, tag_ids TEXT,
       UNIQUE (date, title, kind, ticker))`,
  );
  const calSeed = [
    [day(1), 'Дивиденды', 'Дивиденды', 'confirmed', 'Сбербанк', 'SBER', JSON.stringify(['dividendy'])],
    [day(0), 'Отчётность по МСФО', 'МСФО', 'confirmed', 'Лукойл', 'LKOH', JSON.stringify(['obligatsii'])],
    [day(-1), 'Дивиденды (вчера)', 'Дивиденды', 'confirmed', 'Сбербанк', 'SBER', JSON.stringify(['dividendy'])],
    [day(1), 'Совет директоров', 'СД', 'expected', 'Яндекс', 'YDEX', JSON.stringify(['akcii'])],
  ];
  for (const [date, title, kind, status, company, ticker, tagIds] of calSeed) {
    await q(
      `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, tag_ids)
       VALUES ($1,'пн',$2,$3,$4,$5,$6,$7)`,
      [date, title, kind, status, company, ticker, tagIds],
    );
  }

  sqlite.saveDb();
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  return { ids, news, srvToday };
}

async function startServer(DIR, logBuf, extraEnv = {}) {
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...process.env,
      USE_SQLITE: 'true',
      SQLITE_FILE: `${DIR}/pulse.db`,
      UPLOADS_DIR: `${DIR}/uploads`,
      SIGNED_URL_SECRET: 'test',
      JWT_SECRET: 'test',
      STORAGE_MIN_FREE_PCT: '0',
      CRON_SECRET_KEY: 'test',
      PORT: String(PORT),
      NODE_ENV: 'test',
      ...extraEnv,
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
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(500);
  }
  throw new Error(`server did not become healthy: ${lastErr}\n${logBuf.join('')}`);
}

async function createPublishedCourse(adminJwt, title, tagIds) {
  let r = await api('POST', '/api/admin/education/courses', {
    token: adminJwt, body: { title, tag_ids: tagIds },
  });
  assert(r.status === 201, `POST courses → 201, got ${r.status} ${r.text}`);
  const course = r.json;
  r = await api('POST', `/api/admin/education/courses/${course.id}/lessons`, {
    token: adminJwt, body: { title: 'Урок 1', kind: 'text' },
  });
  assert(r.status === 201, `POST lesson → 201, got ${r.status}`);
  r = await api('POST', `/api/admin/education/courses/${course.id}/publish`, { token: adminJwt });
  assert(r.status === 200 && r.json.status === 'published', `publish → 200, got ${r.status} ${r.text}`);
  return course;
}

async function waitForSuggestions(adminJwt, courseId, minCount, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await api('GET', `/api/admin/education/courses/${courseId}/suggestions?status=pending`, { token: adminJwt });
    if (r.status === 200 && r.json.length >= minCount) return r.json;
    await sleep(500);
  }
  throw new Error(`suggestions для курса ${courseId} не появились за ${timeoutMs}мс`);
}

// ─── Прогон A: флаг выключен ────────────────────────────────────────────────
async function scenarioFlagOff() {
  console.log('\n═══════ ПРОГОН flagoff (EDUCATION_MATCH_ENABLED не задан) ═══════');
  const DIR = '/tmp/lms-match-smoke-flagoff';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const seed = await seedDatabase(DIR);
  const day = (offset) => new Date(new Date(`${seed.srvToday}T00:00:00Z`).getTime() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const adminJwt = jwt.sign({ userId: seed.ids.admin, email: 'admin@test.ru' }, 'test');

  const logBuf = [];
  const server = await startServer(DIR, logBuf);
  try {
    // Миграция идемпотентна (в SQLite — пропуск со skipped)
    let r = await api('POST', '/migrate-lms-matching?secret=test');
    assert(r.status === 200 && r.json.skipped === true, `migrate-lms-matching → 200 skipped, got ${r.status} ${r.text}`);
    r = await api('POST', '/migrate-lms-matching?secret=test');
    assert(r.status === 200, `повторный migrate-lms-matching → 200, got ${r.status}`);
    r = await api('POST', '/migrate-lms-matching?secret=wrong');
    assert(r.status === 403, `migrate-lms-matching с неверным secret → 403, got ${r.status}`);
    ok('миграция /migrate-lms-matching: идемпотентна, secret проверяется');

    // Публикация курса с тегами — триггеры мэтчинга no-op (флаг выключен)
    const course = await createPublishedCourse(adminJwt, 'Дивиденды (флаг off)', ['dividendy']);
    await sleep(1500);

    // Публичные эндпоинты задачи 7 → 404 (критерий 15)
    r = await api('GET', '/api/education/calendar-today');
    assert(r.status === 404, `calendar-today флаг off → 404, got ${r.status}`);
    r = await api('GET', `/api/education/for-event?date=${day(1)}&title=Дивиденды&kind=Дивиденды&ticker=SBER`);
    assert(r.status === 404, `for-event флаг off → 404, got ${r.status}`);
    r = await api('GET', `/api/education/courses/${course.slug}/events?days=14`);
    assert(r.status === 404, `courses/:slug/events флаг off → 404, got ${r.status}`);

    // Админские эндпоинты задач 4 и 7 → 404 (критерий 7)
    r = await api('GET', `/api/admin/education/courses/${course.id}/suggestions?status=pending`, { token: adminJwt });
    assert(r.status === 404, `suggestions флаг off → 404, got ${r.status}`);
    r = await api('POST', '/api/admin/education/suggestions/x/attach', { token: adminJwt, body: {} });
    assert(r.status === 404, `attach флаг off → 404, got ${r.status}`);
    r = await api('POST', '/api/admin/education/suggestions/x/dismiss', { token: adminJwt, body: {} });
    assert(r.status === 404, `dismiss флаг off → 404, got ${r.status}`);
    r = await api('GET', `/api/admin/education/courses/${course.id}/events-preview?days=14`, { token: adminJwt });
    assert(r.status === 404, `events-preview флаг off → 404, got ${r.status}`);
    ok('критерии 7/15: флаг off → 404 на всех эндпоинтах ТЗ-103');

    console.log(`\nПРОГОН flagoff: все ${passed} проверок зелёные`);
  } finally {
    server.kill('SIGTERM');
    await sleep(800);
  }
}

// ─── Прогон B: флаг включен ─────────────────────────────────────────────────
async function scenarioFlagOn() {
  console.log('\n═══════ ПРОГОН flagon (EDUCATION_MATCH_ENABLED=true) ═══════');
  const DIR = '/tmp/lms-match-smoke-flagon';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const seed = await seedDatabase(DIR);
  const { ids, news } = seed;
  const day = (offset) => new Date(new Date(`${seed.srvToday}T00:00:00Z`).getTime() + offset * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const adminJwt = jwt.sign({ userId: ids.admin, email: 'admin@test.ru' }, 'test');

  const logBuf = [];
  const server = await startServer(DIR, logBuf, { EDUCATION_MATCH_ENABLED: 'true' });
  try {
    // ── Ретроскан при публикации: suggestions по тег-матчу, score NULL ─────
    const divCourse = await createPublishedCourse(adminJwt, 'Дивиденды', ['dividendy']);
    let suggestions = await waitForSuggestions(adminJwt, divCourse.id, 2);
    const newsIds = suggestions.map((s) => s.news_id);
    assert(newsIds.includes(news.n1) && newsIds.includes(news.n2), 'suggestions содержат n1 и n2 (общий тег dividendy)');
    assert(!newsIds.includes(news.n4), 'n4 (акции, без общих тегов) отсутствует');
    for (const s of suggestions) {
      assert(s.match_source === 'tag', `source='tag' (LLM off), got ${s.match_source}`);
      assert(s.score === null, 'score NULL — «без LLM-оценки» (деградация без KIMI_API_KEY)');
      assert(typeof s.reason === 'string' && s.reason.includes('общий тег'), `reason «общий тег: …», got ${s.reason}`);
      assert(s.title_ru, 'join news отдаёт заголовок');
    }
    ok('критерии 2/8: publish → suggestions source=tag, score NULL, reason «общий тег»');

    // Второй курс — своя выборка
    const obCourse = await createPublishedCourse(adminJwt, 'Облигации', ['obligatsii']);
    const obSug = await waitForSuggestions(adminJwt, obCourse.id, 2);
    const obNewsIds = obSug.map((s) => s.news_id);
    assert(obNewsIds.includes(news.n2) && obNewsIds.includes(news.n3), 'Облигации: n2 и n3 (общий тег obligatsii)');
    ok('ретроскан второго курса: свои suggestions по своему тегу');

    // ── Attach: транзакция news_course_links + status=attached ─────────────
    const sug1 = suggestions.find((s) => s.news_id === news.n1);
    let r = await api('POST', `/api/admin/education/suggestions/${sug1.id}/attach`, { token: adminJwt, body: {} });
    assert(r.status === 200 && r.json.status === 'attached', `attach → 200, got ${r.status} ${r.text}`);
    r = await api('POST', `/api/admin/education/suggestions/${sug1.id}/attach`, { token: adminJwt, body: {} });
    assert(r.status === 200 && r.json.already_attached === true, 'повторный attach идемпотентен');
    r = await api('GET', `/api/admin/education/courses/${divCourse.id}/news-links`, { token: adminJwt });
    assert(r.json.some((n) => n.id === news.n1), 'news_course_links содержит прикреплённую новость');
    r = await api('GET', `/api/education/courses/${divCourse.slug}/news`);
    assert(r.json.some((n) => n.id === news.n1), 'публичная карточка курса показывает новость (после инвалидации кэша)');
    r = await api('GET', `/api/admin/education/courses/${divCourse.id}/suggestions?status=attached`, { token: adminJwt });
    assert(r.json.some((s) => s.id === sug1.id), 'status=attached в списке attached');
    ok('критерий 5: attach → news_course_links + публичная карточка курса');

    // ── Dismiss: повторный мэтчинг (re-publish → ретроскан) не воскрешает ──
    const sug2 = suggestions.find((s) => s.news_id === news.n2);
    r = await api('POST', `/api/admin/education/suggestions/${sug2.id}/dismiss`, { token: adminJwt, body: {} });
    assert(r.status === 200 && r.json.status === 'dismissed', `dismiss → 200, got ${r.status} ${r.text}`);
    r = await api('POST', `/api/admin/education/suggestions/${sug2.id}/dismiss`, { token: adminJwt, body: {} });
    assert(r.status === 200 && r.json.already_dismissed === true, 'повторный dismiss идемпотентен');
    r = await api('POST', `/api/admin/education/suggestions/${sug2.id}/attach`, { token: adminJwt, body: {} });
    assert(r.status === 409, `attach после dismiss... attached? нет — dismissed attachable/409, got ${r.status}`);
    // Прикреплённую dismiss'ом не открепляем: attach sug1 → dismiss → 409, новость осталась
    r = await api('POST', `/api/admin/education/suggestions/${sug1.id}/dismiss`, { token: adminJwt, body: {} });
    assert(r.status === 409, 'dismiss прикреплённой → 409');
    r = await api('GET', `/api/education/courses/${divCourse.slug}/news`);
    assert(r.json.some((n) => n.id === news.n1), 'после 409-dismiss прикреплённая новость на месте');
    // Повторный мэтчинг той же пары (ON CONFLICT DO NOTHING): ждём второй
    // ретроскан по логу (эмбеддинг-ретрай TEI занимает ~5с до старта скана)
    r = await api('POST', `/api/admin/education/courses/${divCourse.id}/publish`, { token: adminJwt });
    assert(r.status === 200, 're-publish → 200 (ретроскан ещё раз)');
    const retroDeadline = Date.now() + 25000;
    while (Date.now() < retroDeadline) {
      const scans = logBuf.join('').split('retroscan course').length - 1;
      if (scans >= 2) break;
      await sleep(500);
    }
    assert(logBuf.join('').split('retroscan course').length - 1 >= 2, 'второй ретроскан отработал');
    r = await api('GET', `/api/admin/education/courses/${divCourse.id}/suggestions?status=dismissed`, { token: adminJwt });
    assert(r.json.some((s) => s.id === sug2.id), 'dismissed-пара осталась dismissed');
    r = await api('GET', `/api/admin/education/courses/${divCourse.id}/suggestions?status=pending`, { token: adminJwt });
    assert(!r.json.some((s) => s.id === sug2.id), 'dismissed-пара не воскресла в pending');
    ok('критерий 6: dismiss не воскресает при повторном мэтчинге (ON CONFLICT)');

    // ── Календарный мэтчинг (критерии 11–14) ───────────────────────────────
    r = await api('GET', '/api/education/calendar-today');
    assert(r.status === 200, `calendar-today → 200, got ${r.status}`);
    let events = r.json.events;
    const divEvent = events.find((e) => e.title === 'Дивиденды');
    assert(divEvent, 'событие «Дивиденды» (завтра) с общим тегом есть в ответе');
    assert(divEvent.date === day(1), 'дата события — завтра (МСК)');
    const divMatch = divEvent.matched_courses.find((c) => c.slug === divCourse.slug);
    assert(divMatch, 'курс «Дивиденды» в matched_courses');
    assert(divMatch.matched_tags.includes('Дивиденды'), 'matched_tags содержит название общего тега');
    assert(divMatch.title && divMatch.type && typeof divMatch.price === 'number', 'мини-карточка курса полная');
    assert(events.some((e) => e.title === 'Отчётность по МСФО'), 'событие сегодня с общим тегом (obligatsii) есть');
    assert(!events.some((e) => e.title === 'Дивиденды (вчера)'), 'вчерашнее событие отсутствует');
    assert(!events.some((e) => e.title === 'Совет директоров'), 'событие без общих тегов (akcii) отсутствует');
    ok('критерий 11: calendar-today — события с курсами, без общих тегов/прошедшие отсутствуют');

    // Кэш: повторный запрос — без повторного compute (критерий 14)
    const body1 = JSON.stringify(r.json);
    r = await api('GET', '/api/education/calendar-today');
    assert(r.status === 200 && JSON.stringify(r.json) === body1, 'повторный calendar-today — тот же ответ');
    const computeCount = logBuf.join('').split('calendar-today computed').length - 1;
    assert(computeCount === 1, `кэш: один compute на два запроса, got ${computeCount}`);
    ok('критерий 14: повторный calendar-today без обращения к БД (кэш, 1 compute)');

    // Натуральный ключ for-event (критерий 12)
    r = await api('GET', `/api/education/for-event?date=${day(1)}&title=${encodeURIComponent('Дивиденды')}&kind=${encodeURIComponent('Дивиденды')}&ticker=SBER`);
    assert(r.status === 200 && r.json.courses.some((c) => c.slug === divCourse.slug), 'for-event натуральный ключ → 200 с курсом');
    assert(r.json.courses.length <= 3, 'не более 3 курсов на событие');
    r = await api('GET', `/api/education/for-event?date=${day(1)}&title=${encodeURIComponent('Дивиденды')}&kind=${encodeURIComponent('Дивиденды')}&ticker=WRONG`);
    assert(r.status === 404, 'for-event с несуществующим ключом → 404');
    r = await api('GET', `/api/education/for-event?date=${day(1)}&title=${encodeURIComponent('Дивиденды')}&kind=${encodeURIComponent('Дивиденды')}`);
    assert(r.status === 200 && r.json.courses.some((c) => c.slug === divCourse.slug), 'for-event без ticker → матч по date+title+kind (мультикомпанийские группы)');
    r = await api('GET', `/api/education/for-event?title=${encodeURIComponent('Дивиденды')}&kind=${encodeURIComponent('Дивиденды')}`);
    assert(r.status === 400, 'for-event без date → 400');
    ok('критерий 12: for-event натуральный ключ 200/404, ticker опционален');

    // Связанные события на странице курса
    r = await api('GET', `/api/education/courses/${divCourse.slug}/events?days=14`);
    assert(r.status === 200, `courses/:slug/events → 200, got ${r.status}`);
    events = r.json.events;
    assert(events.some((e) => e.title === 'Дивиденды' && e.date === day(1)), 'курс: завтрашнее дивидендное событие есть');
    assert(!events.some((e) => e.title === 'Дивиденды (вчера)'), 'курс: вчерашнее событие отсутствует');
    assert(!events.some((e) => e.title === 'Совет директоров'), 'курс: событие без общих тегов отсутствует');
    r = await api('GET', `/api/education/courses/${divCourse.slug}/events?days=abc`);
    assert(r.status === 200 && Array.isArray(r.json.events), 'days=abc → дефолт 14, 200');
    ok('courses/:slug/events: окно [сегодня; +14], прошедшие и без тегов отсутствуют');

    // Админский events-preview (критерий 13)
    r = await api('POST', '/api/admin/education/courses', {
      token: adminJwt, body: { title: 'Черновик без тегов' },
    });
    assert(r.status === 201, 'создание черновика → 201');
    const draftNoTags = r.json;
    r = await api('GET', `/api/admin/education/courses/${draftNoTags.id}/events-preview?days=14`, { token: adminJwt });
    assert(r.status === 200 && r.json.warning === 'no_tags' && r.json.events.length === 0,
      `курс без тегов → warning no_tags, got ${r.text}`);
    r = await api('GET', `/api/admin/education/courses/${divCourse.id}/events-preview?days=14`, { token: adminJwt });
    assert(r.status === 200 && r.json.events.some((e) => e.title === 'Дивиденды'), 'events-preview опубликованного курса');
    // Черновик с тегами тоже мэтчится (но в публичные ответы не попадает)
    r = await api('POST', '/api/admin/education/courses', {
      token: adminJwt, body: { title: 'Черновик с тегами', tag_ids: ['dividendy'] },
    });
    const draftWithTags = r.json;
    r = await api('GET', `/api/admin/education/courses/${draftWithTags.id}/events-preview?days=14`, { token: adminJwt });
    assert(r.status === 200 && r.json.events.some((e) => e.title === 'Дивиденды'), 'черновик с тегами мэтчится в preview');
    r = await api('GET', `/api/education/calendar-today`);
    const draftInPublic = r.json.events.some(
      (e) => e.matched_courses.some((c) => c.slug === draftWithTags.slug),
    );
    assert(!draftInPublic, 'черновик в публичный calendar-today не попадает');
    ok('критерий 13: events-preview — no_tags / черновик мэтчится, публично не светится');

    console.log(`\nПРОГОН flagon: все ${passed} проверок зелёные`);
  } finally {
    server.kill('SIGTERM');
    await sleep(800);
  }
}

const RUN_LABEL = process.argv[2];
if (!RUN_LABEL) {
  for (const [label, fn] of [['flagoff', scenarioFlagOff], ['flagon', scenarioFlagOn]]) {
    const res = spawnSync(process.execPath, [__filename, label], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`\nSMOKE FAIL на прогоне ${label}`);
      process.exit(1);
    }
  }
  console.log('\nSMOKE OK — оба прогона (флаг off/on) зелёные');
  process.exit(0);
}

(async () => {
  try {
    if (RUN_LABEL === 'flagoff') await scenarioFlagOff();
    else if (RUN_LABEL === 'flagon') await scenarioFlagOn();
    else throw new Error(`неизвестный прогон: ${RUN_LABEL}`);
    process.exit(0);
  } catch (e) {
    console.error('\nSMOKE FAIL:', e);
    process.exit(1);
  }
})();
