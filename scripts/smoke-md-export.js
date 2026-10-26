// Smoke: ТЗ-191 — «Экспорт курса в MD»: эндпоинты export-md и round-trip
// (экспортированный файл проходит import-md ТЗ-159 и даёт семантически тот
// же курс: тексты, таблицы, chart-block, callout/html-block, кнопки, тест,
// video_url, длительность, is_free, unlock_days).
// Запуск: npm run build && node scripts/smoke-md-export.js
//
// HTTP-сценарий против дочернего сервера (dist/index.js, SQLite/sql.js).
// Критерии ТЗ: оба эндпоинта, RFC 5987 имя файла, round-trip, границы
// (404/400/401/403), аудит-событие education.course_exported.
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/md-export-smoke/uploads';

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');

const DIST = path.join(__dirname, '..', 'dist');
const DB_FILE = '/tmp/md-export-smoke/pulse.db';
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
  if (opts.form) {
    body = opts.form; // FormData — Content-Type выставит fetch сам
  } else if (opts.body !== undefined) {
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
  return { status: res.status, json, text, headers: res.headers };
}

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
     ($1,'admin-me@test.ru','admin','x',1,'free',0,datetime('now')),
     ($2,'user-me@test.ru','user','x',0,'free',0,datetime('now'))`,
    [ids.admin, ids.user],
  );

  const C = { src: uuid(), dst: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, description, price, status, type) VALUES
     ($1,'Тестовый курс','src-me','<p>Описание <b>курса</b> для экспорта.</p>',4900,'published','course'),
     ($2,'Пустой черновик','dst-me','',0,'draft','course')`,
    [C.src, C.dst],
  );

  const L = { full: uuid(), video: uuid() };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, kind, text_content,
                                 video_embed_url, duration_min, is_free_preview,
                                 unlock_after_days, buttons)
     VALUES ($1,$2,1,'Урок #1: Основы','video_text',$3,
             'https://www.youtube.com/embed/abc123',15,1,3,$4)`,
    [
      L.full, C.src,
      '<p>Вводный <b>текст</b> урока.</p>' +
        '<ul><li>пункт 1</li><li>пункт 2</li></ul>' +
        '<table><thead><tr><th>Тикер</th><th>Цена</th></tr></thead><tbody><tr><td>SBER</td><td>300</td></tr></tbody></table>' +
        '<div class="callout">Важная выноска с <b>жирным</b></div>' +
        '<div class="chart-block" data-ticker="SBER" data-exchange="MOEX" data-name="Сбер" data-tf="D1" data-range="3M" data-width="80%"></div>' +
        '<div class="html-block"><p>Произвольный <i>HTML</i> блок</p></div>' +
        '<p><img src="/media/abc123.png" alt="Схема"></p>',
      JSON.stringify([
        { label: 'Купить', url: 'https://example.com/buy', color: 'violet', target: 'new_tab' },
        { label: 'Подробнее', url: '/education/x', color: 'accent', target: 'self' },
      ]),
    ],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, kind, text_content,
                                 video_embed_url, duration_min, is_free_preview,
                                 unlock_after_days, buttons)
     VALUES ($1,$2,2,'Только видео','video',NULL,
             'https://player.vimeo.com/video/123',NULL,0,0,'[]')`,
    [L.video, C.src],
  );
  await q(
    `INSERT INTO lesson_tests (id, lesson_id, pass_score, is_blocking, questions) VALUES
     ($1,$2,80,1,$3)`,
    [
      uuid(), L.full,
      JSON.stringify([
        { q: '2+2?', options: ['3', '4', '5'], correct: 1 },
        { q: 'Столица РФ?', options: ['Москва', 'Питер'], correct: 0 },
      ]),
    ],
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
      UPLOADS_DIR: '/tmp/md-export-smoke/uploads',
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
  console.log('\n═══════ SMOKE ТЗ-191: экспорт курса в MD (round-trip) ═══════');
  fs.rmSync('/tmp/md-export-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/md-export-smoke/uploads', { recursive: true });

  const { ids, C, L } = await seedDatabase();
  const token = (id, email) => jwt.sign({ userId: id, email }, 'test');
  const adminJwt = token(ids.admin, 'admin-me@test.ru');
  const userJwt = token(ids.user, 'user-me@test.ru');

  const logBuf = [];
  const server = await startServer(logBuf);
  try {
    // ── 1. Экспорт всего курса: заголовки + структура
    let r = await api('GET', `/api/admin/education/courses/${C.src}/export-md`, { token: adminJwt });
    assert(r.status === 200, `export → 200, got ${r.status} ${r.text.slice(0, 200)}`);
    assert(r.headers.get('content-type').includes('text/markdown'), `Content-Type: ${r.headers.get('content-type')}`);
    const cd = r.headers.get('content-disposition') || '';
    assert(cd.startsWith('attachment; filename*=UTF-8') && /%D0%9A%D1%83%D1%80%D1%81/.test(cd),
      `Content-Disposition RFC 5987 с кириллицей: ${cd}`);
    const courseMd = r.text;
    assert(courseMd.includes('Описание **курса** для экспорта'), `преамбула-описание в файле`);
    assert(courseMd.includes('# Урок ＃1: Основы'), `# в заголовке → ＃: ${courseMd.split('\n').filter(l => l.startsWith('#')).join(' | ')}`);
    assert(/---\nis_free: true\nvideo_url: "https:\/\/www\.youtube\.com\/embed\/abc123"\nduration_min: 15\nunlock_days: 3\n---/.test(courseMd),
      `фронтматтер L1 значимый: ${courseMd.slice(0, 600)}`);
    assert(courseMd.includes(':::chart ticker=SBER exchange=MOEX name="Сбер" tf=D1 range=3M width=80%'),
      `:::chart с data-атрибутами`);
    assert(courseMd.includes(':::button label="Купить" url=https://example.com/buy color=violet target=new_tab'),
      `:::button 1`);
    assert(courseMd.includes(':::test pass=80 blocking=true') && courseMd.includes('? 2+2?') && courseMd.includes('- (x) 4'),
      `:::test: pass/blocking, вопросы, один (x)`);
    assert(courseMd.includes('<div class="callout">Важная выноска с <b>жирным</b></div>'), `callout — сырой HTML`);
    assert(courseMd.includes('<div class="html-block">'), `html-block — сырой HTML`);
    assert(courseMd.includes('![Схема](/media/abc123.png)'), `img /media`);
    assert(courseMd.includes('| Тикер | Цена |'), `GFM-таблица`);
    assert(courseMd.indexOf('# Урок ＃1') < courseMd.indexOf('# Только видео'), `уроки по position`);
    ok('1: export-md курса — заголовки RFC 5987, преамбула, фронтматтер, :::chart/:::button/:::test, raw HTML, GFM-таблица');

    // ── 2. Экспорт одного урока: без преамбулы, имя «Урок N — …»
    r = await api('GET', `/api/admin/education/courses/${C.src}/export-md?lesson_id=${L.full}`, { token: adminJwt });
    assert(r.status === 200, `lesson export → 200, got ${r.status}`);
    const cd2 = r.headers.get('content-disposition') || '';
    assert(/Урок/.test(decodeURIComponent(cd2)) && cd2.includes('md'), `имя файла урока: ${cd2}`);
    const lessonMd = r.text;
    assert(lessonMd.startsWith('# Урок ＃1: Основы'), `один урок начинается с H1, без преамбулы`);
    assert(!lessonMd.includes('Описание **курса**'), `преамбулы нет`);
    ok('2: export-md?lesson_id — один урок без преамбулы, имя «Урок N — …»');

    // ── 3. Round-trip: файл целиком проходит import-md в пустой черновик
    const form = new FormData();
    form.append('file', new Blob([courseMd], { type: 'text/markdown' }), 'export.md');
    r = await api('POST', `/api/admin/education/courses/${C.dst}/import-md`, { token: adminJwt, form });
    assert(r.status === 201 && r.json.created === 2, `import → 201, created=2, got ${r.status} ${r.text.slice(0, 400)}`);
    assert(r.json.description_updated === true, `description_updated: ${r.text.slice(0, 300)}`);
    await sleep(600);

    const dstR = await api('GET', `/api/admin/education/courses/${C.dst}`, { token: adminJwt });
    assert(dstR.status === 200, `карточка курса B → 200`);
    const dst = dstR.json;
    assert(/Описание/.test(dst.description) && /курса/.test(dst.description), `описание B семантически то же: ${dst.description}`);
    const bLessons = dst.lessons;
    assert(bLessons.length === 2, `уроков в B: 2, got ${bLessons.length}`);
    const b1 = bLessons[0];
    assert(b1.title === 'Урок ＃1: Основы', `заголовок B1 (＃): ${b1.title}`);
    assert(b1.video_embed_url === 'https://www.youtube.com/embed/abc123', `video_url: ${b1.video_embed_url}`);
    assert(Number(b1.duration_min) === 15, `duration_min: ${b1.duration_min}`);
    assert(Number(b1.is_free_preview) === 1 || b1.is_free_preview === true, `is_free: ${b1.is_free_preview}`);
    assert(Number(b1.unlock_after_days) === 3, `unlock_days: ${b1.unlock_after_days}`);
    assert(b1.text_content.includes('chart-block') && b1.text_content.includes('data-ticker="SBER"') &&
      b1.text_content.includes('data-exchange="MOEX"') && b1.text_content.includes('data-tf="d1"') &&
      b1.text_content.includes('data-range="3M"') && b1.text_content.includes('data-width="80%"'),
      `chart-block вернулся с атрибутами: ${b1.text_content.match(/<div[^>]*chart-block[^>]*>/)?.[0]}`);
    assert(/<table>/.test(b1.text_content) && /Сбер|SBER/.test(b1.text_content), `таблица вернулась`);
    assert(b1.text_content.includes('callout'), `callout вернулся`);
    assert(b1.text_content.includes('html-block'), `html-block вернулся`);
    assert(b1.text_content.includes('/media/abc123.png'), `картинка /media вернулась`);
    assert(b1.text_content.includes('Важная выноска'), `тексты на месте`);
    const b1Buttons = typeof b1.buttons === 'string' ? JSON.parse(b1.buttons) : b1.buttons;
    assert(Array.isArray(b1Buttons) && b1Buttons.length === 2 &&
      b1Buttons[0].label === 'Купить' && b1Buttons[0].color === 'violet' && b1Buttons[0].target === 'new_tab' &&
      b1Buttons[1].url === '/education/x' && b1Buttons[1].target === 'self',
      `кнопки: ${JSON.stringify(b1Buttons)}`);
    assert(b1.test && Number(b1.test.pass_score) === 80 && (b1.test.is_blocking === true || Number(b1.test.is_blocking) === 1),
      `тест pass/blocking: ${JSON.stringify(b1.test).slice(0, 200)}`);
    const b1q = typeof b1.test.questions === 'string' ? JSON.parse(b1.test.questions) : b1.test.questions;
    assert(b1q.length === 2 && b1q[0].q === '2+2?' && b1q[0].correct === 1 && b1q[1].options.length === 2,
      `вопросы: ${JSON.stringify(b1q)}`);
    const b2 = bLessons[1];
    assert(b2.title === 'Только видео' && b2.video_embed_url === 'https://player.vimeo.com/video/123' &&
      (!b2.text_content || b2.text_content === '' || b2.text_content === '<p></p>' || b2.text_content.trim() === ''),
      `урок 2: видео без тела: ${JSON.stringify({ t: b2.title, v: b2.video_embed_url, tc: b2.text_content })}`);
    ok('3: round-trip — файл прошёл import-md: описание, 2 урока, все блоки/кнопки/тест/фронтматтер совпали');

    // ── 4. Доступ и границы
    r = await api('GET', `/api/admin/education/courses/${uuid()}/export-md`, { token: adminJwt });
    assert(r.status === 404, `несуществующий курс → 404, got ${r.status}`);
    r = await api('GET', `/api/admin/education/courses/${C.dst}/export-md?lesson_id=${L.full}`, { token: adminJwt });
    assert(r.status === 400, `чужой урок → 400, got ${r.status}`);
    r = await api('GET', `/api/admin/education/courses/${C.src}/export-md`, { token: userJwt });
    assert(r.status === 403, `не-админ → 403, got ${r.status}`);
    r = await api('GET', `/api/admin/education/courses/${C.src}/export-md`);
    assert(r.status === 401, `гость → 401, got ${r.status}`);
    ok('4: 404 чужой курс, 400 чужой урок, 403 не-админ, 401 гость');

    // ── 5. Аудит: education.course_exported в user_events
    const ev = await rowsOf(
      `SELECT event_data FROM user_events WHERE user_id = ? AND event_type = 'education.course_exported' ORDER BY created_at`,
      ids.admin,
    );
    assert(ev.length >= 2, `событий экспорта ≥ 2: ${ev.length}`);
    const last = JSON.parse(ev[ev.length - 1].event_data);
    assert(last.course_title === 'Тестовый курс', `course_title в событии: ${JSON.stringify(last)}`);
    ok('5: аудит education.course_exported пишется с course_title');

    console.log(`\nOK ${passed}: все проверки ТЗ-191 пройдены`);
  } finally {
    server.kill('SIGTERM');
  }
}

scenario().catch((err) => {
  console.error('\nTZ191 FAIL:', err.message);
  process.exit(1);
});
