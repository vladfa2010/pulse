// Smoke: ТЗ-179 — события обучения в user_events
// (course_started / lesson_started / material_downloaded / test_attempt).
// Запуск: npm run build && node scripts/smoke-lms-events.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Проверки событий — снапшотами файла БД (сервер saveDb после каждой записи;
// логирование fire-and-forget, поэтому перед чтением — sleep).
// Сценарии — Задача 5 ТЗ: старт урока/курса с дедупом, кросс-курсовый
// course_started, free-preview с source='preview' и молчание анонимов/админов,
// material_downloaded только после гейтов, две попытки теста = два события.
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/lms-events-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/lms-events-smoke/pulse.db';
const PORT = 3997;
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

// Снапшот событий юзера из файла БД (отдельное in-memory соединение sql.js —
// сервер ходит в своём, конфликтов нет).
async function eventsOf(userId) {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_FILE));
  const stmt = db.prepare(
    'SELECT event_type, event_data FROM user_events WHERE user_id = ? ORDER BY created_at, rowid',
  );
  stmt.bind([userId]);
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

  const ids = { admin: uuid(), student: uuid(), student2: uuid() };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin) VALUES
     ($1,'admin@test.ru','admin','x',1),($2,'student@test.ru','student','x',0),
     ($3,'student2@test.ru','student2','x',0)`,
    [ids.admin, ids.student, ids.student2],
  );

  const C = { paid: uuid(), second: uuid(), preview: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES
     ($1,'Платный курс','paid-kurs',4900,'published','public'),
     ($2,'Второй курс','second-kurs',0,'published','public'),
     ($3,'Курс с превью','preview-kurs',4900,'published','public')`,
    [C.paid, C.second, C.preview],
  );

  const L = { paid1: uuid(), paid2: uuid(), second1: uuid(), preview1: uuid() };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,1,'П1 урок 1',0)`,
    [L.paid1, C.paid],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,2,'П1 урок 2',0)`,
    [L.paid2, C.paid],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,1,'Второй урок 1',0)`,
    [L.second1, C.second],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, is_free_preview) VALUES ($1,$2,1,'Превью урок',1)`,
    [L.preview1, C.preview],
  );

  // Тест у платного урока 1: 2 вопроса, pass_score 50
  await q(
    `INSERT INTO lesson_tests (id, lesson_id, questions, pass_score, is_blocking) VALUES ($1,$2,$3,50,0)`,
    [uuid(), L.paid1, JSON.stringify([
      { q: '2+2?', options: ['3', '4'], correct: 1 },
      { q: 'Столица РФ?', options: ['Казань', 'Москва'], correct: 1 },
    ])],
  );

  // Материалы: free-файл на платном курсе, платный файл на платном курсе
  const M = { freeFile: uuid(), paidFile: uuid() };
  await q(
    `INSERT INTO course_materials (id, course_id, kind, title, url, is_free, status) VALUES ($1,$2,'file','free.pdf','/uploads/free.pdf',1,'approved')`,
    [M.freeFile, C.paid],
  );
  await q(
    `INSERT INTO course_materials (id, course_id, kind, title, url, is_free, status) VALUES ($1,$2,'file','paid.pdf','/uploads/paid.pdf',0,'approved')`,
    [M.paidFile, C.paid],
  );

  // student записан на платный курс покупкой; student2 — никуда не записан
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source) VALUES ($1,$2,$3,'purchase')`,
    [uuid(), ids.student, C.paid],
  );

  sqlite.saveDb();
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/dist/')) delete require.cache[m];
  }
  return { ids, C, L, M };
}

async function startServer(logBuf) {
  const { spawn } = require('child_process');
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...process.env,
      USE_SQLITE: 'true',
      SQLITE_FILE: DB_FILE,
      UPLOADS_DIR: '/tmp/lms-events-smoke/uploads',
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
  console.log('\n═══════ SMOKE ТЗ-179: события обучения ═══════');
  fs.rmSync('/tmp/lms-events-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/lms-events-smoke/uploads', { recursive: true });

  const { ids, C, L, M } = await seedDatabase();
  const studentJwt = jwt.sign({ userId: ids.student, email: 'student@test.ru' }, 'test');
  const student2Jwt = jwt.sign({ userId: ids.student2, email: 'student2@test.ru' }, 'test');
  const adminJwt = jwt.sign({ userId: ids.admin, email: 'admin@test.ru' }, 'test');

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Первый GET урока → lesson_started + course_started ────────────
    let r = await api('GET', `/api/education/lessons/${L.paid1}`, { token: studentJwt });
    assert(r.status === 200, `GET урока → 200, got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(600); // fire-and-forget логирование
    let ev = await eventsOf(ids.student);
    let started = ev.filter((e) => e.event_type === 'education.lesson_started');
    let courseSt = ev.filter((e) => e.event_type === 'education.course_started');
    assert(started.length === 1, `lesson_started ровно 1: ${JSON.stringify(ev)}`);
    assert(courseSt.length === 1, `course_started ровно 1: ${JSON.stringify(ev)}`);
    const lsData = JSON.parse(started[0].event_data);
    assert(lsData.lesson_id === L.paid1 && lsData.course_id === C.paid && lsData.position === 1,
      `lesson_started data: ${started[0].event_data}`);
    const csData = JSON.parse(courseSt[0].event_data);
    assert(csData.course_id === C.paid && csData.source === 'purchase',
      `course_started source='purchase': ${courseSt[0].event_data}`);
    ok('1a: первый GET урока → lesson_started {course,lesson,position} + course_started source=purchase');

    r = await api('GET', `/api/education/lessons/${L.paid1}`, { token: studentJwt });
    assert(r.status === 200, 'повторный GET → 200');
    await sleep(600);
    ev = await eventsOf(ids.student);
    assert(ev.filter((e) => e.event_type === 'education.lesson_started').length === 1
      && ev.filter((e) => e.event_type === 'education.course_started').length === 1,
      `дедуп после повторного GET: ${JSON.stringify(ev.map((e) => e.event_type))}`);
    ok('1b: повторный GET — дедуп, новых событий нет');

    r = await api('GET', `/api/education/lessons/${L.paid2}`, { token: studentJwt });
    assert(r.status === 200, 'GET урока 2 → 200');
    await sleep(600);
    ev = await eventsOf(ids.student);
    assert(ev.filter((e) => e.event_type === 'education.lesson_started').length === 2,
      `lesson_started × 2: ${JSON.stringify(ev.map((e) => e.event_type))}`);
    assert(ev.filter((e) => e.event_type === 'education.course_started').length === 1,
      'course_started всё ещё 1 (тот же курс)');
    ok('1c: урок 2 того же курса → lesson_started, course_started не дублируется');

    // ── 2. Урок второго курса → снова course_started ─────────────────────
    r = await api('GET', `/api/education/lessons/${L.second1}`, { token: studentJwt });
    assert(r.status === 403, `без записи на второй курс → 403, got ${r.status}`);
    r = await api('POST', '/api/education/courses/second-kurs/enroll', { token: studentJwt });
    assert(r.status === 200 || r.status === 201 || r.status === 409,
      `self-enroll бесплатный курс → 2xx/409, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('GET', `/api/education/lessons/${L.second1}`, { token: studentJwt });
    assert(r.status === 200, 'после записи GET → 200');
    await sleep(600);
    ev = await eventsOf(ids.student);
    const csAll = ev.filter((e) => e.event_type === 'education.course_started');
    assert(csAll.length === 2, `course_started × 2 (разные курсы): ${csAll.length}`);
    const cs2 = JSON.parse(csAll[1].event_data);
    assert(cs2.course_id === C.second && cs2.source === 'free',
      `course_started курса 2 source='free': ${csAll[1].event_data}`);
    ok('2: 403 до записи; после self-enroll → свой course_started (source=free, привязка к курсу)');

    // ── 3. Free-preview без записи + молчание анонимов/админов ───────────
    r = await api('GET', `/api/education/lessons/${L.preview1}`, { token: student2Jwt });
    assert(r.status === 200, `free-preview залогиненному → 200, got ${r.status}`);
    await sleep(600);
    ev = await eventsOf(ids.student2);
    const s2ls = ev.filter((e) => e.event_type === 'education.lesson_started');
    assert(s2ls.length === 1, `lesson_started × 1: ${JSON.stringify(ev)}`);
    const s2cs = ev.filter((e) => e.event_type === 'education.course_started');
    assert(s2cs.length === 1 && JSON.parse(s2cs[0].event_data).source === 'preview',
      `course_started source='preview': ${JSON.stringify(ev)}`);
    ok('3a: free-preview без записи → lesson_started + course_started source=preview');

    r = await api('GET', `/api/education/lessons/${L.preview1}`);
    assert(r.status === 200, 'анониму free-preview → 200');
    await sleep(600);
    ev = await eventsOf(ids.student2);
    assert(ev.length === 2, `новых событий у student2 нет (аноним не логируется): ${JSON.stringify(ev.map((e) => e.event_type))}`);
    ok('3b: анонимный просмотр free-preview — событий нет');

    r = await api('GET', `/api/education/lessons/${L.paid1}`, { token: adminJwt });
    assert(r.status === 200, 'админу урок → 200');
    await sleep(600);
    ev = await eventsOf(ids.admin);
    assert(ev.length === 0, `админ не логируется: ${JSON.stringify(ev)}`);
    ok('3c: админский проход по гейтам — событий нет');

    // ── 4. material_downloaded после гейтов ──────────────────────────────
    r = await api('GET', `/api/education/materials/${M.paidFile}/download`, { token: student2Jwt });
    assert(r.status === 403, `платный файл без записи → 403, got ${r.status}`);
    await sleep(600);
    ev = await eventsOf(ids.student2);
    assert(!ev.some((e) => e.event_type === 'education.material_downloaded'),
      '403-скачивание не логируется');
    ok('4a: 403-скачивание → material_downloaded нет');

    r = await api('GET', `/api/education/materials/${M.freeFile}/download`, { token: student2Jwt });
    assert(r.status === 302, `free-файл → 302, got ${r.status}`);
    await sleep(600);
    ev = await eventsOf(ids.student2);
    const md = ev.filter((e) => e.event_type === 'education.material_downloaded');
    assert(md.length === 1, `material_downloaded × 1: ${JSON.stringify(ev.map((e) => e.event_type))}`);
    const mdData = JSON.parse(md[0].event_data);
    assert(mdData.material_id === M.freeFile && mdData.course_id === C.paid && mdData.kind === 'file',
      `material_downloaded data: ${md[0].event_data}`);
    assert(!('title' in mdData), 'title в event_data не кладём');
    ok('4b: free-файл → material_downloaded {course,material,kind}, без title');

    r = await api('GET', `/api/education/materials/${M.paidFile}/download`, { token: studentJwt });
    assert(r.status === 302, `платный файл enrolled → 302, got ${r.status}`);
    await sleep(600);
    ev = await eventsOf(ids.student);
    assert(ev.filter((e) => e.event_type === 'education.material_downloaded').length === 1,
      'enrolled-скачивание залогировано');
    ok('4c: enrolled-скачивание платного файла → material_downloaded');

    r = await api('GET', `/api/education/materials/${M.freeFile}/download`);
    assert(r.status === 302, `анониму free-файл → 302, got ${r.status}`);
    await sleep(600);
    ev = await eventsOf(ids.student2);
    assert(ev.filter((e) => e.event_type === 'education.material_downloaded').length === 1,
      'гостевое is_free-скачивание структурно не логируется');
    ok('4d: анонимное is_free-скачивание → события нет (осознанная слепая зона)');

    // ── 5. Два грейдинга → два test_attempt ──────────────────────────────
    r = await api('POST', `/api/education/lessons/${L.paid1}/test`, {
      token: studentJwt, body: { answers: [1, 1] },
    });
    assert(r.status === 200 && r.json.test_score === 100 && r.json.passed === true,
      `грейдинг 1 → 200: ${r.text}`);
    r = await api('POST', `/api/education/lessons/${L.paid1}/test`, {
      token: studentJwt, body: { answers: [0, 1] },
    });
    assert(r.status === 200 && r.json.test_score === 50 && r.json.passed === true,
      `грейдинг 2 → 200: ${r.text}`);
    await sleep(600);
    ev = await eventsOf(ids.student);
    const ta = ev.filter((e) => e.event_type === 'education.test_attempt');
    assert(ta.length === 2, `test_attempt × 2: ${JSON.stringify(ev.map((e) => e.event_type))}`);
    const ta1 = JSON.parse(ta[0].event_data);
    const ta2 = JSON.parse(ta[1].event_data);
    assert(ta1.score === 100 && ta1.pass_score === 50 && ta1.passed === true && ta1.lesson_id === L.paid1,
      `попытка 1: ${ta[0].event_data}`);
    assert(ta2.score === 50 && ta2.passed === true && ta2.course_id === C.paid,
      `попытка 2: ${ta[1].event_data}`);
    ok('5: два POST грейдинга → два test_attempt с динамикой score (100→50)');

    console.log('\nSMOKE: все проверки зелёные');
  } finally {
    server.kill('SIGTERM');
    await new Promise((r2) => setTimeout(r2, 800));
  }
}

(async () => {
  try {
    await scenario();
    console.log('\nSMOKE OK — ТЗ-179: события обучения (4 типа, дедуп, гейты)');
    process.exit(0);
  } catch (e) {
    console.error('\nSMOKE FAIL:', e);
    process.exit(1);
  }
})();
