/**
 * DB Schema Parity Verify — проверка того, что schema.sql самодостаточен
 * и применяется на чистой PostgreSQL без единой ошибки.
 *
 * Ловит класс багов, найденных при переводе dev-стенда на PG (2026-09):
 *   - CREATE INDEX раньше CREATE TABLE (раньше: WARN на каждом старте прода)
 *   - колонки, жившие только в ручных runtime-миграциях (/migrate-v3 и т.п.)
 *   - битый сид subscription_plans (деплойная ошибка price_monthly NOT NULL)
 *
 * Проверки:
 *   1. Свежая схема public: каждый statement schema.sql применяется БЕЗ ошибок.
 *   2. Идемпотентность: повторное применение тоже без ошибок.
 *   3. Чек-лист критичных таблиц и колонок присутствует.
 *   4. Сид subscription_plans валиден: 5 планов, free существует, NOT NULL заполнены.
 *
 * Запуск: node scripts/db-schema-parity-verify.js
 * БД: postgres://$USER@localhost:5432/pulse_dev_test3 (схема public пересоздаётся).
 */

const path = require('path');
const fs = require('fs');
const { setCommonEnv } = require('./lib/calendar-verify-env');

setCommonEnv();

const TEST_DB = process.env.SCHEMA_PARITY_DB
  || `postgres://${process.env.USER}@localhost:5432/pulse_dev_test3`;

function fail(msg) {
  console.error(`[SCHEMA PARITY] FAILED: ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

async function main() {
  process.env.DATABASE_URL = TEST_DB;

  const { Pool } = require('pg');
  const admin = new Pool({
    connectionString: TEST_DB,
    ssl: /localhost|127\.0\.0\.1|::1/.test(TEST_DB) ? false : { rejectUnauthorized: false },
  });

  try {
    await admin.query('DROP SCHEMA public CASCADE');
    await admin.query('CREATE SCHEMA public');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } finally {
    await admin.end();
  }

  const { query } = require(path.join(__dirname, '..', 'dist', 'config', 'db.js'));

  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'src', 'models', 'schema.sql'), 'utf-8');
  const statements = schemaSql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0);

  // 1+2. Применение дважды — ни одной ошибки (идемпотентность + порядок операторов)
  for (let round = 1; round <= 2; round++) {
    for (const stmt of statements) {
      try {
        await query(`${stmt};`);
      } catch (e) {
        fail(`round ${round}: statement failed: ${stmt.slice(0, 80)}… — ${e.message}`);
      }
    }
  }
  console.log(`[SCHEMA PARITY] schema applied cleanly twice (${statements.length} statements)`);

  // 3. Чек-лист критичных таблиц/колонок
  const required = [
    ['users', ['is_admin', 'expiry_notified', 'subscription_plan']],
    ['news', ['llm_error', 'llm_attempts', 'article_type', 'is_political',
      'needs_translation', 'sentiment_score', 'sentiment_reasoning',
      'enrichment_version', 'sentiment_source', 'tag_impact']],
    ['subscription_plans', ['price', 'price_monthly', 'price_yearly', 'plan_level']],
    ['llm_batches', ['success_count', 'failed_count', 'partial_count', 'error_types']],
    ['calendar_events', ['date', 'ticker', 'sources', 'possible_duplicate', 'tag_ids']],
    ['calendar_events_raw', ['tombstone_key', 'original_title']],
    ['calendar_sources', ['last_warnings']],
    ['news_sources', ['last_error', 'last_error_at', 'error_count']],
    ['notification_settings', ['digest_email', 'digest_frequency', 'web_push_enabled']],
    ['sentiment_index_cache', ['imoex_candles', 'imoex_updated_at']],
    ['user_defined_tags', ['enriched_data']],
    ['push_notifications_sent', ['title', 'source']],
    ['user_news_reads', null],
    ['securities', null],
  ];
  for (const [table, cols] of required) {
    const t = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    assert(t.rows.length > 0, `table ${table} missing after schema apply`);
    if (cols) {
      const res = await query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const have = new Set(res.rows.map(r => r.column_name));
      for (const c of cols) {
        assert(have.has(c), `column ${table}.${c} missing after schema apply`);
      }
    }
  }
  console.log(`[SCHEMA PARITY] ${required.length} critical tables verified`);

  // 4. Сид subscription_plans
  const plans = await query(
    `SELECT id, name, price, tag_limit, is_active FROM subscription_plans ORDER BY display_order`
  );
  assert(plans.rows.length === 5, `expected 5 subscription plans, got ${plans.rows.length}`);
  const free = plans.rows.find(p => p.id === 'free');
  assert(free, 'free plan missing');
  assert(Number(free.tag_limit) > 0, 'free plan tag_limit must be > 0');
  for (const p of plans.rows) {
    assert(p.name && p.price !== null && p.price !== undefined, `plan ${p.id} has null name/price`);
  }
  const paid = plans.rows.filter(p => ['base', 'premium', 'club', 'pro'].includes(p.id));
  assert(paid.every(p => Number(p.price) > 0), 'paid plans must have price > 0');
  console.log('[SCHEMA PARITY] subscription_plans seed valid (5 plans, free OK)');

  console.log('\n[SCHEMA PARITY] ALL TESTS PASSED');
  process.exit(0);
}

main().catch(e => fail(e.message));
