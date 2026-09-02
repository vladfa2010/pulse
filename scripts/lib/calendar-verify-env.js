/**
 * Bootstrap для verify-сьютов календаря.
 * Поддерживает два режима:
 *   - SQLite (по умолчанию): быстрая локальная итерация
 *   - PostgreSQL (CALENDAR_VERIFY_PG=1): gate перед деплоем
 *
 * Использование в начале каждого calendar-mX-verify.js:
 *   require('./lib/calendar-verify-env').setup();
 */

const fs = require('fs');
const path = require('path');

const USE_PG = process.env.CALENDAR_VERIFY_PG === '1';
const TEST_DB_VAR = 'DATABASE_URL_TEST';
const SQLITE_FILE_VAR = 'SQLITE_FILE';

function setCommonEnv() {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef12345678';
  process.env.CRON_SECRET_KEY = process.env.CRON_SECRET_KEY || 'test-cron-secret';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai';
  process.env.KIMI_API_KEY = process.env.KIMI_API_KEY || 'test-kimi-key';
  process.env.KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-32k';
  process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BJxHf6RkzS4y2p9qQ8v1mN0oL3uT5wY7aB9cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZ2aB3cD4eF5gH6iJ7k';
  process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'cE0w5k8mX2p9qR4sT7uV0wY3aB6cD9fG1hI4jK7lM0nO3pQ6rS9tV2wX5yZ8aB1c';
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test:token12345';
}

function ensureTestDatabaseUrl() {
  const url = process.env[TEST_DB_VAR];
  if (!url) {
    throw new Error(`[CalendarVerify] ${TEST_DB_VAR} не задан. Для PG-режима укажите тестовую БД, например: postgres://postgres:test@localhost:5433/pulse_test`);
  }
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname.length <= 1 || !parsed.pathname.slice(1).toLowerCase().includes('test')) {
      throw new Error(`[CalendarVerify] ${TEST_DB_VAR} должен указывать на БД с "test" в имени. Получено: ${url}`);
    }
  } catch (e) {
    throw new Error(`[CalendarVerify] ${TEST_DB_VAR} некорректен: ${url}. ${e.message}`);
  }
  // db.ts смотрит DATABASE_URL, подменяем до require
  process.env.DATABASE_URL = url;
}

async function setupPostgres() {
  console.log('[CalendarVerify] PG-режим');
  ensureTestDatabaseUrl();

  // Подключаемся к БД напрямую через pg, до require db.ts, чтобы дропнуть/создать схему
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } finally {
    await pool.end();
  }

  // Теперь require db.ts — он подхватит DATABASE_URL
  const { query } = require(path.join(__dirname, '..', '..', 'dist', 'config', 'db.js'));
  const { runCalendarV2Migrations } = require(path.join(__dirname, '..', '..', 'dist', 'services', 'calendar.js'));

  const schemaPath = path.join(__dirname, '..', '..', 'src', 'models', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  const statements = schemaSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    await query(`${stmt};`);
  }

  await runCalendarV2Migrations();

  // Таблицы тегов, новостей и т.п. нужны для интеграционных тестов; в SQLite-режиме их создавали вручную.
  await query(`CREATE TABLE IF NOT EXISTS user_defined_tags (
    tag_id TEXT PRIMARY KEY,
    tag_name TEXT NOT NULL,
    tag_type TEXT DEFAULT 'company',
    keywords TEXT,
    enriched_data TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (NOW())
  )`);
}

async function setupSQLite() {
  console.log('[CalendarVerify] SQLite-режим');
  const sqliteFile = process.env[SQLITE_FILE_VAR] || '/tmp/calendar_verify.db';
  process.env.USE_SQLITE = 'true';
  process.env[SQLITE_FILE_VAR] = sqliteFile;

  if (fs.existsSync(sqliteFile)) {
    fs.unlinkSync(sqliteFile);
  }

  const { initSQLite, initSQLiteSchema } = require(path.join(__dirname, '..', '..', 'dist', 'config', 'db-sqlite.js'));
  const { query } = require(path.join(__dirname, '..', '..', 'dist', 'config', 'db.js'));
  const { runCalendarV2Migrations } = require(path.join(__dirname, '..', '..', 'dist', 'services', 'calendar.js'));

  await initSQLite();
  await initSQLiteSchema();

  await query(`CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    date DATE NOT NULL,
    weekday VARCHAR(2) NOT NULL,
    title TEXT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    status VARCHAR(10) NOT NULL,
    company TEXT NOT NULL,
    ticker TEXT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT (datetime('now')),
    sources TEXT,
    possible_duplicate INTEGER DEFAULT 0,
    tag_ids TEXT,
    matched_via TEXT,
    UNIQUE (date, title, kind, ticker)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_events_raw (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source VARCHAR(20) NOT NULL,
    date DATE NOT NULL,
    weekday VARCHAR(2) NOT NULL,
    title TEXT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    status VARCHAR(10) NOT NULL,
    company TEXT NOT NULL,
    ticker TEXT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT (datetime('now')),
    tombstone_key TEXT,
    original_title TEXT
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_raw_source ON calendar_events_raw(source)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_raw_key ON calendar_events_raw(date, ticker)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_sources (source VARCHAR(20) PRIMARY KEY, uploaded_at TIMESTAMP, last_stale_alert_at TIMESTAMP, last_warnings TEXT)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_meta (id INTEGER PRIMARY KEY CHECK (id = 1), uploaded_at TIMESTAMP DEFAULT (datetime('now')), last_stale_alert_at TIMESTAMP)`);
  await runCalendarV2Migrations();

  await query(`CREATE TABLE IF NOT EXISTS user_defined_tags (
    tag_id TEXT PRIMARY KEY,
    tag_name TEXT NOT NULL,
    tag_type TEXT DEFAULT 'company',
    keywords TEXT,
    enriched_data TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function setup() {
  setCommonEnv();
  if (USE_PG) {
    return setupPostgres();
  }
  return setupSQLite();
}

module.exports = { setCommonEnv, setup };
