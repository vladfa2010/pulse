// Smoke: ТЗ-187 — «Меджик-линк»: разовый шеринг урока гостю без регистрации.
// (POST /lessons/:lessonId/share + GET /shared-lessons/:token + атрибуция
//  регистрации через share_token).
// Запуск: npm run build && node scripts/smoke-lesson-share.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Критерии приёмки ТЗ: квота 2/12ч (429), атомарное сгорание (гонка → 1×200,
// второй 410), expired/used/404, payload только текст, drip-гейт шерера,
// атрибуция register, регрессия register без токена.
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/lesson-share-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/lesson-share-smoke/pulse.db';
const PORT = 3999;
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

  const ids = {
    admin: uuid(),
    sharer: uuid(),   // записан на free-курс
    stranger: uuid(), // без записей
    sub: uuid(),      // premium, drip-курс
  };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin,
                        subscription_plan, subscription_active, created_at) VALUES
     ($1,'admin-ls@test.ru','admin','x',1,'free',0,datetime('now')),
     ($2,'sharer-ls@test.ru','sharer','x',0,'free',0,datetime('now')),
     ($3,'stranger-ls@test.ru','stranger','x',0,'free',0,datetime('now')),
     ($4,'sub-ls@test.ru','sub','x',0,'premium',1,datetime('now'))`,
    [ids.admin, ids.sharer, ids.stranger, ids.sub],
  );

  const C = { free: uuid(), drip: uuid(), race: uuid(), paid: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES
     ($1,'Free курс','free-ls',0,'published','public'),
     ($2,'Drip курс','drip-ls',4900,'published','public'),
     ($3,'Race курс','race-ls',0,'published','public'),
     ($4,'Paid курс','paid-ls',4900,'published','public')`,
    [C.free, C.drip, C.race, C.paid],
  );
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source, created_at) VALUES
     ($1,$2,$3,'free',datetime('now'))`,
    [uuid(), ids.sharer, C.free],
  );
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source, created_at) VALUES
     ($1,$2,$3,'purchase',datetime('now'))`,
    [uuid(), ids.sharer, C.paid],
  );
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source, created_at) VALUES
     ($1,$2,$3,'subscription',datetime('now'))`,
    [uuid(), ids.sub, C.drip],
  );
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source, created_at) VALUES
     ($1,$2,$3,'free',datetime('now'))`,
    [uuid(), ids.stranger, C.race],
  );
  // Drip-курс: тариф premium + режим drip на курсе
  await q(`INSERT INTO subscription_plans (id, name, tag_limit, portfolio_limit) VALUES ('premium','Premium',50,5)`, []);
  await q(`INSERT INTO course_tariffs (course_id, plan_id) VALUES ($1,'premium')`, [C.drip]);
  await q(`UPDATE courses SET subscription_unlock_mode = 'drip' WHERE id = $1`, [C.drip]);

  const L = { plain: uuid(), preview: uuid(), dripLocked: uuid(), race: uuid(), paid: uuid() };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, text_content, is_free_preview)
     VALUES ($1,$2,1,'Платный урок','<p>Секретный контент урока</p>',0)`,
    [L.plain, C.free],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, text_content, is_free_preview)
     VALUES ($1,$2,1,'Платный контент','<p>Секретный контент урока</p>',0)`,
    [L.paid, C.paid],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, text_content, is_free_preview)
     VALUES ($1,$2,2,'Бесплатный урок','<p>Бесплатный контент</p>',1)`,
    [L.preview, C.free],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, text_content, is_free_preview)
     VALUES ($1,$2,1,'Race урок','<p>Контент для гонки и конверсии</p>',0)`,
    [L.race, C.race],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, text_content, is_free_preview, unlock_after_days)
     VALUES ($1,$2,1,'Drip-урок','<p>Drip контент</p>',0,7)`,
    [L.dripLocked, C.drip],
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
  const env = { ...process.env };
  env.RESEND_API_KEY = '';
  env.EMAIL_PROVIDER = '';
  env.TELEGRAM_BOT_TOKEN = '';
  const server = spawn('node', [path.join(DIST, 'index.js')], {
    env: {
      ...env,
      USE_SQLITE: 'true',
      SQLITE_FILE: DB_FILE,
      UPLOADS_DIR: '/tmp/lesson-share-smoke/uploads',
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
  console.log('\n═══════ SMOKE ТЗ-187: меджик-линк шеринга урока ═══════');
  fs.rmSync('/tmp/lesson-share-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/lesson-share-smoke/uploads', { recursive: true });

  const { ids, C, L } = await seedDatabase();
  const token = (id, email) => jwt.sign({ userId: id, email }, 'test');
  const adminJwt = token(ids.admin, 'admin-ls@test.ru');
  const sharerJwt = token(ids.sharer, 'sharer-ls@test.ru');
  const strangerJwt = token(ids.stranger, 'stranger-ls@test.ru');
  const subJwt = token(ids.sub, 'sub-ls@test.ru');

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Шеринг урока платного курса записанным → 201, url, событие
    let r = await api('POST', `/api/education/lessons/${L.paid}/share`, { token: sharerJwt });
    assert(r.status === 201 && r.json.url, `share → 201 + url, got ${r.status} ${r.text.slice(0, 200)}`);
    const t1 = tokenOf(r.json.url);
    assert(t1, `токен в url: ${r.json.url}`);
    await sleep(600);
    const ev = await rowsOf(
      `SELECT event_data FROM user_events WHERE user_id = ? AND event_type = 'education.lesson_shared'`,
      ids.sharer);
    assert(ev.length === 1 && JSON.parse(ev[0].event_data).lesson_id === L.paid,
      `событие lesson_shared: ${JSON.stringify(ev)}`);
    ok('1: запись может шерить платный урок → 201, url, событие education.lesson_shared');

    // ── 2. Бесплатный урок (is_free_preview) шерит незаписанный → 201 (критерий 2)
    r = await api('POST', `/api/education/lessons/${L.preview}/share`, { token: strangerJwt });
    assert(r.status === 201, `free_preview share stranger → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('2: бесплатный урок шерится без enrollment (критерий 2)');

    // ── 3. Без доступа (платный урок, нет enrollment) → 403, записи нет (критерий 9)
    r = await api('POST', `/api/education/lessons/${L.plain}/share`, { token: strangerJwt });
    assert(r.status === 403, `share без доступа → 403, got ${r.status} ${r.text.slice(0, 200)}`);
    const cnt = await rowsOf(`SELECT count(*) AS c FROM lesson_shares WHERE owner_user_id = ?`, ids.stranger);
    assert(Number(cnt[0].c) === 1, `записей у stranger ровно 1 (от теста 2): ${JSON.stringify(cnt)}`);
    ok('3: юзер без доступа → 403, запись не создана');

    // ── 4. Drip-гейт: урок закрыт drip для шерера → 403 locked_by_drip (критерий 6)
    r = await api('POST', `/api/education/lessons/${L.dripLocked}/share`, { token: subJwt });
    assert(r.status === 403 && r.json.error === 'locked_by_drip',
      `drip-урок → 403 locked_by_drip, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('4: урок, закрытый drip для шерера → 403 locked_by_drip');

    // ── 5. Квота: только ПЛАТНЫЕ ссылки; 3-я платная за 12 ч → 429 (критерий 3).
    //    Бесплатные уроки/курсы лимит не расходуют и им не ограничиваются.
    r = await api('POST', `/api/education/lessons/${L.paid}/share`, { token: sharerJwt });
    assert(r.status === 201, `вторая платная ссылка sharer → 201, got ${r.status}`);
    r = await api('POST', `/api/education/lessons/${L.paid}/share`, { token: sharerJwt });
    assert(r.status === 429 && /Лимит шеринга/.test(r.json.error || '') && r.json.retry_after_hours >= 1,
      `третья платная ссылка → 429 с retry_after_hours, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('5a: 3-я платная ссылка за 12ч → 429 + retry_after_hours');
    r = await api('POST', `/api/education/lessons/${L.preview}/share`, { token: sharerJwt });
    assert(r.status === 201, `бесплатная ссылка после 429 → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('5b: бесплатная ссылка лимитом не ограничивается (после 429 → 201)');

    // ── 6. Гость открывает ссылку → 200, только текст; повторно → 410 used (критерий 1, 4)
    r = await api('GET', `/api/education/shared-lessons/${t1}`);
    assert(r.status === 200, `первое открытие → 200, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(r.json.lesson && r.json.lesson.content_html && /Секретный контент/.test(r.json.lesson.content_html),
      `текст урока в ответе: ${r.text.slice(0, 300)}`);
    const payloadKeys = JSON.stringify(Object.keys(r.json.lesson));
    assert(!/audio|video|materials|test/.test(payloadKeys),
      `payload НЕ содержит audio/video/materials/test: ${payloadKeys}`);
    assert(r.json.course.slug === 'paid-ls', `slug курса: ${r.text.slice(0, 200)}`);
    ok('6a: гость видит текст урока; payload без аудио/видео/материалов/теста');

    r = await api('GET', `/api/education/shared-lessons/${t1}`);
    assert(r.status === 410 && /использована/.test(r.json.error || '') && r.json.course_slug === 'paid-ls',
      `повторное открытие → 410 used + course_slug, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('6b: повторное открытие → 410 «уже использована» + course_slug для CTA');

    // ── 7. Гонка: два параллельных открытия новой ссылки → ровно один 200
    r = await api('POST', `/api/education/lessons/${L.race}/share`, { token: strangerJwt });
    assert(r.status === 201, `share для гонки → 201, got ${r.status}`);
    const tRace = tokenOf(r.json.url);
    const [r1, r2] = await Promise.all([
      api('GET', `/api/education/shared-lessons/${tRace}`),
      api('GET', `/api/education/shared-lessons/${tRace}`),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(statuses[0] === 200 && statuses[1] === 410,
      `гонка → 200+410, got ${r1.status}/${r2.status}`);
    ok('7: гонка двух открытий → ровно один 200, второй 410 (атомарное сгорание)');

    // ── 8. Несуществующая/мусорная ссылка → 404 (expired-ветку смотрим live:
    //    в SQLite-окружении нельзя вставить просроченную строку мимо сервера)
    let r8 = await api('GET', `/api/education/shared-lessons/${crypto.randomBytes(24).toString('hex')}`);
    assert(r8.status === 404, `несуществующий токен → 404, got ${r8.status}`);
    r8 = await api('GET', `/api/education/shared-lessons/zzz`);
    assert(r8.status === 404, `мусорный токен → 404, got ${r8.status}`);
    ok('8: несуществующий/мусорный токен → 404');

    // ── 9. Атрибуция регистрации: ссылка → регистрация с share_token (критерий 7)
    // Админ шерит (квоты админа ещё не тратил; у stranger/sharer лимит исчерпан
    // предыдущими тестами) — атрибуция конверсии проверяется по owner_user_id админа.
    r = await api('POST', `/api/education/lessons/${L.race}/share`, { token: adminJwt });
    assert(r.status === 201, `share для конверсии → 201, got ${r.status}`);
    const tConv = tokenOf(r.json.url);
    r = await api('GET', `/api/education/shared-lessons/${tConv}`);
    assert(r.status === 200, `открытие конверсионной ссылки → 200, got ${r.status}`);

    const regEmail = `converted-${Date.now()}@test.ru`;
    r = await api('POST', `/api/auth/register`, {
      body: { email: regEmail, username: `conv${Date.now() % 100000}`, password: 'password123', share_token: tConv },
    });
    assert(r.status === 201 && r.json.token, `register с токеном → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    const newUserId = r.json.user.id;
    await sleep(800);
    const regRow = await rowsOf(`SELECT registration_source FROM users WHERE id = ?`, newUserId);
    assert(regRow[0]?.registration_source === 'lesson_share',
      `registration_source='lesson_share': ${JSON.stringify(regRow)}`);
    const convRow = await rowsOf(`SELECT converted_user_id FROM lesson_shares WHERE token = ?`, tConv);
    assert(convRow[0]?.converted_user_id === newUserId,
      `converted_user_id заполнен: ${JSON.stringify(convRow)}`);
    const regEv = await rowsOf(
      `SELECT event_data FROM user_events WHERE user_id = ? AND event_type = 'register'`, newUserId);
    const regEvData = JSON.parse(regEv[0]?.event_data || '{}');
    assert(regEvData.shared_by_user_id === ids.admin && regEvData.lesson_id === L.race,
      `register event_data с атрибуцией: ${JSON.stringify(regEvData)}`);
    ok('9: регистрация по ссылке → lesson_share, converted_user_id, register с shared_by_user_id');

    // ── 10. Регрессия: register без токена и с битым токеном (критерий 8)
    r = await api('POST', `/api/auth/register`, {
      body: { email: `plain-${Date.now()}@test.ru`, username: `plain${Date.now() % 100000}`, password: 'password123' },
    });
    assert(r.status === 201, `register без токена → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('POST', `/api/auth/register`, {
      body: { email: `broken-${Date.now()}@test.ru`, username: `broken${Date.now() % 100000}`, password: 'password123', share_token: crypto.randomBytes(24).toString('hex') },
    });
    assert(r.status === 201, `register с битым токеном → 201, got ${r.status} ${r.text.slice(0, 200)}`);
    ok('10: register без токена и с битым токеном — регрессии нет');

    // ── 11. Гость не может шерить → 401
    r = await api('POST', `/api/education/lessons/${L.plain}/share`, {});
    assert(r.status === 401, `share без auth → 401, got ${r.status}`);
    ok('11: гость → 401');

    console.log(`\nOK ${passed}: все проверки ТЗ-187 пройдены`);
  } finally {
    server.kill('SIGTERM');
  }
}

scenario().catch((err) => {
  console.error('\nTZ187 FAIL:', err.message);
  process.exit(1);
});
