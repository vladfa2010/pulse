// Smoke: ТЗ-195 — «Статистика шеринга уроков» (меджик-линк).
// (GET /admin/education/stats/overview + GET /admin/education/courses/:id/stats —
//  блок sharing из lesson_shares; converted_at атрибуции регистрации).
// Запуск: npm run build && node scripts/smoke-share-stats.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Критерии приёмки ТЗ: сводка за 30/7 дней (создано/открыто/просрочено/
// конверсии/rate), топ-5 курсов сводной, топ-5 уроков детальной,
// курс без шеринга → честные нули, не-админ → 403, attribution пишет converted_at.
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/share-stats-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/share-stats-smoke/pulse.db';
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

function uuid() { return crypto.randomUUID(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const futureIso = (daysAhead) => new Date(Date.now() + daysAhead * 86400000).toISOString();

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

  const ids = { admin: uuid(), user: uuid() };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin,
                        subscription_plan, subscription_active, created_at) VALUES
     ($1,'admin-ss@test.ru','admin','x',1,'free',0,$3),
     ($2,'user-ss@test.ru','user','x',0,'free',0,$3)`,
    [ids.admin, ids.user, iso(60)],
  );

  const C = { paid: uuid(), free: uuid(), empty: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, type) VALUES
     ($1,'Paid курс','paid-ss',4900,'published','course'),
     ($2,'Free курс','free-ss',0,'published','course'),
     ($3,'Empty курс','empty-ss',4900,'published','course')`,
    [C.paid, C.free, C.empty],
  );

  const L = { p1: uuid(), p2: uuid(), f1: uuid() };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, text_content, is_free_preview) VALUES
     ($1,$2,1,'Первый урок','<p>Текст</p>',0),
     ($3,$2,2,'Второй урок','<p>Текст</p>',0),
     ($4,$5,1,'Бесплатный урок','<p>Текст</p>',1)`,
    [L.p1, C.paid, L.p2, L.f1, C.free],
  );

  // lesson_shares: даты ISO-параметрами (NOW() не кросс-диалектен).
  // Раскладка (days=30):
  //   created = a1..a4,a0 (5 paid) + b1,b3 (2 free) = 7… плюс b2 вне периода.
  //   opened  = a1,a2,a4 + b1 = 4;  expired = a3 = 1;  conversions = a1,a4,b1 = 3.
  //   rate = 3/4 = 0.75;  топ курсов: paid 5, free 2.
  // Для C.paid (30d): created 5 (paid 5/free 0), opened 3, conv 2, rate 0.67;
  //   топ уроков: p1 = 3 ссылки/2 открытия/1 конверсия, p2 = 2/1/1.
  const share = (lesson, course, createdAgo, usedAgo, convertedAgo, isFree, expiresInDays) =>
    q(
      `INSERT INTO lesson_shares
         (id, token, lesson_id, course_id, owner_user_id, created_at, expires_at,
          used_at, used_ip, converted_user_id, converted_at, is_free)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'127.0.0.1',$9,$10,$11)`,
      [
        uuid(), crypto.randomBytes(24).toString('hex'), lesson, course, ids.user,
        iso(createdAgo), futureIso(expiresInDays ?? 1),
        usedAgo == null ? null : iso(usedAgo),
        convertedAgo == null ? null : ids.user,
        convertedAgo == null ? null : iso(convertedAgo),
        isFree ? 1 : 0,
      ],
    );
  await share(L.p1, C.paid, 5, 3, 2, false);        // a1
  await share(L.p1, C.paid, 10, 9, null, false);    // a2
  await share(L.p2, C.paid, 8, null, null, false, -2); // a3: просрочена (used_at NULL)
  await share(L.p2, C.paid, 6, 4, 4, false);        // a4
  await share(L.p1, C.paid, 4, null, null, false);  // a0: не открыта, не просрочена
  await share(L.f1, C.free, 20, 15, 12, true);      // b1
  await share(L.f1, C.free, 40, 35, null, true);    // b2: вне периода 30d
  await share(L.f1, C.free, 2, null, null, true);   // b3

  sqlite.saveDb();
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/dist/')) delete require.cache[m];
  }
  return { ids, C, L };
}

async function startServer(logBuf) {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  env.RESEND_API_KEY = '';
  env.EMAIL_PROVIDER = '';
  env.TELEGRAM_BOT_TOKEN = '';
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...env,
      USE_SQLITE: 'true',
      SQLITE_FILE: DB_FILE,
      UPLOADS_DIR: '/tmp/share-stats-smoke/uploads',
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

const tokenOf = (url) => {
  const m = /\/share\/lesson\/([0-9a-f]{48})/.exec(url || '');
  return m ? m[1] : null;
};

async function scenario() {
  console.log('\n═══════ SMOKE ТЗ-195: статистика шеринга уроков ═══════');
  fs.rmSync('/tmp/share-stats-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/share-stats-smoke/uploads', { recursive: true });

  const { ids, C, L } = await seedDatabase();
  const token = (id, email) => jwt.sign({ userId: id, email }, 'test');
  const adminJwt = token(ids.admin, 'admin-ss@test.ru');
  const userJwt = token(ids.user, 'user-ss@test.ru');

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Сводная за 30 дней: сверка каждой метрики
    let r = await api('GET', '/api/admin/education/stats/overview?days=30', { token: adminJwt });
    assert(r.status === 200, `overview → 200, got ${r.status} ${r.text.slice(0, 300)}`);
    let sh = r.json.sharing;
    assert(sh, `sharing в ответе: ${r.text.slice(0, 300)}`);
    assert(sh.links_created === 7, `links_created=7, got ${sh.links_created}`);
    assert(sh.links_created_paid === 5, `links_created_paid=5, got ${sh.links_created_paid}`);
    assert(sh.links_created_free === 2, `links_created_free=2, got ${sh.links_created_free}`);
    assert(sh.links_opened === 4, `links_opened=4, got ${sh.links_opened}`);
    assert(sh.links_expired === 1, `links_expired=1, got ${sh.links_expired}`);
    assert(sh.conversions === 3, `conversions=3, got ${sh.conversions}`);
    assert(sh.conversion_rate === 0.75, `conversion_rate=0.75, got ${sh.conversion_rate}`);
    assert(Array.isArray(sh.top_courses) && sh.top_courses.length === 2,
      `top_courses: 2 курса, got ${JSON.stringify(sh.top_courses)}`);
    assert(sh.top_courses[0].course_id === C.paid && sh.top_courses[0].links_created === 5,
      `топ-1 курс paid с 5 ссылками: ${JSON.stringify(sh.top_courses[0])}`);
    assert(sh.top_courses[1].course_id === C.free && sh.top_courses[1].links_created === 2,
      `топ-2 курс free с 2 ссылками: ${JSON.stringify(sh.top_courses[1])}`);
    ok('1: overview ?days=30 — все метрики sharing сверены (7/5/2, 4 открытия, 1 просрочка, 3 конверсии, rate 0.75, топ курсов)');

    // ── 2. Сводная за 7 дней: период применяется к дате события
    r = await api('GET', '/api/admin/education/stats/overview?days=7', { token: adminJwt });
    assert(r.status === 200, `overview 7d → 200, got ${r.status}`);
    sh = r.json.sharing;
    assert(sh.links_created === 4, `7d links_created=4, got ${sh.links_created}`);
    assert(sh.links_created_free === 1, `7d links_created_free=1, got ${sh.links_created_free}`);
    assert(sh.links_opened === 2, `7d links_opened=2, got ${sh.links_opened}`);
    assert(sh.links_expired === 1, `7d links_expired=1 (просрочка по expires_at), got ${sh.links_expired}`);
    assert(sh.conversions === 2, `7d conversions=2, got ${sh.conversions}`);
    assert(sh.conversion_rate === 1, `7d conversion_rate=1 (2/2), got ${sh.conversion_rate}`);
    assert(sh.top_courses[0].course_id === C.paid && sh.top_courses[0].links_created === 3,
      `7d топ-1: paid с 3 ссылками, got ${JSON.stringify(sh.top_courses[0])}`);
    ok('2: overview ?days=7 — период по дате события (старые строки не протекают)');

    // ── 3. Детальная статистика курса с шерингом
    r = await api('GET', `/api/admin/education/courses/${C.paid}/stats?days=30`, { token: adminJwt });
    assert(r.status === 200, `course stats → 200, got ${r.status} ${r.text.slice(0, 300)}`);
    sh = r.json.sharing;
    assert(sh.links_created === 5 && sh.links_created_paid === 5 && sh.links_created_free === 0,
      `курс paid created 5/5/0, got ${JSON.stringify(sh)}`);
    assert(sh.links_opened === 3, `курс paid opened=3, got ${sh.links_opened}`);
    assert(sh.conversions === 2, `курс paid conversions=2, got ${sh.conversions}`);
    assert(sh.conversion_rate === 0.67, `курс paid rate=0.67 (2/3), got ${sh.conversion_rate}`);
    assert(sh.top_lessons.length === 2, `топ уроков: 2, got ${JSON.stringify(sh.top_lessons)}`);
    const tl1 = sh.top_lessons[0];
    assert(tl1.lesson_id === L.p1 && tl1.links_created === 3 && tl1.links_opened === 2 && tl1.conversions === 1,
      `урок p1: 3 ссылки/2 открытия/1 конверсия, got ${JSON.stringify(tl1)}`);
    const tl2 = sh.top_lessons[1];
    assert(tl2.lesson_id === L.p2 && tl2.links_created === 2 && tl2.links_opened === 1 && tl2.conversions === 1,
      `урок p2: 2 ссылки/1 открытие/1 конверсия, got ${JSON.stringify(tl2)}`);
    ok('3: courses/:id/stats ?days=30 — метрики и топ-5 уроков курса сверены');

    // ── 4. Бесплатный курс: только free-ссылки
    r = await api('GET', `/api/admin/education/courses/${C.free}/stats?days=30`, { token: adminJwt });
    sh = r.json.sharing;
    assert(sh.links_created === 2 && sh.links_created_free === 2 && sh.links_created_paid === 0,
      `курс free created 2/0/2, got ${JSON.stringify(sh)}`);
    assert(sh.links_opened === 1 && sh.conversions === 1 && sh.conversion_rate === 1,
      `курс free opened=1, conv=1, rate=1, got ${JSON.stringify(sh)}`);
    assert(sh.top_lessons.length === 1 && sh.top_lessons[0].lesson_id === L.f1,
      `топ уроков free: 1 урок, got ${JSON.stringify(sh.top_lessons)}`);
    ok('4: courses/:id/stats бесплатного курса — free-ссылки и конверсия b1 (b2 вне периода)');

    // ── 5. Курс без шеринга — честные нули, 200
    r = await api('GET', `/api/admin/education/courses/${C.empty}/stats`, { token: adminJwt });
    assert(r.status === 200, `пустой курс → 200, got ${r.status}`);
    sh = r.json.sharing;
    assert(sh.links_created === 0 && sh.links_opened === 0 && sh.conversions === 0,
      `нулевые метрики, got ${JSON.stringify(sh)}`);
    assert(sh.conversion_rate === null, `rate null при 0 открытий, got ${sh.conversion_rate}`);
    assert(Array.isArray(sh.top_lessons) && sh.top_lessons.length === 0,
      `пустой топ уроков, got ${JSON.stringify(sh.top_lessons)}`);
    ok('5: курс без шеринга → 200, нули, conversion_rate null, пустой топ');

    // ── 6. Доступ: не-админ → 403, без токена → 401
    r = await api('GET', '/api/admin/education/stats/overview', { token: userJwt });
    assert(r.status === 403, `overview не-админ → 403, got ${r.status}`);
    r = await api('GET', `/api/admin/education/courses/${C.paid}/stats`, { token: userJwt });
    assert(r.status === 403, `course stats не-админ → 403, got ${r.status}`);
    r = await api('GET', '/api/admin/education/stats/overview');
    assert(r.status === 401, `overview без токена → 401, got ${r.status}`);
    ok('6: не-админ → 403, гость → 401 на оба эндпоинта');

    // ── 7. Атрибуция регистрации пишет converted_at (ТЗ-195)
    r = await api('POST', `/api/education/lessons/${L.p1}/share`, { token: adminJwt });
    assert(r.status === 201 && r.json.url, `share → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    const tConv = tokenOf(r.json.url);
    r = await api('GET', `/api/education/shared-lessons/${tConv}`);
    assert(r.status === 200, `открытие конверсионной ссылки → 200, got ${r.status}`);
    const regEmail = `conv-ss-${Date.now()}@test.ru`;
    r = await api('POST', `/api/auth/register`, {
      body: { email: regEmail, username: `convss${Date.now() % 100000}`, password: 'password123', share_token: tConv },
    });
    assert(r.status === 201 && r.json.token, `register с токеном → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(800);
    const convRow = await rowsOf(`SELECT converted_user_id, converted_at FROM lesson_shares WHERE token = ?`, tConv);
    assert(convRow[0]?.converted_user_id === r.json.user.id && !!convRow[0]?.converted_at,
      `converted_user_id + converted_at заполнены: ${JSON.stringify(convRow)}`);
    ok('7: регистрация по меджик-линку → converted_user_id и converted_at в lesson_shares');

    console.log(`\nOK ${passed}: все проверки ТЗ-195 пройдены`);
  } finally {
    server.kill('SIGTERM');
  }
}

scenario().catch((err) => {
  console.error('\nTZ195 FAIL:', err.message);
  process.exit(1);
});
