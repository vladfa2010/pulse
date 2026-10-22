// Smoke: ТЗ-184 — автозапись на курс при первом осмысленном действии
// (POST /lessons/:id/test и POST /lessons/:id/complete).
// Запуск: npm run build && node scripts/smoke-lms-auto-enroll.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Снапшоты enrollments/user_events — из файла БД (sleep перед чтением:
// логирование fire-and-forget).
// Сценарии — Задача 4 ТЗ: free/подписка/пейвол × test/complete, события
// education.enroll_auto, идемпотентность и гонка двух параллельных POST.
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/lms-auto-enroll-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/lms-auto-enroll-smoke/pulse.db';
const PORT = 3996;
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

const enrollmentsOf = (userId) =>
  rowsOf('SELECT course_id, source FROM course_enrollments WHERE user_id = ?', userId);
const enrollAutoEventsOf = (userId) =>
  rowsOf(`SELECT event_data FROM user_events WHERE user_id = ? AND event_type = 'education.enroll_auto'`, userId);

async function seedDatabase() {
  process.env.SQLITE_FILE = DB_FILE;
  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  const q = sqlite.query;

  // studentFree — без подписки и записей; studentSub — активная premium;
  // studentNoSub — без подписки; studentRace — для гонки; studentComplete —
  // для complete-триггера на втором бесплатном курсе.
  const ids = {
    admin: uuid(), free: uuid(), sub: uuid(), nosub: uuid(),
    race: uuid(), complete: uuid(),
  };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin,
                        subscription_plan, subscription_active, created_at) VALUES
     ($1,'admin-ae@test.ru','admin','x',1,'free',0,datetime('now')),
     ($2,'free-ae@test.ru','free','x',0,'free',0,datetime('now')),
     ($3,'sub-ae@test.ru','sub','x',0,'premium',1,datetime('now')),
     ($4,'nosub-ae@test.ru','nosub','x',0,'free',0,datetime('now')),
     ($5,'race-ae@test.ru','race','x',0,'free',0,datetime('now')),
     ($6,'complete-ae@test.ru','complete','x',0,'free',0,datetime('now'))`,
    [ids.admin, ids.free, ids.sub, ids.nosub, ids.race, ids.complete],
  );

  const C = { freeA: uuid(), freeB: uuid(), paid: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES
     ($1,'Free A','free-a-ae',0,'published','public'),
     ($2,'Free B','free-b-ae',0,'published','public'),
     ($3,'Paid','paid-ae',4900,'published','public')`,
    [C.freeA, C.freeB, C.paid],
  );

  // Тариф платного курса — premium (для ветки subscription).
  // subscription_unlock_mode='drip' — на курсе (колонка courses, не урока).
  await q(
    `INSERT INTO subscription_plans (id, name, tag_limit, portfolio_limit) VALUES ('premium','Premium',50,5)`,
    [],
  );
  await q(
    `INSERT INTO course_tariffs (course_id, plan_id) VALUES ($1,'premium')`,
    [C.paid],
  );
  await q(
    `UPDATE courses SET subscription_unlock_mode = 'drip' WHERE id = $1`,
    [C.paid],
  );

  const L = {
    freeATest: uuid(), freeAPlain: uuid(),
    freeBPlain: uuid(),
    paidTestDrip: uuid(), paidPlain: uuid(),
  };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,1,'A: урок с тестом',1)`,
    [L.freeATest, C.freeA],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,2,'A: обычный урок',0)`,
    [L.freeAPlain, C.freeA],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,1,'B: обычный урок',1)`,
    [L.freeBPlain, C.freeB],
  );
  // Платный курс: drip-урок с тестом (unlock_after_days=7, tenure=0 у свежего юзера;
  // режим drip задан на курсе — subscription_unlock_mode в courses)
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview, unlock_after_days)
     VALUES ($1,$2,1,'P: drip-урок с тестом',0,7)`,
    [L.paidTestDrip, C.paid],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,2,'P: обычный урок',0)`,
    [L.paidPlain, C.paid],
  );

  // Тесты: 2 вопроса, pass_score 50, правильные ответы — индекс 1
  const testRow = (lessonId) => q(
    `INSERT INTO lesson_tests (id, lesson_id, questions, pass_score, is_blocking)
     VALUES ($1,$2,$3,50,0)`,
    [uuid(), lessonId, JSON.stringify([
      { q: '2+2?', options: ['3', '4'], correct: 1 },
      { q: 'Столица РФ?', options: ['Казань', 'Москва'], correct: 1 },
    ])],
  );
  await testRow(L.freeATest);
  await testRow(L.paidTestDrip);

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
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...process.env,
      USE_SQLITE: 'true',
      SQLITE_FILE: DB_FILE,
      UPLOADS_DIR: '/tmp/lms-auto-enroll-smoke/uploads',
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
  console.log('\n═══════ SMOKE ТЗ-184: автозапись на курс ═══════');
  fs.rmSync('/tmp/lms-auto-enroll-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/lms-auto-enroll-smoke/uploads', { recursive: true });

  const { ids, C, L } = await seedDatabase();
  const token = (id, email) => jwt.sign({ userId: id, email }, 'test');
  const freeJwt = token(ids.free, 'free-ae@test.ru');
  const subJwt = token(ids.sub, 'sub-ae@test.ru');
  const nosubJwt = token(ids.nosub, 'nosub-ae@test.ru');
  const raceJwt = token(ids.race, 'race-ae@test.ru');
  const completeJwt = token(ids.complete, 'complete-ae@test.ru');
  const ANSWERS = [1, 1];

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Бесплатный курс: /test → автозапись source='free', событие, идемпотентность
    let r = await api('POST', `/api/education/lessons/${L.freeATest}/test`, { token: freeJwt, body: { answers: ANSWERS } });
    assert(r.status === 200 && r.json.passed === true, `/test на free → 200 passed, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.auto_enrolled === true, `auto_enrolled:true в ответе, got ${JSON.stringify(r.json)}`);
    await sleep(600);
    let enr = await enrollmentsOf(ids.free);
    assert(enr.length === 1 && enr[0].course_id === C.freeA && enr[0].source === 'free',
      `enrollment source='free': ${JSON.stringify(enr)}`);
    let ev = await enrollAutoEventsOf(ids.free);
    assert(ev.length === 1, `enroll_auto ровно 1: ${JSON.stringify(ev)}`);
    let evData = JSON.parse(ev[0].event_data);
    assert(evData.course_id === C.freeA && evData.source === 'free' && evData.trigger === 'test',
      `enroll_auto {trigger:'test'}: ${ev[0].event_data}`);
    ok('1a: бесплатный курс, /test → 200, auto_enrolled, enrollment source=free, событие enroll_auto trigger=test');

    r = await api('POST', `/api/education/lessons/${L.freeATest}/test`, { token: freeJwt, body: { answers: ANSWERS } });
    assert(r.status === 200 && r.json.auto_enrolled === undefined, `повторный /test → 200 без auto_enrolled, got ${r.text.slice(0, 200)}`);
    await sleep(600);
    enr = await enrollmentsOf(ids.free);
    ev = await enrollAutoEventsOf(ids.free);
    assert(enr.length === 1 && ev.length === 1, `повторный POST: запись одна, событий не больше: ${JSON.stringify({ enr, ev })}`);
    ok('1b: повторный /test — идемпотентно, новых enrollment/событий нет');

    // ── 2. Бесплатный курс: /complete → автозапись trigger='complete'
    r = await api('POST', `/api/education/lessons/${L.freeBPlain}/complete`, { token: completeJwt, body: {} });
    assert(r.status === 200 && r.json.ok === true, `/complete на free → 200, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.auto_enrolled === true, `auto_enrolled:true у /complete, got ${JSON.stringify(r.json)}`);
    await sleep(600);
    enr = await enrollmentsOf(ids.complete);
    assert(enr.length === 1 && enr[0].source === 'free', `enrollment source='free' (complete): ${JSON.stringify(enr)}`);
    ev = await enrollAutoEventsOf(ids.complete);
    assert(ev.length === 1 && JSON.parse(ev[0].event_data).trigger === 'complete',
      `enroll_auto trigger='complete': ${JSON.stringify(ev)}`);
    const prog = await rowsOf('SELECT lesson_id FROM lesson_progress WHERE user_id = ?', ids.complete);
    assert(prog.length === 1 && prog[0].lesson_id === L.freeBPlain, `прогресс записан: ${JSON.stringify(prog)}`);
    ok('2: бесплатный курс, /complete → 200, auto_enrolled, enrollment source=free, событие trigger=complete, прогресс в БД');

    // ── 3. Платный курс + подписка: автозапись source='subscription', drip-гейт сохранён
    r = await api('POST', `/api/education/lessons/${L.paidTestDrip}/test`, { token: subJwt, body: { answers: ANSWERS } });
    assert(r.status === 403 && r.json.error === 'locked_by_drip',
      `drip-урок → 403 locked_by_drip, got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(600);
    enr = await enrollmentsOf(ids.sub);
    assert(enr.length === 1 && enr[0].course_id === C.paid && enr[0].source === 'subscription',
      `автозапись source='subscription' есть: ${JSON.stringify(enr)}`);
    ev = await enrollAutoEventsOf(ids.sub);
    const subEv = await rowsOf(
      `SELECT event_type FROM user_events WHERE user_id = ? AND event_type = 'education.enroll_subscribed'`, ids.sub);
    assert(ev.length === 1 && subEv.length === 1,
      `enroll_auto + enroll_subscribed залогированы: ${JSON.stringify({ ev, subEv })}`);
    ok('3: платный+подписка → автозапись source=subscription, но drip → 403 locked_by_drip (гейт не ослаблен)');

    r = await api('POST', `/api/education/lessons/${L.paidPlain}/complete`, { token: subJwt, body: {} });
    assert(r.status === 200 && r.json.auto_enrolled === undefined,
      `/complete на платном после автозаписи → 200 без auto_enrolled, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('3b: /complete на платном курсе с записью → штатный 200');

    // ── 4. Платный курс без подписки: прежний 403, записи нет
    r = await api('POST', `/api/education/lessons/${L.paidTestDrip}/test`, { token: nosubJwt, body: { answers: ANSWERS } });
    assert(r.status === 403 && /Запишитесь на курс/.test(r.json.message || r.text),
      `платный без подписки /test → 403 «Запишитесь на курс», got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('POST', `/api/education/lessons/${L.paidPlain}/complete`, { token: nosubJwt, body: {} });
    assert(r.status === 403 && /Запишитесь на курс/.test(r.json.message || r.text),
      `платный без подписки /complete → 403 «Запишитесь на курс», got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(600);
    enr = await enrollmentsOf(ids.nosub);
    assert(enr.length === 0, `enrollment не создан: ${JSON.stringify(enr)}`);
    ev = await enrollAutoEventsOf(ids.nosub);
    assert(ev.length === 0, `enroll_auto не логировался: ${JSON.stringify(ev)}`);
    ok('4: платный без подписки → прежний 403 на /test и /complete, записи и событий нет');

    // ── 5. Гонка: два параллельных /test → один enrollment, оба 200
    const [r1, r2] = await Promise.all([
      api('POST', `/api/education/lessons/${L.freeATest}/test`, { token: raceJwt, body: { answers: ANSWERS } }),
      api('POST', `/api/education/lessons/${L.freeATest}/test`, { token: raceJwt, body: { answers: ANSWERS } }),
    ]);
    assert(r1.status === 200 && r2.status === 200, `оба параллельных /test → 200: ${r1.status}/${r2.status}`);
    await sleep(600);
    enr = await enrollmentsOf(ids.race);
    assert(enr.length === 1, `ровно один enrollment при гонке: ${JSON.stringify(enr)}`);
    ev = await enrollAutoEventsOf(ids.race);
    assert(ev.length >= 1 && ev.length <= 2, `событий 1–2 (гонка допустима, дублей записи нет): ${ev.length}`);
    ok('5: гонка двух параллельных /test → оба 200, enrollment ровно один');

    console.log(`\nOK ${passed}: все проверки ТЗ-184 пройдены`);
  } finally {
    server.kill('SIGTERM');
  }
}

scenario().catch((err) => {
  console.error('\nTZ184 FAIL:', err.message);
  process.exit(1);
});
