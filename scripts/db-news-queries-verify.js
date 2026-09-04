/**
 * PG-smoke тяжёлых SQL-запросов новостного блока PULSE.
 *
 * Зачем: на SQLite dev-режиме эти запросы всегда зелёные, а на PostgreSQL
 * исторически ловились PG-only баги, улетавшие в прод:
 *   1. 42883 — array_agg(...) FILTER / GROUP BY в новостной статистике
 *   2. 22007 — invalid input syntax for type date (дайджест дня, фильтры по датам)
 *   3. Регрессия «дайджест дня не грузит новости на PG»
 *   4. ТЗ-50 — global summary: деградация и body-лог при отказе LLM
 *   5. Тепловая карта: freeze-джоба daily aggregates в PG-режиме
 *   6. Резолвер названий бумаг (broker positions → securities cache)
 *
 * Все проверки идут через РЕАЛЬНЫЙ код (роуты и сервисы из dist/),
 * SQL не копируется в тест. Внешние API не дёргаются: axios.post
 * подменяется моком до загрузки модулей.
 *
 * БД: pulse_dev_test2 (выделенная тестовая БД, схема public пересоздаётся).
 * Переопределить: NEWS_QUERIES_VERIFY_DB=postgres://user@host:5432/name
 *
 * Запуск: node scripts/db-news-queries-verify.js
 *         (предварительно npm run build)
 */

const { setCommonEnv } = require('./lib/calendar-verify-env');
setCommonEnv();

const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const distDir = path.join(__dirname, '..', 'dist');

// Подменяем axios.post до загрузки модулей: ни один тест не должен ходить
// во внешние API (Moonshot/Finam). Поведение переключается через мок ниже.
const axios = require('axios');
let llmMockBehavior = 'success';
axios.post = async (url, body) => {
  if (llmMockBehavior === 'success') {
    return { data: { choices: [{ message: { content: 'За последние 6 часов ключевых тем немного, рынки спокойны.' } }] } };
  }
  const err = new Error('Mocked LLM failure: prompt rejected');
  err.response = { status: 400, data: { error: { message: 'request entity too large (mock)' } } };
  throw err;
};

const TEST_DB_URL = process.env.NEWS_QUERIES_VERIFY_DB
  || `postgres://${process.env.USER}@localhost:5432/pulse_dev_test2`;

let query;
let generateGlobalSummary;
let freezeHeatmapRecentDays;
let buildDigestContentForUser;
let findPositionCompanyName;
let toMskDateString;
let newsRouter;
let newsHeatmapRouter;
let globalSummaryRouter;

const express = require('express');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function splitStatements(sql) {
  return sql
    .split(';')
    // Убираем строки-комментарии внутри statement, а не весь statement целиком
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);
}

async function ensureDatabase() {
  const { Client } = require('pg');
  const dbName = new URL(TEST_DB_URL).pathname.slice(1);
  const adminUrl = TEST_DB_URL.replace(/\/[^/]+$/, '/postgres');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${dbName}`);
    console.log(`[NewsQueriesVerify] created database ${dbName}`);
  } catch (e) {
    if (e.code !== '42P04') throw e; // already exists
  } finally {
    await client.end();
  }
}

async function setup() {
  console.log('[NewsQueriesVerify] PG-режим, БД:', TEST_DB_URL);
  await ensureDatabase();

  // Подключаемся напрямую, до require db.ts, чтобы пересоздать схему
  const { Pool } = require('pg');
  const bootstrapPool = new Pool({ connectionString: TEST_DB_URL, ssl: false });
  try {
    await bootstrapPool.query('DROP SCHEMA public CASCADE');
    await bootstrapPool.query('CREATE SCHEMA public');
    await bootstrapPool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await bootstrapPool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } finally {
    await bootstrapPool.end();
  }

  // db.ts смотрит DATABASE_URL — подставляем до require
  process.env.DATABASE_URL = TEST_DB_URL;
  ({ query } = require(path.join(distDir, 'config', 'db.js')));

  // Основная схема (PG-диалект, как на проде)
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'schema.sql'), 'utf-8');
  for (const stmt of splitStatements(schemaSql)) {
    await query(`${stmt};`);
  }

  // cron_locks уже в прод-форме (job_name/locked_by/expires_at) — см. schema.sql.

  // Broker-таблицы (миграция broker_portfolios_v1.sql содержит plpgsql-триггеры,
  // поэтому создаём только таблицы — они же создаются рантайм-миграциями index.ts)
  await query(`CREATE TABLE IF NOT EXISTS broker_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker TEXT NOT NULL CHECK (broker IN ('inside', 'finam', 'bcs', 'other')),
    label TEXT NOT NULL DEFAULT '',
    token_encrypted TEXT NOT NULL,
    token_tail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS broker_portfolios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    broker TEXT NOT NULL CHECK (broker IN ('inside', 'finam', 'bcs', 'other')),
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api','manual','import')),
    broker_key_id UUID REFERENCES broker_keys(id) ON DELETE SET NULL,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, broker, name)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS broker_positions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    broker_portfolio_id UUID NOT NULL REFERENCES broker_portfolios(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT 'MOEX',
    company_name TEXT,
    quantity NUMERIC(20, 6) NOT NULL,
    avg_price NUMERIC(20, 6),
    currency TEXT NOT NULL DEFAULT 'RUB',
    external_id TEXT,
    source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api','manual','import')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (broker_portfolio_id, ticker, exchange)
  )`);

  // Реальный код под проверку
  ({ generateGlobalSummary } = require(path.join(distDir, 'services', 'globalSummary.js')));
  ({ freezeHeatmapRecentDays } = require(path.join(distDir, 'services', 'heatmapDaily.js')));
  ({ buildDigestContentForUser } = require(path.join(distDir, 'services', 'notifications', 'digestContent.js')));
  ({ findPositionCompanyName } = require(path.join(distDir, 'services', 'brokerPortfolioService.js')));
  ({ toMskDateString } = require(path.join(distDir, 'services', 'heatmap', 'utils.js')));
  newsRouter = require(path.join(distDir, 'routes', 'news.js')).default;
  newsHeatmapRouter = require(path.join(distDir, 'routes', 'newsHeatmap.js')).default;
  globalSummaryRouter = require(path.join(distDir, 'routes', 'globalSummary.js')).default;
}

// ─── Тестовые данные ────────────────────────────────────────────────────────

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const USER2_ID = '00000000-0000-4000-8000-0000000000a2';
const newsIds = {};

function hoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000); }
function daysAgo(d) { return new Date(Date.now() - d * 24 * 3600 * 1000); }

async function insertNews(idx, fields) {
  const result = await query(
    `INSERT INTO news (
       title_ru, summary_ru, title_original, summary_original,
       source, source_type, url, content_hash, slug,
       lang_original, published_at, fetched_at,
       sentiment, sentiment_source, matched_tags, source_count, all_sources
     ) VALUES ($1,$2,$3,$4,$5,'rss',$6,$7,$8,$9,$10,$11,$12,'keyword',$13,$14,$15)
     RETURNING id`,
    [
      fields.title, fields.summary || fields.title, fields.titleEn || fields.title, fields.summaryEn || null,
      fields.source, `https://test.example.com/news/${idx}`, `hash-${idx}`, `slug-${idx}`,
      fields.lang || 'ru', fields.publishedAt, fields.publishedAt,
      fields.sentiment, fields.tags, fields.sourceCount || 1, [fields.source],
    ]
  );
  return result.rows[0].id;
}

async function seed() {
  await query(
    `INSERT INTO users (id, email, username, password_hash)
     VALUES ('${USER_ID}', 'news1@test', 'news1', 'x'), ('${USER2_ID}', 'news2@test', 'news2', 'x')`
  );

  await query(
    `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, enriched_data, created_by)
     VALUES ('sber', 'Сбербанк', 'company', '{"сбер"}', '{"ticker":"SBER","exchange":"MOEX"}', '${USER_ID}'),
            ('yndx', 'Яндекс', 'company', '{"яндекс"}', '{"ticker":"YDEX","exchange":"moex"}', '${USER_ID}')`
  );

  await query(
    `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type, is_frozen)
     VALUES ('${USER_ID}', 'sber', 'Сбербанк', 'company', FALSE),
            ('${USER_ID}', 'yndx', 'Яндекс', 'company', FALSE),
            ('${USER2_ID}', 'yndx', 'Яндекс', 'company', FALSE)`
  );

  newsIds.n1 = await insertNews(1, { title: 'Сбербанк: отчётность выше ожиданий', source: 'rbc', publishedAt: hoursAgo(2), sentiment: 'positive', tags: ['sber'] });
  newsIds.n2 = await insertNews(2, { title: 'Яндекс и Сбербанк: совместный проект', source: 'interfax', publishedAt: hoursAgo(5), sentiment: 'negative', tags: ['sber', 'yndx'], sourceCount: 3 });
  newsIds.n3 = await insertNews(3, { title: 'Яндекс обновил поиск', source: 'rbc', publishedAt: hoursAgo(26), sentiment: 'neutral', tags: ['yndx'] });
  newsIds.n4 = await insertNews(4, { title: 'Сбербанк поднял ставки', source: 'kommersant', publishedAt: daysAgo(2), sentiment: 'positive', tags: ['sber'] });
  newsIds.n5 = await insertNews(5, { title: 'Unrelated macro news', source: 'reuters', lang: 'en', publishedAt: daysAgo(1), sentiment: 'neutral', tags: [] });
  newsIds.n6 = await insertNews(6, { title: 'Сбербанк: итоги месяца', source: 'rbc', publishedAt: daysAgo(10), sentiment: 'positive', tags: ['sber'] });
  newsIds.n7 = await insertNews(7, { title: 'Сбербанк: старая новость', source: 'rbc', publishedAt: daysAgo(100), sentiment: 'positive', tags: ['sber'] });

  // n4 уже прочитана USER'ом
  await query(
    `INSERT INTO user_news_reads (user_id, news_id) VALUES ('${USER_ID}', '${newsIds.n4}')`
  );

  // Securities + broker positions для резолвера названий бумаг
  await query(
    `INSERT INTO securities (ticker, exchange, short_name, isin, sec_type, source)
     VALUES ('SBER', 'MOEX', 'Сбербанк ПАО', 'RU0009029540', 'share', 'finam'),
            ('GAZP', 'MOEX', 'Газпром ПАО', 'RU0007661625', 'share', 'finam')`
  );
  await query(
    `INSERT INTO broker_keys (id, user_id, broker, label, token_encrypted, token_tail)
     VALUES ('00000000-0000-4000-8000-0000000000b1', '${USER_ID}', 'finam', 'test', 'enc', '1234')`
  );
  await query(
    `INSERT INTO broker_portfolios (id, user_id, broker, name, broker_key_id)
     VALUES ('00000000-0000-4000-8000-0000000000c1', '${USER_ID}', 'finam', 'Test', '00000000-0000-4000-8000-0000000000b1')`
  );
  await query(
    `INSERT INTO broker_positions (broker_portfolio_id, ticker, exchange, company_name, quantity)
     VALUES ('00000000-0000-4000-8000-0000000000c1', 'SBER', 'MOEX', 'ПАО Сбербанк', 10)`
  );
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function createToken(userId) {
  return jwt.sign({ userId, email: 'news@test' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/news', newsRouter);
  app.use('/api/news_heatmap', newsHeatmapRouter);
  app.use('/api/user', globalSummaryRouter);
  return app;
}

async function request(server, method, pathName, { auth, userId } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      agent: new http.Agent({ keepAlive: false }),
      headers: { 'Content-Type': 'application/json' },
    };
    if (auth) options.headers['Authorization'] = 'Bearer ' + createToken(userId || USER_ID);
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try { parsed = JSON.parse(data); } catch { parsed = data; }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Тесты ──────────────────────────────────────────────────────────────────

async function main() {
  await setup();
  await seed();

  const app = createApp();
  const server = app.listen(0);
  const mskToday = toMskDateString(new Date());
  console.log(`[NewsQueriesVerify] MSK today = ${mskToday}`);

  try {
    // === 1. Лента: GIN matched_tags && $1::text[] + anti-join user_news_reads ===
    let res = await request(server, 'GET', '/api/news', { auth: true });
    assert(res.status === 200, `feed: status ${res.status}: ${JSON.stringify(res.body)}`);
    let ids = (res.body.articles || []).map((a) => a.id);
    assert(ids.includes(newsIds.n1) && ids.includes(newsIds.n2) && ids.includes(newsIds.n3) && ids.includes(newsIds.n6),
      `feed: unread sber/yndx news missing: ${JSON.stringify(ids)}`);
    assert(!ids.includes(newsIds.n4), 'feed: read news n4 must be excluded');
    assert(!ids.includes(newsIds.n5), 'feed: untagged news n5 must be excluded');
    assert(!ids.includes(newsIds.n7), 'feed: 100-days-old news n7 must be excluded (90d window)');
    console.log('[NewsQueriesVerify] 1. feed (GIN && + NOT EXISTS) passed');

    // === 2. Лента ?all=true включает прочитанные ===
    res = await request(server, 'GET', '/api/news?all=true', { auth: true });
    assert(res.status === 200, `feed all: status ${res.status}`);
    ids = (res.body.articles || []).map((a) => a.id);
    assert(ids.includes(newsIds.n4), 'feed all: read news n4 must be included');
    console.log('[NewsQueriesVerify] 2. feed all=true passed');

    // === 3. POST /:id/read + лента исключает ===
    res = await request(server, 'POST', `/api/news/${newsIds.n3}/read`, { auth: true });
    assert(res.status === 200 && res.body.success, `mark read: ${JSON.stringify(res.body)}`);
    res = await request(server, 'GET', '/api/news', { auth: true });
    ids = (res.body.articles || []).map((a) => a.id);
    assert(!ids.includes(newsIds.n3), 'feed: just-read news n3 must be excluded');
    console.log('[NewsQueriesVerify] 3. mark read (INSERT ... ON CONFLICT) passed');

    // === 4. POST /read-all (INSERT SELECT ON CONFLICT DO NOTHING) ===
    res = await request(server, 'POST', '/api/news/read-all', { auth: true });
    assert(res.status === 200 && res.body.success && res.body.marked > 0, `read-all: ${JSON.stringify(res.body)}`);
    res = await request(server, 'GET', '/api/news', { auth: true });
    assert(res.status === 200 && (res.body.articles || []).length === 0,
      `feed after read-all must be empty: ${JSON.stringify((res.body.articles || []).map((a) => a.id))}`);
    console.log('[NewsQueriesVerify] 4. read-all passed');

    // === 5. Публичная глобальная лента ===
    res = await request(server, 'GET', '/api/news/global');
    assert(res.status === 200, `global: status ${res.status}`);
    ids = (res.body.articles || []).map((a) => a.id);
    assert(ids.includes(newsIds.n5), 'global: untagged news must be present');
    assert(!ids.includes(newsIds.n7), 'global: 100-days-old news must be excluded');
    console.log('[NewsQueriesVerify] 5. global feed passed');

    // === 6. Популярные теги: unnest(LATERAL) + COUNT(*) FILTER — 42883-зона ===
    for (const period of ['24h', '7d', '30d']) {
      res = await request(server, 'GET', `/api/news/tags/popular?period=${period}`);
      assert(res.status === 200, `popular ${period}: status ${res.status}: ${JSON.stringify(res.body)}`);
      const tags = res.body.tags || [];
      const sber = tags.find((t) => t.tag_id === 'sber');
      assert(sber, `popular ${period}: sber missing in ${JSON.stringify(tags.map((t) => t.tag_id))}`);
      assert(sber.articles_7d >= 3, `popular ${period}: sber.articles_7d=${sber.articles_7d} (ждём ≥3)`);
      assert(sber.articles_30d >= sber.articles_7d, `popular ${period}: 30d < 7d`);
      if (period === '24h') assert(sber.articles_24h >= 1, 'popular 24h: свежие новости не посчитаны');
    }
    console.log('[NewsQueriesVerify] 6. popular tags (FILTER/unnest) passed');

    // === 7. Новости по тегу: matched_tags @> ARRAY[$1]::text[] ===
    res = await request(server, 'GET', '/api/news/tags/sber');
    assert(res.status === 200, `tag news: status ${res.status}`);
    ids = (res.body.articles || []).map((a) => a.id);
    assert(ids.includes(newsIds.n1) && ids.includes(newsIds.n6), `tag news: ${JSON.stringify(ids)}`);
    assert(!ids.includes(newsIds.n3), 'tag news: чужой тег в выдаче');
    console.log('[NewsQueriesVerify] 7. tag news (@>) passed');

    // === 8. Поиск: ILIKE ESCAPE ===
    res = await request(server, 'GET', `/api/news/search?q=${encodeURIComponent('Сбербанк')}`, { auth: true });
    assert(res.status === 200 && res.body.total >= 4, `search: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert((res.body.articles || []).some((a) => a.id === newsIds.n1), 'search: n1 not found');
    console.log('[NewsQueriesVerify] 8. search (ILIKE) passed');

    // === 9. Дайджест дня (регрессия «не грузит новости на PG») ===
    // scope=all, scale=day — авторизация обязательна; $1::date — 22007-зона
    res = await request(server, 'GET', `/api/news_heatmap?scope=all&scale=day&date=${mskToday}`, { auth: true });
    assert(res.status === 200, `day digest all: status ${res.status}: ${JSON.stringify(res.body)}`);
    ids = (res.body.stories || []).map((s) => s.id);
    assert(ids.includes(newsIds.n1) && ids.includes(newsIds.n2), `day digest all: ${JSON.stringify(ids)}`);
    assert(!ids.includes(newsIds.n5), 'day digest all: untagged must be excluded (cardinality > 0)');

    // scope=tag: matched_tags @> ARRAY[$2]::text[]
    res = await request(server, 'GET', `/api/news_heatmap?scope=tag&scale=day&date=${mskToday}&tag_id=sber`, { auth: true });
    assert(res.status === 200, `day digest tag: status ${res.status}: ${JSON.stringify(res.body)}`);
    ids = (res.body.stories || []).map((s) => s.id);
    assert(ids.includes(newsIds.n1) && !ids.includes(newsIds.n3), `day digest tag: ${JSON.stringify(ids)}`);

    // scope=portfolio: array_agg(tag_id) subquery — 42883-зона
    res = await request(server, 'GET', `/api/news_heatmap?scope=portfolio&scale=day&date=${mskToday}`, { auth: true, userId: USER2_ID });
    assert(res.status === 200, `day digest portfolio: status ${res.status}: ${JSON.stringify(res.body)}`);
    ids = (res.body.stories || []).map((s) => s.id);
    assert(ids.includes(newsIds.n2) && !ids.includes(newsIds.n1), `day digest portfolio (yndx only): ${JSON.stringify(ids)}`);
    console.log('[NewsQueriesVerify] 9. day digest (all/tag/portfolio, $1::date) passed');

    // === 10. Почасовая сетка: EXTRACT(HOUR FROM ... AT TIME ZONE) ===
    res = await request(server, 'GET', '/api/news_heatmap?scope=all&scale=day_hours', { auth: true });
    assert(res.status === 200, `day_hours all: status ${res.status}: ${JSON.stringify(res.body)}`);
    assert(Array.isArray(res.body.cells) && res.body.cells.length > 0, 'day_hours all: cells empty');
    res = await request(server, 'GET', '/api/news_heatmap?scope=portfolio&scale=day_hours', { auth: true, userId: USER2_ID });
    assert(res.status === 200 && Array.isArray(res.body.cells), `day_hours portfolio: ${JSON.stringify(res.body).slice(0, 200)}`);
    console.log('[NewsQueriesVerify] 10. day_hours passed');

    // === 11. Годовая тепловая карта all (публичная) + tag (резолвер инструмента) ===
    res = await request(server, 'GET', '/api/news_heatmap?scope=all&scale=year');
    assert(res.status === 200, `year all: status ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(Array.isArray(res.body.cells) && res.body.cells.length > 350, `year all: cells=${res.body.cells?.length}`);
    assert(res.body.meta && res.body.meta.empty === false, 'year all: meta.empty must be false');

    res = await request(server, 'GET', '/api/news_heatmap?scope=tag&scale=year&tag_id=yndx', { auth: true });
    assert(res.status === 200, `year tag: status ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(res.body.instrument && res.body.instrument.symbol === 'YDEX@MISX',
      `instrument resolver (exchange alias moex→MISX): ${JSON.stringify(res.body.instrument)}`);
    console.log('[NewsQueriesVerify] 11. year heatmap (all public + tag instrument resolver) passed');

    // === 12. Freeze-джоба daily aggregates (PG-режим) ===
    await freezeHeatmapRecentDays();
    let r = await query(`SELECT COUNT(*)::int AS c FROM news_all_daily WHERE stories > 0`);
    assert(r.rows[0].c > 0, 'freeze: news_all_daily empty');
    r = await query(`SELECT COUNT(*)::int AS c FROM news_tag_daily WHERE tag_id = 'sber' AND stories > 0`);
    assert(r.rows[0].c > 0, 'freeze: news_tag_daily/sber empty');
    r = await query(`SELECT COUNT(*)::int AS c FROM user_portfolio_daily WHERE user_id = $1 AND stories > 0`, [USER_ID]);
    assert(r.rows[0].c > 0, 'freeze: user_portfolio_daily empty');
    console.log('[NewsQueriesVerify] 12. freezeHeatmapRecentDays (PG) passed');

    // === 13. Годовая карта portfolio: ensurePortfolioHistoryFresh (pool-транзакция + array_agg) ===
    res = await request(server, 'GET', '/api/news_heatmap?scope=portfolio&scale=year', { auth: true });
    assert(res.status === 200, `year portfolio: status ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    assert(Array.isArray(res.body.cells) && res.body.cells.length > 350, 'year portfolio: cells missing');
    assert(res.body.meta && typeof res.body.meta.frozen_through === 'string',
      `year portfolio: frozen_through expected after freeze: ${JSON.stringify(res.body.meta)}`);

    // Mini-grids: unnest + ANY($1::text[])
    res = await request(server, 'GET', '/api/news_heatmap/mini-grids?tag_ids=sber,yndx', { auth: true });
    assert(res.status === 200, `mini-grids: status ${res.status}`);
    const gridIds = (res.body.grids || []).map((g) => g.tag_id).sort();
    assert(gridIds.join(',') === 'sber,yndx', `mini-grids: ${JSON.stringify(gridIds)}`);
    console.log('[NewsQueriesVerify] 13. year portfolio (rebuild txn) + mini-grids passed');

    // === 14. Global summary (ТЗ-50): генерация + деградация со stale-fallback ===
    llmMockBehavior = 'success';
    res = await request(server, 'GET', '/api/user/summary-global', { auth: true });
    assert(res.status === 200, `summary-global: status ${res.status}: ${JSON.stringify(res.body)}`);
    assert(typeof res.body.summary === 'string' && res.body.summary.length > 0, 'summary-global: empty summary');
    assert(res.body.articles_count === 2, `summary-global: articles_count=${res.body.articles_count} (ждём 2: n1,n2 за 6ч)`);
    const firstSummary = res.body.summary;

    // ТЗ-50: отказ LLM (400 + body) → stale-fallback отдаёт предыдущий обзор, код не падает
    llmMockBehavior = 'fail400';
    const degraded = await generateGlobalSummary({ refresh: true });
    assert(degraded.stale === true, `TZ-50: expected stale fallback, got ${JSON.stringify(degraded).slice(0, 150)}`);
    assert(degraded.summary === firstSummary, 'TZ-50: stale summary must equal previously generated');
    console.log('[NewsQueriesVerify] 14. global summary + TZ-50 stale-fallback passed');

    // === 15. Дайджест-контент (сборка статей для рассылки, PG-вариант) ===
    const digest = await buildDigestContentForUser(USER2_ID, null, null, 'verify');
    assert(Array.isArray(digest.articles), 'digest: articles missing');
    assert(digest.articles.length >= 1, `digest: expected ≥1 article for yndx user, got ${digest.articles.length}`);
    assert(digest.articles.every((a) => a.tagId === 'yndx'), `digest: чужие теги: ${JSON.stringify(digest.articles.map((a) => a.tagId))}`);
    assert(digest.articles.every((a) => a.tag === 'Яндекс'), 'digest: tag names not resolved');
    // Гибридный фильтр digest'а: fetched_at (API-окно 24ч) ИЛИ published_at > since,
    // поэтому since=now не обнуляет выдачу — свежие по fetched_at статьи остаются.
    const digestSince = await buildDigestContentForUser(USER2_ID, null, new Date(), 'verify-since');
    assert(
      digestSince.articles.map((a) => a.id).sort().join(',') === digest.articles.map((a) => a.id).sort().join(','),
      'digest since=now: набор статей должен совпадать с выдачей без since (API-окно fetched_at)'
    );
    console.log('[NewsQueriesVerify] 15. digest content passed');

    // === 16. Резолвер названий бумаг: broker position → securities cache ===
    const fromPosition = await findPositionCompanyName(USER_ID, 'SBER', 'MOEX');
    assert(fromPosition === 'ПАО Сбербанк', `securities: broker position name expected, got ${fromPosition}`);
    const fromCache = await findPositionCompanyName(USER_ID, 'GAZP', 'MOEX');
    assert(fromCache === 'Газпром ПАО', `securities: cache fallback expected, got ${fromCache}`);
    const unknown = await findPositionCompanyName(USER_ID, 'TTLK', 'MOEX');
    assert(unknown === null, `securities: unknown ticker must be null, got ${unknown}`);
    console.log('[NewsQueriesVerify] 16. securities name resolver passed');

    // === 17. Head-fill годовой сетки (ТЗ-11.11fix14): агрегаты начинаются недавно —
    // «голова» года дочитывается живьём из news ===
    // Инцидент 04.09: первый запуск freeze (ТЗ-49) записал лишь 3-дневное окно,
    // обязательный backfill не сделан → без head-fill голова года пустует.
    // Детерминированный сценарий: в агрегатах ровно один день (вчера), старая
    // статья (42 дня — дата свободна от сидовых n1..n7) есть только в news.
    // Без head-fill: gapFrom = frozenThrough+1 = сегодня > вчера → хвост пуст,
    // голова не покрывается → ячейка 0. С head-fill: [allDates[0]; frozenThrough].
    const frozenDay = toMskDateString(new Date(Date.now() - 1 * 86400000));
    const oldTs = new Date(Date.now() - 42 * 86400000);
    const oldNewsDate = toMskDateString(oldTs);
    const oldNewsId = await insertNews(97, {
      title: 'Архивная новость для head-fill', source: 'rbc',
      publishedAt: oldTs.toISOString(),
      sentiment: 'positive', tags: ['sber'],
    });
    await query(`DELETE FROM news_all_daily`);
    await query(
      `INSERT INTO news_all_daily (day_msk, stories, pos, neg, resonance) VALUES ($1::date, 1, 1, 0, 1)`,
      [frozenDay]
    );
    // date=headfill17 — уникальный cache key (роут кэширует годовую сетку на 5 мин),
    // иначе тест прочитает закэшированный ответ теста 11.
    res = await request(server, 'GET', '/api/news_heatmap?scope=all&scale=year&date=headfill17');
    assert(res.status === 200, `head-fill: status ${res.status}`);
    assert(res.body.meta && res.body.meta.frozen_through === frozenDay,
      `head-fill: агрегаты должны использоваться (frozen_through=${frozenDay}), got ${JSON.stringify(res.body.meta)}`);
    const oldCell = (res.body.cells || []).find((c) => c.date === oldNewsDate);
    assert(oldCell && Number(oldCell.stories) >= 1,
      `head-fill: ячейка ${oldNewsDate} должна дочитаться из news, got ${JSON.stringify(oldCell)}`);
    await query(`DELETE FROM news WHERE id = $1`, [oldNewsId]);
    console.log('[NewsQueriesVerify] 17. head-fill year grid (ТЗ-11.11fix14) passed');

    console.log('\n[NEWS-QUERIES VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[NEWS-QUERIES VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[NEWS-QUERIES VERIFY] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
