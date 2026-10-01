// Smoke-проверка ТЗ-102 (LMS UGC + модерация + ClamAV-контур) по HTTP.
// Запуск: npm run build && node scripts/smoke-lms-ugc.js
// Паттерн — scripts/smoke-lms-step2.js: сервер поднимается дочерним процессом
// (dist/index.js, SQLite-режим), все проверки — реальные HTTP-запросы.
// EICAR-блок опционален: если CLAMAV_SOCKET указывает на живой сокет clamd —
// гоняется настоящий EICAR (публичный тестовый стандарт) через upload → infected;
// иначе блок пропускается с сообщением (деградация без clamd покрыта основным
// сценарием: pending_scan + 423 + флаг av_unavailable).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(__dirname, '..', 'dist');
// Живой clamd по CLAMAV_SOCKET? От этого зависит детерминированность ряда
// проверок: с clamd свежий файл дочищается за секунды, без — висит в
// pending_scan (деградация ТЗ-102). EICAR-блок активен только при hasClamd.
const CLAMAV_SOCKET_ENV = process.env.CLAMAV_SOCKET || '/run/clamav/clamd.sock';
const hasClamd = !!process.env.CLAMAV_SOCKET && fs.existsSync(CLAMAV_SOCKET_ENV);
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

async function api(method, p, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body;
  if (opts.form) {
    body = opts.form; // FormData — Content-Type выставит fetch сам
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + p, {
    method, headers, body,
    redirect: opts.redirect || 'follow',
  });
  let json = null;
  let text = '';
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch {
    /* не-JSON ответ */
  }
  return { status: res.status, json, text, headers: res.headers };
}

// Валидный pdf (file-type требует magic '%PDF-' и '%%EOF' в конце)
function makePdf(sizeBytes) {
  const head = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n');
  const tail = Buffer.from('%%EOF');
  const pad = Buffer.alloc(Math.max(0, sizeBytes - head.length - tail.length), 0x20);
  return Buffer.concat([head, pad, tail]);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function seedDatabase(DIR) {  process.env.USE_SQLITE = 'true';
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

  const ids = {};
  for (const name of ['admin', 'outsider', 'ulink', 'ufile', 'unews', 'unews2', 'urate', 'uav']) {
    ids[name] = uuid();
  }
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin)
     VALUES ${Object.values(ids).map((_, i) => `($${i + 1},'u${i}@test.ru','${Object.keys(ids)[i]}','x',${Object.keys(ids)[i] === 'admin' ? 1 : 0})`).join(',')}`,
    Object.values(ids),
  );

  // 3 новости
  const newsIds = [];
  for (let i = 1; i <= 3; i++) {
    const id = uuid();
    newsIds.push(id);
    await q(
      `INSERT INTO news (id, title_ru, slug, url, source, source_id, published_at)
       VALUES ($1,$2,$3,$4,'smoke','smoke',$5)`,
      [id, `UGC-новость ${i}`, `ugc-news-${i}`, `https://example.com/n${i}`,
        new Date(Date.now() - i * 3600 * 1000).toISOString()],
    );
  }

  // Опубликованный курс, ученики записаны (кроме outsider)
  const courseId = uuid();
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility)
     VALUES ($1,'UGC-курс','ugc-course',0,'published','public')`,
    [courseId],
  );
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title)
     VALUES ($1,$2,1,'Единственный урок')`,
    [uuid(), courseId],
  );
  for (const name of ['ulink', 'ufile', 'unews', 'unews2', 'urate', 'uav']) {
    await q(
      `INSERT INTO course_enrollments (id, user_id, course_id, source) VALUES ($1,$2,$3,'free')`,
      [uuid(), ids[name], courseId],
    );
  }

  // Редакционный материал-ссылка — обязан остаться публично видимым (дефолты миграции)
  await q(
    `INSERT INTO course_materials (id, course_id, kind, title, url, position)
     VALUES ($1,$2,'link','Редакционная ссылка','https://pulse.ru/editorial',1)`,
    [uuid(), courseId],
  );

  // Одобренный UGC-файл (scan_status='clean') — для проверки attachment-отдачи.
  // Файл кладём на диск при сиде (storage-драйвер тестируется отдельными смоуками).
  fs.mkdirSync(path.join(DIR, 'uploads', 'ugc'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'uploads', 'ugc', 'seed.pdf'), makePdf(2048));
  const approvedFileId = uuid();
  await q(
    `INSERT INTO course_materials
       (id, course_id, kind, title, url, position, origin, status, submitted_by, scan_status, created_at)
     VALUES ($1,$2,'file','Одобренный файл ученика','/media/ugc/seed.pdf',2,'user','approved',$3,'clean',datetime('now'))`,
    [approvedFileId, courseId, ids.ufile],
  );

  // «Зависший» pending_scan-файл часовой давности — флаг av_unavailable в очереди.
  // Файла на диске нет: sweeper молча пропустит (readFile → остаётся pending_scan).
  const stalePendingId = uuid();
  await q(
    `INSERT INTO course_materials
       (id, course_id, kind, title, url, position, origin, status, submitted_by, scan_status, created_at)
     VALUES ($1,$2,'file','Зависший файл','/media/quarantine/stale.pdf',3,'user','pending',$3,'pending_scan',datetime('now','-1 hour'))`,
    [stalePendingId, courseId, ids.ufile],
  );

  sqlite.saveDb();
  // Сид-процесс завершается раньше/позже сервера — его exit-хуки sql.js
  // (saveDb) затирали бы файл сервера (паттерн smoke-lms-step2.js)
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  return { ids, newsIds, courseId, approvedFileId, stalePendingId };
}

async function startServer(DIR, logBuf) {
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
        await new Promise((r2) => setTimeout(r2, 1500)); // дать миграциям доехать
        return server;
      }
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  throw new Error(`server did not become healthy: ${lastErr}\n${logBuf.join('')}`);
}

(async () => {
  const DIR = '/tmp/lms-ugc-smoke';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const seed = await seedDatabase(DIR);
  const { ids, newsIds, courseId, approvedFileId, stalePendingId } = seed;
  const tokens = {};
  for (const [name, id] of Object.entries(ids)) {
    tokens[name] = jwt.sign({ userId: id, email: `${name}@test.ru` }, 'test');
  }
  const adminJwt = tokens.admin;

  const logBuf = [];
  const server = await startServer(DIR, logBuf);
  try {
    // ── Критерий 1: миграция идемпотентна; чужой secret → 403 ──────────────
    let r = await api('POST', '/migrate-lms-ugc?secret=wrong');
    assert(r.status === 403, `wrong secret → 403, got ${r.status}`);
    r = await api('POST', '/migrate-lms-ugc?secret=test');
    assert(r.status === 200 && r.json.skipped === true, `SQLite → skipped:true, got ${r.status} ${r.text.slice(0, 200)}`);
    r = await api('POST', '/migrate-lms-ugc?secret=test');
    assert(r.status === 200, `повторный вызов → 200, got ${r.status}`);
    ok('критерий 1: /migrate-lms-ugc wrong secret 403, SQLite skipped, повторный 200');

    // ── Критерий 2: только записанные; pending не светится публично ─────────
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.outsider, body: { kind: 'link', title: 'Чужая ссылка', url: 'https://example.com' },
    });
    assert(r.status === 403, `незаписанный → 403, got ${r.status}`);
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.ulink, body: { kind: 'link', title: 'Ссылка ученика', url: 'https://example.com/1' },
    });
    assert(r.status === 201 && r.json.status === 'pending', `link → 201 pending, got ${r.status} ${r.text}`);
    const linkMaterialId = r.json.id;
    r = await api('GET', '/api/education/courses/ugc-course', { token: tokens.ulink });
    assert(r.status === 200, 'титульная курса записанному → 200');
    const publicTitles = r.json.materials.map((m) => m.title);
    assert(publicTitles.includes('Редакционная ссылка'), 'редакционный материал виден как раньше (status=approved дефолт)');
    assert(!publicTitles.includes('Ссылка ученика'), 'pending-материал НЕ светится публично');
    r = await api('GET', '/api/education/courses/ugc-course'); // гость
    assert(r.status === 200 && r.json.materials.length === 0, 'гостю закрытые материалы не видны');
    ok('критерий 2: незаписанный 403; 201 pending; pending публично не виден, editorial виден');

    // ── Критерий 5: javascript:-ссылка → 400 ────────────────────────────────
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.ulink, body: { kind: 'link', title: 'XSS', url: 'javascript:alert(1)' },
    });
    assert(r.status === 400, `javascript: → 400, got ${r.status}`);
    ok('критерий 5: javascript:alert(1) → 400');

    // ── Критерий 4: exe → 400, 11 МБ → 400, MZ-as-pdf → 415, pdf/png → 201 ──
    const exeForm = new FormData();
    exeForm.append('kind', 'file');
    exeForm.append('title', 'Программа');
    exeForm.append('file', new Blob([Buffer.concat([Buffer.from('MZ'), Buffer.from('fake')])]), 'prog.exe');
    r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.ufile, form: exeForm });
    assert(r.status === 400, `.exe → 400, got ${r.status}`);

    const bigForm = new FormData();
    bigForm.append('kind', 'file');
    bigForm.append('title', 'Большой pdf');
    bigForm.append('file', new Blob([makePdf(11 * 1024 * 1024)]), 'big.pdf');
    r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.ufile, form: bigForm });
    assert(r.status === 400, `11 МБ pdf → 400, got ${r.status}`);

    const mzForm = new FormData();
    mzForm.append('kind', 'file');
    mzForm.append('title', 'Переименованный exe');
    mzForm.append('file', new Blob([Buffer.concat([Buffer.from('MZ'), Buffer.from('fake-exe-body')])]), 'fake.pdf');
    r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.ufile, form: mzForm });
    assert(r.status === 415, `exe под видом pdf → 415, got ${r.status}`);

    const pdfForm = new FormData();
    pdfForm.append('kind', 'file');
    pdfForm.append('title', 'Конспект pdf');
    pdfForm.append('file', new Blob([makePdf(4096)], { type: 'application/pdf' }), 'conspect.pdf');
    r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.ufile, form: pdfForm });
    assert(r.status === 201 && r.json.scan_status === 'pending_scan', `pdf → 201 pending_scan, got ${r.status} ${r.text}`);
    const pdfMaterialId = r.json.id;

    const pngForm = new FormData();
    pngForm.append('kind', 'file');
    pngForm.append('title', 'Скриншот');
    pngForm.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'screen.png');
    r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.ufile, form: pngForm });
    assert(r.status === 201 && r.json.scan_status === 'pending_scan', `png → 201 pending_scan, got ${r.status} ${r.text}`);
    ok('критерий 4: exe 400, 11МБ 400, MZ→pdf 415, pdf/png 201 pending_scan');

    // ── Критерий 11(4): pending_scan не скачивается → 423 ───────────────────
    // Детерминированно в обоих режимах (с clamd и без): «зависший» файл из сида
    // физически отсутствует на диске — sweeper не может его отсканировать, он
    // остаётся pending_scan навсегда.
    r = await api('GET', `/api/education/materials/${stalePendingId}/download`, {
      token: tokens.ufile, redirect: 'manual',
    });
    assert(r.status === 423, `download pending_scan → 423, got ${r.status}`);
    r = await api('GET', `/api/education/materials/${stalePendingId}/download`, {
      token: adminJwt, redirect: 'manual',
    });
    assert(r.status === 423, `download pending_scan модератором → 423, got ${r.status}`);
    // Без clamd свежезагруженный файл тоже остаётся pending_scan → 423 сразу
    if (!hasClamd) {
      r = await api('GET', `/api/education/materials/${pdfMaterialId}/download`, {
        token: tokens.ufile, redirect: 'manual',
      });
      assert(r.status === 423, `download свежего pending_scan (без clamd) → 423, got ${r.status}`);
    }
    ok('критерий 11(4): скачивание pending_scan → 423 для ученика И модератора');

    // ── attachment: одобренный UGC-файл отдаётся только как attachment ──────
    r = await api('GET', `/api/education/materials/${approvedFileId}/download`, {
      token: tokens.ufile, redirect: 'manual',
    });
    assert(r.status === 302, `чистый approved UGC-файл записанному → 302, got ${r.status}`);
    const signed = r.headers.get('location') || '';
    assert(signed.includes('/media/ugc/seed.pdf') && signed.includes('sig='), '302 на signedUrl в /media/ugc/');
    const fileRes = await fetch(`${BASE}${signed}`);
    assert(fileRes.status === 200, `signed URL → 200, got ${fileRes.status}`);
    const cd = fileRes.headers.get('content-disposition') || '';
    assert(cd.includes('attachment'), `Content-Disposition: attachment, got "${cd}"`);
    ok('критерий 4/11(3): чистый approved UGC-файл → 302 signed → attachment');

    // ── Критерий 9: предложения новостей — 404 / 409 ────────────────────────
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.unews, body: { kind: 'news', news_id: newsIds[0] },
    });
    assert(r.status === 201 && r.json.status === 'pending', `news → 201, got ${r.status} ${r.text}`);
    const newsSugId1 = r.json.id;
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.unews, body: { kind: 'news', news_id: newsIds[0] },
    });
    assert(r.status === 409, `дубликат новости → 409, got ${r.status}`);
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.unews, body: { kind: 'news', news_id: crypto.randomUUID() },
    });
    assert(r.status === 404, `несуществующая новость → 404, got ${r.status}`);
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.unews2, body: { kind: 'news', news_id: newsIds[1] },
    });
    assert(r.status === 201, `news #2 → 201, got ${r.status}`);
    const newsSugId2 = r.json.id;
    ok('критерий 9: news 201, дубликат 409, несуществующая новость 404');

    // ── Критерий 3: rate limit — 6-е предложение за сутки → 429 ─────────────
    for (let i = 1; i <= 5; i++) {
      r = await api('POST', '/api/education/courses/ugc-course/materials', {
        token: tokens.urate, body: { kind: 'link', title: `Ссылка ${i}`, url: `https://example.com/r${i}` },
      });
      assert(r.status === 201, `предложение ${i}/5 → 201, got ${r.status}`);
    }
    r = await api('POST', '/api/education/courses/ugc-course/materials', {
      token: tokens.urate, body: { kind: 'link', title: 'Шестая', url: 'https://example.com/r6' },
    });
    assert(r.status === 429, `6-е предложение → 429, got ${r.status}`);
    ok('критерий 3: 5 предложений 201, 6-е 429');

    // ── Очередь модерации: доступ, total, FIFO, av_unavailable ──────────────
    r = await api('GET', '/api/admin/education/moderation');
    assert(r.status === 401, `moderation без JWT → 401, got ${r.status}`);
    r = await api('GET', '/api/admin/education/moderation', { token: tokens.ulink });
    assert(r.status === 403, `moderation не-админ → 403, got ${r.status}`);
    r = await api('GET', '/api/admin/education/moderation', { token: adminJwt });
    assert(r.status === 200 && typeof r.json.total === 'number' && Array.isArray(r.json.items), 'moderation → 200 {total, items}');
    assert(r.json.total === r.json.items.length, 'total совпадает с длиной items');
    const items = r.json.items;
    const dates = items.map((i) => String(i.created_at || ''));
    assert(dates.join('|') === [...dates].sort().join('|'), 'FIFO: created_at ASC');
    const stale = items.find((i) => i.id === stalePendingId);
    assert(stale && stale.av_unavailable === true, 'старый pending_scan → av_unavailable=true');
    const freshPdf = items.find((i) => i.id === pdfMaterialId);
    // Без clamd файл висит в pending_scan; с clamd может уже дочиститься
    assert(freshPdf && ['pending_scan', 'clean'].includes(freshPdf.scan_status), `pdf в очереди, scan_status=${freshPdf?.scan_status}`);
    if (freshPdf.scan_status === 'pending_scan') {
      assert(freshPdf.av_unavailable === false, 'свежий pending_scan → av_unavailable=false');
    }
    const linkItem = items.find((i) => i.id === linkMaterialId);
    assert(linkItem && linkItem.type === 'material' && linkItem.author?.username === 'ulink', 'материал в очереди с автором');
    const newsItem = items.find((i) => i.id === newsSugId1);
    assert(newsItem && newsItem.type === 'news-suggestion' && newsItem.news?.title_ru, 'предложение новости в очереди с заголовком новости');
    ok('критерий 10/11(4): moderation 401/403/200, total, FIFO, av_unavailable, авторы и новости');

    // ── Аппрув pending_scan-файла заблокирован (без clamd — детерминированно) ─
    if (!hasClamd) {
      r = await api('POST', `/api/admin/education/moderation/material/${pdfMaterialId}/approve`, { token: adminJwt });
      assert(r.status === 409, `approve pending_scan-файла → 409, got ${r.status}`);
    }

    // ── Критерий 6: аппрув link-материала → виден публично с автором ────────
    r = await api('POST', `/api/admin/education/moderation/material/${linkMaterialId}/approve`, { token: adminJwt });
    assert(r.status === 200 && r.json.status === 'approved', `approve link → 200, got ${r.status} ${r.text}`);
    r = await api('GET', '/api/education/courses/ugc-course', { token: tokens.ulink });
    const approvedLink = r.json.materials.find((m) => m.id === linkMaterialId);
    assert(approvedLink && approvedLink.origin === 'user' && approvedLink.submitted_by?.username === 'ulink', 'аппрувнутый UGC виден публично с origin=user и автором');
    r = await api('POST', `/api/admin/education/moderation/material/${linkMaterialId}/approve`, { token: adminJwt });
    assert(r.status === 409, `повторный approve → 409, got ${r.status}`);
    ok('критерий 6: approve → публично с «предложил @ulink», повторный 409');

    // ── Критерий 7: аппрув предложения новости → news_course_links ──────────
    r = await api('POST', `/api/admin/education/moderation/news-suggestion/${newsSugId2}/approve`, { token: adminJwt });
    assert(r.status === 200, `approve news-suggestion → 200, got ${r.status}`);
    r = await api('GET', '/api/education/courses/ugc-course/news');
    assert(r.status === 200 && r.json.some((n) => n.id === newsIds[1]), 'новость видна в «Курс в новостях»');
    ok('критерий 7: approve news-suggestion → запись в news_course_links, видна публично');

    // ── Критерий 8: reject с причиной → видна в my/submissions ──────────────
    r = await api('POST', `/api/admin/education/moderation/news-suggestion/${newsSugId1}/reject`, {
      token: adminJwt, body: {},
    });
    assert(r.status === 400, `reject без причины → 400, got ${r.status}`);
    r = await api('POST', `/api/admin/education/moderation/news-suggestion/${newsSugId1}/reject`, {
      token: adminJwt, body: { reason: 'Новость не по теме курса' },
    });
    assert(r.status === 200 && r.json.status === 'rejected', `reject с причиной → 200, got ${r.status}`);
    r = await api('GET', '/api/education/my/submissions', { token: tokens.unews });
    assert(r.status === 200 && Array.isArray(r.json.submissions), 'my/submissions → 200');
    const rej = r.json.submissions.find((s) => s.id === newsSugId1);
    assert(rej && rej.status === 'rejected' && rej.reject_reason === 'Новость не по теме курса', 'причина отказа видна ученику');
    ok('критерий 8: reject без причины 400, с причиной 200, причина в my/submissions');

    // ── my/submissions: сводка по материалам ученика ─────────────────────────
    r = await api('GET', '/api/education/my/submissions', { token: tokens.ufile });
    const mine = r.json.submissions;
    const myPdf = mine.find((s) => s.id === pdfMaterialId);
    assert(myPdf && myPdf.type === 'material' && myPdf.status === 'pending', 'файл ученика: pending (статус модерации)');
    assert(['pending_scan', 'clean'].includes(myPdf.scan_status), `scan_status=${myPdf.scan_status}`);
    const myApproved = mine.find((s) => s.id === approvedFileId);
    assert(myApproved && myApproved.status === 'approved', 'одобренный файл: approved');
    assert(myApproved.course.slug === 'ugc-course', 'курс в submission');
    r = await api('GET', '/api/education/my/submissions');
    assert(r.status === 401, 'my/submissions без JWT → 401');
    ok('my/submissions: материалы со статусами и курсом, без JWT 401');

    // ── Счётчик очереди после approve/reject уменьшился ──────────────────────
    r = await api('GET', '/api/admin/education/moderation', { token: adminJwt });
    assert(!r.json.items.some((i) => i.id === linkMaterialId), 'аппрувнутый материал исчез из очереди');
    assert(!r.json.items.some((i) => i.id === newsSugId1), 'отклонённая новость исчезла из очереди');
    assert(!r.json.items.some((i) => i.id === newsSugId2), 'аппрувнутая новость исчезла из очереди');
    assert(r.json.total === r.json.items.length, 'total пересчитан');
    ok('критерий 10: очередь уменьшилась после approve/reject');

    // ── Опциональный EICAR-блок (только с живым clamd) ──────────────────────
    if (hasClamd) {
      // EICAR — публичный тестовый стандарт (eicar.org): ASCII-строка,
      // magic bytes не определяют тип → проходит в карантин, ловится clamd.
      const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
      const eicarForm = new FormData();
      eicarForm.append('kind', 'file');
      eicarForm.append('title', 'EICAR-тест');
      eicarForm.append('file', new Blob([Buffer.from(EICAR)]), 'eicar.pdf');
      r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.uav, form: eicarForm });
      assert(r.status === 201, `EICAR upload → 201, got ${r.status}`);
      const eicarId = r.json.id;
      // Поллинг my/submissions до infected-отказа (clamd обычно отвечает <1с)
      let eicarRow = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        r = await api('GET', '/api/education/my/submissions', { token: tokens.uav });
        eicarRow = r.json.submissions.find((s) => s.id === eicarId);
        if (eicarRow && eicarRow.status === 'rejected') break;
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      assert(eicarRow && eicarRow.status === 'rejected', `EICAR → rejected, got ${JSON.stringify(eicarRow)}`);
      assert(/проверку безопасности/.test(eicarRow.reject_reason || ''), 'системная причина отказа');
      r = await api('GET', `/api/education/materials/${eicarId}/download`, {
        token: tokens.uav, redirect: 'manual',
      });
      assert(r.status === 423, `EICAR download → 423, got ${r.status}`);
      ok('критерий 11(1): EICAR → infected → системный отказ + 423');

      // Критерий 11(3): чистый pdf через живой контур — clean → аппрув → скачивание
      const cleanForm = new FormData();
      cleanForm.append('kind', 'file');
      cleanForm.append('title', 'Чистый pdf');
      cleanForm.append('file', new Blob([makePdf(4096)], { type: 'application/pdf' }), 'clean.pdf');
      r = await api('POST', '/api/education/courses/ugc-course/materials', { token: tokens.uav, form: cleanForm });
      assert(r.status === 201, `clean pdf upload → 201, got ${r.status}`);
      const cleanId = r.json.id;
      let cleanRow = null;
      while (Date.now() < deadline) {
        r = await api('GET', '/api/education/my/submissions', { token: tokens.uav });
        cleanRow = r.json.submissions.find((s) => s.id === cleanId);
        if (cleanRow && cleanRow.scan_status === 'clean') break;
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      assert(cleanRow && cleanRow.scan_status === 'clean', `clean pdf → scan_status clean, got ${JSON.stringify(cleanRow)}`);
      r = await api('POST', `/api/admin/education/moderation/material/${cleanId}/approve`, { token: adminJwt });
      assert(r.status === 200, `approve чистого файла → 200, got ${r.status}`);
      r = await api('GET', `/api/education/materials/${cleanId}/download`, {
        token: tokens.uav, redirect: 'manual',
      });
      assert(r.status === 302, `чистый approved файл → 302, got ${r.status}`);
      const cleanLoc = r.headers.get('location') || '';
      assert(cleanLoc.includes('/media/ugc/'), 'после clean файл перенесён из quarantine в ugc/');
      const cleanFileRes = await fetch(`${BASE}${cleanLoc}`);
      assert(cleanFileRes.status === 200, `signed URL чистого файла → 200, got ${cleanFileRes.status}`);
      assert((cleanFileRes.headers.get('content-disposition') || '').includes('attachment'), 'attachment у чистого UGC-файла');
      ok('критерий 11(3): чистый pdf → clean → quarantine/→ugc/ → approve → скачивается');
    } else {
      console.log('SKIP: clamd недоступен (CLAMAV_SOCKET) — EICAR-блок пропущен; деградация покрыта pending_scan+423');
    }

    console.log(`\nВсе ${passed} проверок зелёные`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r2) => setTimeout(r2, 800));
  }
})().catch((e) => {
  console.error('\nSMOKE FAIL:', e);
  process.exit(1);
});
