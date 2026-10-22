// Smoke: ТЗ-185 — самоотписка студента от курса
// (DELETE /api/education/courses/:slug/enroll).
// Запуск: npm run build && node scripts/smoke-unenroll.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Снапшоты enrollments/lesson_progress/user_events — из файла БД (sleep перед
// чтением: логирование fire-and-forget).
// Сценарии — ТЗ-185: free→204 (прогресс сохранён, идемпотентность), purchase→409
// (запись цела), subscription→204 + событие education.unenroll с source,
// гость→401, чужой курс без записи→204, архивный курс→204 (статус не проверяем).
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/unenroll-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/unenroll-smoke/pulse.db';
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

  // free — записан на бесплатный; purchased — куплен платный; sub — записан
  // по подписке; archived — записан на архивный курс; stranger — без записей.
  const ids = {
    free: uuid(), purchased: uuid(), sub: uuid(),
    archived: uuid(), stranger: uuid(),
  };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin,
                        subscription_plan, subscription_active, created_at) VALUES
     ($1,'free-un@test.ru','free','x',0,'free',0,datetime('now')),
     ($2,'purchased-un@test.ru','purchased','x',0,'free',0,datetime('now')),
     ($3,'sub-un@test.ru','sub','x',0,'premium',1,datetime('now')),
     ($4,'archived-un@test.ru','archived','x',0,'free',0,datetime('now')),
     ($5,'stranger-un@test.ru','stranger','x',0,'free',0,datetime('now'))`,
    [ids.free, ids.purchased, ids.sub, ids.archived, ids.stranger],
  );

  const C = {
    free: uuid(), paid: uuid(), subPaid: uuid(), archived: uuid(), empty: uuid(),
  };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES
     ($1,'Free','free-un',0,'published','public'),
     ($2,'Paid','paid-un',4900,'published','public'),
     ($3,'SubPaid','subpaid-un',4900,'published','public'),
     ($4,'Archived','archived-un',0,'archived','public'),
     ($5,'Empty','empty-un',0,'published','public')`,
    [C.free, C.paid, C.subPaid, C.archived, C.empty],
  );

  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source, created_at) VALUES
     ($1,$2,$3,'free',datetime('now')),
     ($4,$5,$6,'purchase',datetime('now')),
     ($7,$8,$9,'subscription',datetime('now')),
     ($10,$11,$12,'free',datetime('now'))`,
    [uuid(), ids.free, C.free,
     uuid(), ids.purchased, C.paid,
     uuid(), ids.sub, C.subPaid,
     uuid(), ids.archived, C.archived],
  );

  const L = { free1: uuid() };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title) VALUES ($1,$2,1,'Урок 1')`,
    [L.free1, C.free],
  );
  await q(
    `INSERT INTO lesson_progress (user_id, lesson_id, completed_at) VALUES ($1,$2,datetime('now'))`,
    [ids.free, L.free1],
  );

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
      UPLOADS_DIR: '/tmp/unenroll-smoke/uploads',
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
  console.log('\n═══════ SMOKE ТЗ-185: самоотписка от курса ═══════');
  fs.rmSync('/tmp/unenroll-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/unenroll-smoke/uploads', { recursive: true });

  const { ids, C, L } = await seedDatabase();
  const token = (id, email) => jwt.sign({ userId: id, email }, 'test');
  const freeJwt = token(ids.free, 'free-un@test.ru');
  const purchasedJwt = token(ids.purchased, 'purchased-un@test.ru');
  const subJwt = token(ids.sub, 'sub-un@test.ru');
  const archivedJwt = token(ids.archived, 'archived-un@test.ru');
  const strangerJwt = token(ids.stranger, 'stranger-un@test.ru');

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Бесплатный курс: DELETE → 204, запись удалена, прогресс сохранён
    let r = await api('DELETE', `/api/education/courses/free-un/enroll`, { token: freeJwt });
    assert(r.status === 204, `DELETE free → 204, got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(600);
    let enr = await rowsOf(
      `SELECT source FROM course_enrollments WHERE user_id = ? AND course_id = ?`,
      ids.free, C.free);
    assert(enr.length === 0, `enrollment удалён: ${JSON.stringify(enr)}`);
    const prog = await rowsOf(
      `SELECT lesson_id FROM lesson_progress WHERE user_id = ?`, ids.free);
    assert(prog.length === 1 && prog[0].lesson_id === L.free1,
      `прогресс сохранён: ${JSON.stringify(prog)}`);
    ok('1a: бесплатный курс → 204, enrollment удалён, прогресс на месте');

    // Повторный DELETE → 204 (идемпотентно)
    r = await api('DELETE', `/api/education/courses/free-un/enroll`, { token: freeJwt });
    assert(r.status === 204, `повторный DELETE → 204, got ${r.status} ${r.text.slice(0, 200)}`);
    enr = await rowsOf(
      `SELECT source FROM course_enrollments WHERE user_id = ? AND course_id = ?`,
      ids.free, C.free);
    assert(enr.length === 0, `enrollment по-прежнему отсутствует: ${JSON.stringify(enr)}`);
    ok('1b: повторный DELETE → 204, идемпотентно');

    // ── 2. Купленный курс: DELETE → 409, запись цела
    r = await api('DELETE', `/api/education/courses/paid-un/enroll`, { token: purchasedJwt });
    assert(r.status === 409 && /Курс куплен/.test(r.json?.message || r.text),
      `DELETE purchase → 409 «Курс куплен», got ${r.status} ${r.text.slice(0, 200)}`);
    enr = await rowsOf(
      `SELECT source FROM course_enrollments WHERE user_id = ? AND course_id = ?`,
      ids.purchased, C.paid);
    assert(enr.length === 1 && enr[0].source === 'purchase',
      `enrollment purchase цел: ${JSON.stringify(enr)}`);
    ok('2: купленный курс → 409, enrollment не тронут');

    // ── 3. Подписочный курс: DELETE → 204 + событие education.unenroll с source
    r = await api('DELETE', `/api/education/courses/subpaid-un/enroll`, { token: subJwt });
    assert(r.status === 204, `DELETE subscription → 204, got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(600);
    enr = await rowsOf(
      `SELECT source FROM course_enrollments WHERE user_id = ? AND course_id = ?`,
      ids.sub, C.subPaid);
    assert(enr.length === 0, `enrollment subscription удалён: ${JSON.stringify(enr)}`);
    const ev = await rowsOf(
      `SELECT event_data FROM user_events WHERE user_id = ? AND event_type = 'education.unenroll'`,
      ids.sub);
    assert(ev.length === 1, `событие education.unenroll ровно 1: ${JSON.stringify(ev)}`);
    const evData = JSON.parse(ev[0].event_data);
    assert(evData.course_id === C.subPaid && evData.source === 'subscription',
      `unenroll {course_id, source='subscription'}: ${ev[0].event_data}`);
    ok('3: подписочный курс → 204, enrollment удалён, событие education.unenroll с source');

    // ── 4. Гость → 401
    r = await api('DELETE', `/api/education/courses/free-un/enroll`, {});
    assert(r.status === 401, `DELETE без токена → 401, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('4: гость → 401');

    // ── 5. Записи нет (чужой курс) → 204, без утечки информации
    r = await api('DELETE', `/api/education/courses/paid-un/enroll`, { token: strangerJwt });
    assert(r.status === 204, `DELETE чужого курса без записи → 204, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('5: курс без записи → 204 (идемпотентно, без IDOR-утечки)');

    // ── 6. Архивный курс: отписка разрешена (статус не проверяем) → 204
    r = await api('DELETE', `/api/education/courses/archived-un/enroll`, { token: archivedJwt });
    assert(r.status === 204, `DELETE архивного курса → 204, got ${r.status} ${r.text.slice(0, 200)}`);
    await sleep(600);
    enr = await rowsOf(
      `SELECT source FROM course_enrollments WHERE user_id = ? AND course_id = ?`,
      ids.archived, C.archived);
    assert(enr.length === 0, `enrollment архивного курса удалён: ${JSON.stringify(enr)}`);
    ok('6: архивный курс → 204 (статус публикации не блокирует отписку)');

    // ── 7. Несуществующий курс → 404
    r = await api('DELETE', `/api/education/courses/no-such-course/enroll`, { token: freeJwt });
    assert(r.status === 404, `DELETE несуществующего курса → 404, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('7: несуществующий курс → 404');

    console.log(`\nOK ${passed}: все проверки ТЗ-185 пройдены`);
  } finally {
    server.kill('SIGTERM');
  }
}

scenario().catch((err) => {
  console.error('\nTZ185 FAIL:', err.message);
  process.exit(1);
});
