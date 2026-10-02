// Smoke: ТЗ-100 v8 (шеринг пути) + v14 (покупка курса через ЮKassa).
// Запуск: npm run build && node scripts/smoke-lms-path-buy.js
//
// Фаза A (service-level, SQLite): activatePaymentIfNeeded — ветка course
// (enrollment source='purchase', идемпотентность) и регрессия подписочного
// пути (DEFAULT product_type='subscription' ничего не ломает).
// Фаза B (HTTP, дочерний сервер dist/index.js): path-share CRUD + публичная
// страница /shared/:token + /buy (demo-режим ЮKassa) + demo-confirm + реальный
// webhook payment.succeeded (IP ЮKassa подделываем через X-Forwarded-For).
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'test';
process.env.SIGNED_URL_SECRET = 'test';
process.env.UPLOADS_DIR = '/tmp/lms-path-buy-smoke/uploads';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DIST = path.join(__dirname, '..', 'dist');
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

function uuid() { return crypto.randomUUID(); }

// ═══════════════════════════════════════════════════════════════════════════
// Фаза A — activatePaymentIfNeeded (service-level)
// ═══════════════════════════════════════════════════════════════════════════
async function phaseA() {
  console.log('\n═══════ ФАЗА A: activatePaymentIfNeeded ═══════');
  const DIR = '/tmp/lms-path-buy-smoke/phase-a';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  process.env.SQLITE_FILE = `${DIR}/pulse.db`;

  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  const q = sqlite.query;

  const userId = uuid();
  const courseId = uuid();
  await q(
    `INSERT INTO users (id, email, username, password_hash) VALUES ($1,'a@test.ru','phase_a','x')`,
    [userId],
  );
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES ($1,'A-курс','a-kurs',100,'published','public')`,
    [courseId],
  );

  const { activatePaymentIfNeeded } = require(path.join(DIST, 'services', 'subscription'));

  // A1: курсовый платёж → enrollment 'purchase'
  const payCourse = uuid();
  await q(
    `INSERT INTO payments (id, user_id, amount, method, status, product_type, product_ref)
     VALUES ($1,$2,100,'bank_card','pending','course',$3)`,
    [payCourse, userId, courseId],
  );
  let activated = await activatePaymentIfNeeded(payCourse);
  assert(activated === true, 'course payment first activation → true');
  const enr = await q(
    `SELECT source, payment_id FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  assert(enr.rows.length === 1 && enr.rows[0].source === 'purchase'
    && enr.rows[0].payment_id === payCourse,
    `enrollment source='purchase', payment_id=${payCourse}: ${JSON.stringify(enr.rows)}`);
  const payRow = await q(`SELECT status FROM payments WHERE id = $1`, [payCourse]);
  assert(payRow.rows[0].status === 'completed', 'payment completed');
  // Подписочного следа быть не должно
  const renewals = await q(
    `SELECT COUNT(*) c FROM subscription_renewals WHERE user_id = $1`, [userId]);
  assert(parseInt(renewals.rows[0].c) === 0, 'subscription_renewals не тронуты курсом');
  ok('A1: курсовый платёж → completed + enrollment purchase с payment_id');

  // A2: идемпотентность
  activated = await activatePaymentIfNeeded(payCourse);
  assert(activated === false, 'повторная активация → false');
  const enr2 = await q(
    `SELECT COUNT(*) c FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId]);
  assert(parseInt(enr2.rows[0].c) === 1, 'enrollment один');
  ok('A2: повторный вызов idempotent (false, enrollment не дублируется)');

  // A3: регрессия подписочного пути (колонка product_type не указана → DEFAULT)
  const subUser = uuid();
  await q(
    `INSERT INTO users (id, email, username, password_hash) VALUES ($1,'a-sub@test.ru','phase_a_sub','x')`,
    [subUser],
  );
  const paySub = uuid();
  await q(
    `INSERT INTO payments (id, user_id, amount, method, status, plan_id, billing_cycle, duration_days)
     VALUES ($1,$2,100,'bank_card','pending','base','monthly',30)`,
    [paySub, subUser],
  );
  activated = await activatePaymentIfNeeded(paySub);
  assert(activated === true, 'subscription payment activation → true');
  const subRow = await q(
    `SELECT subscription_active, subscription_plan FROM users WHERE id = $1`, [subUser]);
  assert(subRow.rows[0].subscription_active === 1 && subRow.rows[0].subscription_plan === 'base',
    `подписка активирована: ${JSON.stringify(subRow.rows[0])}`);
  ok('A3: подписочный платёж (DEFAULT product_type) — подписка активна, регрессии нет');

  activated = await activatePaymentIfNeeded(paySub);
  assert(activated === false, 'подписочный платёж idempotent');
  ok('A4: подписочный платёж idempotent');

  sqlite.saveDb();
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  // Чистим кэш модулей БД, чтобы фаза B (дочерний процесс) не зависела от них,
  // а повторный require в этом процессе (если понадобится) был свежим.
  for (const m of Object.keys(require.cache)) {
    if (m.includes('/dist/')) delete require.cache[m];
  }
  console.log(`\nФАЗА A: ${passed} проверок зелёные`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Фаза B — HTTP-сценарий (дочерний сервер)
// ═══════════════════════════════════════════════════════════════════════════
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

async function api(method, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
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
  } catch { /* пустой/не-JSON */ }
  return { status: res.status, json, text };
}

async function seedDatabase(DIR) {
  process.env.USE_SQLITE = 'true';
  process.env.SQLITE_FILE = `${DIR}/pulse.db`;
  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  const q = sqlite.query;

  const ids = { admin: uuid(), user: uuid(), blocked: uuid(), buyer: uuid(), buyer2: uuid(), subuser: uuid() };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin) VALUES
     ($1,'admin@test.ru','admin','x',1),($2,'user@test.ru','ivan_path','x',0),
     ($3,'blocked@test.ru','blocked','x',0),($4,'buyer@test.ru','buyer','x',0),
     ($5,'buyer2@test.ru','buyer2','x',0),($6,'subuser@test.ru','subuser','x',0)`,
    [ids.admin, ids.user, ids.blocked, ids.buyer, ids.buyer2, ids.subuser],
  );
  await q(`UPDATE users SET is_blocked = 1 WHERE id = $1`, [ids.blocked]);

  const C = { paid: uuid(), free: uuid(), hidden: uuid(), draft: uuid() };
  await q(
    `INSERT INTO courses (id, title, slug, price, status, visibility) VALUES
     ($1,'Платный курс','paid-kurs',4900,'published','public'),
     ($2,'Бесплатный курс','free-kurs',0,'published','public'),
     ($3,'Скрытый курс','hidden-kurs',100,'published','hidden'),
     ($4,'Черновик курса','draft-kurs',100,'draft','public')`,
    [C.paid, C.free, C.hidden, C.draft],
  );
  const L = { p1: uuid(), p2: uuid(), f1: uuid() };
  await q(
    `INSERT INTO course_lessons (id, course_id, position, title, duration_min) VALUES
     ($1,$2,1,'Урок 1',30),($3,$2,2,'Урок 2',45),($4,$5,1,'Единственный урок',10)`,
    [L.p1, C.paid, L.p2, L.f1, C.free],
  );

  // enrollments владельца пути: платный, бесплатный, скрытый (не должен попасть в шеринг)
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source) VALUES
     ($1,$2,$3,'purchase'),($4,$2,$5,'free'),($6,$2,$7,'free')`,
    [uuid(), ids.user, C.paid, uuid(), C.free, uuid(), C.hidden],
  );
  // прогресс: урок 1 платного пройден (30 мин)
  await q(
    `INSERT INTO lesson_progress (user_id, lesson_id, completed_at) VALUES ($1,$2,datetime('now'))`,
    [ids.user, L.p1],
  );

  // Заблокированный владелец уже имеет шеринг
  await q(
    `INSERT INTO user_path_shares (user_id, token) VALUES ($1,'blockedsharetoken0123456789abcdef0123456789abcdef')`,
    [ids.blocked],
  );

  // Платёж buyer2 с provider_ref — для прогона РЕАЛЬНОГО webhook payment.succeeded
  const ykCoursePayment = uuid();
  await q(
    `INSERT INTO payments (id, user_id, amount, method, status, product_type, product_ref, provider_ref)
     VALUES ($1,$2,4900,'bank_card','pending','course',$3,'yk-test-course-1')`,
    [ykCoursePayment, ids.buyer2, C.paid],
  );
  // Подписочный платёж subuser с provider_ref — регрессия webhook для подписок
  const ykSubPayment = uuid();
  await q(
    `INSERT INTO payments (id, user_id, amount, method, status, plan_id, billing_cycle, duration_days, provider_ref)
     VALUES ($1,$2,100,'bank_card','pending','base','monthly',30,'yk-test-sub-1')`,
    [ykSubPayment, ids.subuser],
  );

  sqlite.saveDb();
  process.removeAllListeners('exit');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  return { ids, C, ykCoursePayment, ykSubPayment };
}

async function startServer(DIR, logBuf) {
  const { spawn } = require('child_process');
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
      // ЮKassa НЕ задана → /buy работает в demo-режиме (как payment.ts)
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

function yookassaWebhook(object) {
  return api('POST', '/api/webhook/yookassa', {
    headers: { 'X-Forwarded-For': '185.71.76.1' }, // CIDR ЮKassa (ipCheck)
    body: { type: 'notification', event: 'payment.succeeded', object },
  });
}

async function scenario() {
  console.log('\n═══════ ФАЗА B: HTTP-сценарий ═══════');
  const DIR = '/tmp/lms-path-buy-smoke/phase-b';
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const seed = await seedDatabase(DIR);
  const { ids, C } = seed;
  const userJwt = jwt.sign({ userId: ids.user, email: 'user@test.ru' }, 'test');
  const buyerJwt = jwt.sign({ userId: ids.buyer, email: 'buyer@test.ru' }, 'test');
  const buyer2Jwt = jwt.sign({ userId: ids.buyer2, email: 'buyer2@test.ru' }, 'test');
  const subuserJwt = jwt.sign({ userId: ids.subuser, email: 'subuser@test.ru' }, 'test');

  const logBuf = [];
  const server = await startServer(DIR, logBuf);
  try {
    // ── path-share: auth и пустое состояние ──────────────────────────────
    let r = await api('GET', '/api/education/my/path-share');
    assert(r.status === 401, `path-share аноним → 401, got ${r.status}`);
    r = await api('GET', '/api/education/my/path-share', { token: userJwt });
    assert(r.status === 200 && r.json.token === null && r.json.url === null,
      `пусто → {token:null}: ${r.text}`);
    ok('path-share: аноним 401, начальное состояние {token:null}');

    // ── path-share: создание ─────────────────────────────────────────────
    r = await api('POST', '/api/education/my/path-share', { token: userJwt });
    assert(r.status === 200 && r.json.token && r.json.url,
      `POST → {token,url}: ${r.text}`);
    const token1 = r.json.token;
    assert(r.json.url.endsWith(`/education/path/${token1}`), `url=${r.json.url}`);
    assert(r.json.url.startsWith('http'), 'url абсолютный');
    ok(`path-share: POST создал токен ${token1.slice(0, 8)}… и абсолютный url`);

    // ── публичная страница пути ──────────────────────────────────────────
    r = await api('GET', `/api/education/shared/${token1}`);
    assert(r.status === 200, `shared → 200, got ${r.status} ${r.text}`);
    assert(r.json.owner && r.json.owner.username === 'ivan_path', 'owner.username');
    assert(!('email' in r.json.owner) && !('user_id' in r.json.owner), 'приватных полей нет');
    assert(!r.text.includes('user@test.ru'), 'email не утёк в ответ');
    assert(r.json.stats.courses === 2, `courses=2 (hidden исключён): ${r.json.stats.courses}`);
    assert(r.json.stats.lessons_done === 1, `lessons_done=1: ${r.json.stats.lessons_done}`);
    assert(r.json.stats.minutes === 30, `minutes=30: ${r.json.stats.minutes}`);
    const slugs = r.json.items.map((i) => i.slug);
    assert(slugs.includes('paid-kurs') && slugs.includes('free-kurs') && !slugs.includes('hidden-kurs'),
      `items: ${slugs}`);
    const paidItem = r.json.items.find((i) => i.slug === 'paid-kurs');
    assert(paidItem.progress_percent === 50 && paidItem.completed === false,
      `paid: 50% не пройден: ${JSON.stringify(paidItem)}`);
    ok('shared: owner/stats/items, hidden-курс исключён, прогресс 50%, приватность');

    // ── перевыпуск: старый токен мёртв сразу ─────────────────────────────
    r = await api('POST', '/api/education/my/path-share', { token: userJwt });
    const token2 = r.json.token;
    assert(token2 !== token1, 'новый токен отличается');
    r = await api('GET', `/api/education/shared/${token1}`);
    assert(r.status === 404, `старый токен → 404, got ${r.status}`);
    r = await api('GET', `/api/education/shared/${token2}`);
    assert(r.status === 200, 'новый токен жив');
    ok('path-share: перевыпуск убивает старый токен (404), новый работает');

    // ── ТЗ-122 (Задача 2): гонка перевыпуска — два параллельных POST ───────
    // Раньше: DELETE+INSERT → второй INSERT падал на PK user_id → 500.
    const [ra, rb] = await Promise.all([
      api('POST', '/api/education/my/path-share', { token: userJwt }),
      api('POST', '/api/education/my/path-share', { token: userJwt }),
    ]);
    assert(ra.status === 200 && rb.status === 200,
      `параллельный перевыпуск: оба 200, got ${ra.status}/${rb.status} ${ra.text.slice(0, 120)}`);
    assert(ra.json.token !== rb.json.token, 'параллельные токены разные');
    // Last-writer-wins: победивший токен — чей upsert записался ПОСЛЕДНИМ,
    // это не обязательно токен из второго ответа.
    const sa = await api('GET', `/api/education/shared/${ra.json.token}`);
    const sb = await api('GET', `/api/education/shared/${rb.json.token}`);
    const liveCount = [sa.status, sb.status].filter((s) => s === 200).length;
    assert(liveCount === 1,
      `валиден ровно 1 из 2 токенов (last-writer-wins), got ${sa.status}/${sb.status}`);
    ok('ТЗ-122: параллельный перевыпуск — оба 200, ровно один токен жив, без 500 на PK');

    // ── отзыв ссылки ─────────────────────────────────────────────────────
    r = await api('DELETE', '/api/education/my/path-share', { token: userJwt });
    assert(r.status === 204, `DELETE → 204, got ${r.status}`);
    r = await api('GET', '/api/education/my/path-share', { token: userJwt });
    assert(r.json.token === null, 'после DELETE {token:null}');
    r = await api('GET', `/api/education/shared/${token2}`);
    assert(r.status === 404, 'отозванный токен → 404');
    ok('path-share: DELETE 204, ссылка мёртва');

    // ── чужие/битые токены ───────────────────────────────────────────────
    r = await api('GET', '/api/education/shared/no-such-token-abc');
    assert(r.status === 404, 'несуществующий токен → 404');
    r = await api('GET', '/api/education/shared/blockedsharetoken0123456789abcdef0123456789abcdef');
    assert(r.status === 404, 'заблокированный владелец → 404');
    ok('shared: 404 на несуществующий токен и заблокированного владельца');

    // ── /buy: валидации ──────────────────────────────────────────────────
    r = await api('POST', '/api/education/courses/paid-kurs/buy');
    assert(r.status === 401, `buy аноним → 401, got ${r.status}`);
    r = await api('POST', '/api/education/courses/paid-kurs/buy', {
      token: buyerJwt, body: { promoCode: 'SALE10' },
    });
    assert(r.status === 400, `promoCode → 400, got ${r.status}`);
    r = await api('POST', '/api/education/courses/no-such-kurs/buy', { token: buyerJwt });
    assert(r.status === 404, `несуществующий → 404, got ${r.status}`);
    r = await api('POST', '/api/education/courses/free-kurs/buy', { token: buyerJwt });
    assert(r.status === 400, `бесплатный → 400, got ${r.status}`);
    r = await api('POST', '/api/education/courses/hidden-kurs/buy', { token: buyerJwt });
    assert(r.status === 404, `hidden → 404, got ${r.status}`);
    r = await api('POST', '/api/education/courses/draft-kurs/buy', { token: buyerJwt });
    assert(r.status === 404, `draft → 404, got ${r.status}`);
    ok('buy: 401 анониму, promoCode 400, free 400, hidden/draft/unknown 404');

    // ── /buy: demo-режим (ЮKassa не настроена) ───────────────────────────
    r = await api('POST', '/api/education/courses/paid-kurs/buy', { token: buyerJwt });
    assert(r.status === 200 && r.json.demo === true && r.json.payment.id,
      `buy → 200 demo: ${r.text}`);
    const payment1 = r.json.payment.id;
    assert(r.json.payment.amount === 4900, 'amount 4900');
    assert(r.json.confirmation_url.includes(`/payment/return?demo=1&payment_id=${payment1}`),
      `confirmation_url: ${r.json.confirmation_url}`);
    ok(`buy: 200 demo, платёж ${payment1.slice(0, 8)}…, confirmation_url на demo-возврат`);

    // двойной клик — второй pending-платёж
    r = await api('POST', '/api/education/courses/paid-kurs/buy', { token: buyerJwt });
    assert(r.status === 200 && r.json.payment.id !== payment1, 'двойной клик → второй платёж');
    const payment2 = r.json.payment.id;

    // платёж в статусе: product_type='course', plan_id NULL, billing_cycle 'once'
    r = await api('GET', `/api/payment/status/${payment1}`, { token: buyerJwt });
    assert(r.status === 200, `status → 200, got ${r.status}`);
    assert(r.json.payment.product_type === 'course', `product_type: ${r.json.payment.product_type}`);
    assert(r.json.payment.product_ref === C.paid, 'product_ref = id курса');
    assert(r.json.payment.plan_id === null || r.json.payment.plan_id === undefined,
      `plan_id NULL: ${r.json.payment.plan_id}`);
    assert(r.json.payment.billing_cycle === 'once', `billing_cycle: ${r.json.payment.billing_cycle}`);
    assert(r.json.payment.status === 'pending', 'платёж pending');
    ok('buy: платёж course/once, plan_id NULL, product_ref = курс');

    // ── demo-confirm платежа 1 → enrollment 'purchase' ───────────────────
    r = await api('POST', '/api/payment/confirm', { token: buyerJwt, body: { paymentId: payment1 } });
    assert(r.status === 200 && r.json.success === true, `confirm → 200: ${r.text}`);
    assert(r.json.message === 'Course purchase completed', `message: ${r.json.message}`);
    r = await api('GET', '/api/education/my', { token: buyerJwt });
    const bought = r.json.filter((c) => c.slug === 'paid-kurs');
    assert(bought.length === 1 && bought[0].enrollment_source === 'purchase',
      `в /my один курс source='purchase': ${JSON.stringify(bought)}`);
    ok("confirm: 200 'Course purchase completed', в /my source='purchase'");

    // платёж 2 (двойной клик) — идемпотентно уже обработан
    r = await api('POST', '/api/payment/confirm', { token: buyerJwt, body: { paymentId: payment2 } });
    assert(r.status === 200, `confirm платежа 2 → 200, got ${r.status}`);
    r = await api('GET', '/api/education/my', { token: buyerJwt });
    assert(r.json.filter((c) => c.slug === 'paid-kurs').length === 1, 'enrollment всё ещё один');
    // повторная покупка → 409
    r = await api('POST', '/api/education/courses/paid-kurs/buy', { token: buyerJwt });
    assert(r.status === 409, `повторный buy → 409, got ${r.status}`);
    ok('buy: двойной клик не дублирует enrollment, повторный buy → 409');

    // ── webhook payment.succeeded для курса (реальный HTTP-прогон) ───────
    r = await yookassaWebhook({
      id: 'yk-test-course-1',
      status: 'succeeded',
      metadata: { payment_id: seed.ykCoursePayment, product: 'course' },
    });
    assert(r.status === 200 && r.json.received === true, `webhook course → 200: ${r.text}`);
    r = await api('GET', '/api/education/my', { token: buyer2Jwt });
    const b2 = r.json.filter((c) => c.slug === 'paid-kurs');
    assert(b2.length === 1 && b2[0].enrollment_source === 'purchase',
      `buyer2 записан через webhook: ${JSON.stringify(b2)}`);
    r = await api('GET', `/api/payment/status/${seed.ykCoursePayment}`, { token: buyer2Jwt });
    assert(r.json.payment.status === 'completed', 'платёж buyer2 completed');
    ok('webhook: payment.succeeded курса → completed + enrollment purchase');

    // повторный webhook — idempotent
    r = await yookassaWebhook({
      id: 'yk-test-course-1',
      status: 'succeeded',
      metadata: { payment_id: seed.ykCoursePayment, product: 'course' },
    });
    assert(r.status === 200 && (r.json.idempotent === true || r.json.received === true),
      `повторный webhook → 200: ${r.text}`);
    r = await api('GET', '/api/education/my', { token: buyer2Jwt });
    assert(r.json.filter((c) => c.slug === 'paid-kurs').length === 1, 'enrollment buyer2 один');
    ok('webhook: повторный payment.succeeded idempotent');

    // ── webhook регрессия: подписочный платёж активирует подписку ────────
    r = await yookassaWebhook({
      id: 'yk-test-sub-1',
      status: 'succeeded',
      metadata: { payment_id: seed.ykSubPayment, plan_id: 'base', billing_cycle: 'monthly' },
    });
    assert(r.status === 200 && r.json.received === true, `webhook subscription → 200: ${r.text}`);
    r = await api('GET', `/api/payment/status/${seed.ykSubPayment}`, { token: subuserJwt });
    assert(r.json.payment.status === 'completed', 'подписочный платёж completed');
    assert(r.json.payment.product_type === 'subscription', 'DEFAULT product_type=subscription');
    ok('webhook: подписочный платёж (DEFAULT product_type) → completed, регрессии нет');

    // ── чужой payment status → 404 ───────────────────────────────────────
    r = await api('GET', `/api/payment/status/${payment1}`, { token: buyer2Jwt });
    assert(r.status === 404, `чужой платёж → 404, got ${r.status}`);
    ok('security: чужой payment_id → 404');

    console.log(`\nФАЗА B: все проверки зелёные`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r2) => setTimeout(r2, 800));
  }
}

(async () => {
  try {
    await phaseA();
    await scenario();
    console.log('\nSMOKE OK — path-share + course buy (ТЗ-100 v8/v14)');
    process.exit(0);
  } catch (e) {
    console.error('\nSMOKE FAIL:', e);
    process.exit(1);
  }
})();
