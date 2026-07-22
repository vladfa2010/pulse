/**
 * =============================================================================
 * PULSE — Database Configuration
 * =============================================================================
 *
 * Этот файл определяет, к какой базе данных подключаться.
 * Поддерживает 3 режима:
 *
 *   1. SQLite (локальная разработка) — файл на диске, zero-config
 *   2. PostgreSQL через DATABASE_URL (production на Render)
 *   3. PostgreSQL через отдельные переменные (резервный вариант)
 *
 * Переменные окружения:
 *   USE_SQLITE=true      → SQLite режим (локально)
 *   DATABASE_URL=...     → PostgreSQL через connection string (на Render)
 *   DB_HOST, DB_PORT...  → PostgreSQL через отдельные параметры
 *
 * На Render (production):
 *   - DATABASE_URL задаётся автоматически при создании PostgreSQL
 *   - SSL обязателен (rejectUnauthorized: false)
 *   - SQLite НЕ использовать — данные теряются при деплое
 *
 * Пример DATABASE_URL:
 *   postgresql://user:password@host:5432/database
 */

import dotenv from 'dotenv';

dotenv.config();

// ─── Определяем режим работы ──────────────────────────────────────────────
const USE_SQLITE = process.env.USE_SQLITE === 'true';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ═══════════════════════════════════════════════════════════════════════════
// Поддержка транзакций через pool.connect()
// pool нужен для BEGIN/COMMIT/ROLLBACK (одно соединение = одна транзакция)
// query() использует pool.query() — разное соединение на каждый вызов
// ═══════════════════════════════════════════════════════════════════════════
let poolInstance: any = null;

// Единая функция query — работает одинаково для SQLite и PostgreSQL
let queryFn: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

// ═══════════════════════════════════════════════════════════════════════════
// РЕЖИМ 1: SQLite (локальная разработка)
// ═══════════════════════════════════════════════════════════════════════════
if (USE_SQLITE) {
  const sqlite = require('./db-sqlite');
  queryFn = sqlite.query;
  // SQLite не поддерживает pool — транзакции через sqlite3 напрямую
  poolInstance = null;
  console.log('[DB] Using SQLite (file-based, zero-config)');

// ═══════════════════════════════════════════════════════════════════════════
// РЕЖИМ 2: PostgreSQL через DATABASE_URL (production на Render)
// ═══════════════════════════════════════════════════════════════════════════
} else if (DATABASE_URL) {
  const { Pool } = require('pg');
  poolInstance = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    statement_timeout: 30000,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  poolInstance.on('error', (err: any) => {
    console.error('PostgreSQL pool error:', err);
  });
  queryFn = (text: string, params?: any[]) => poolInstance.query(text, params);
  console.log('[DB] Using PostgreSQL via DATABASE_URL');
  // Boot-time check: verify statement_timeout is respected
  poolInstance.query('SHOW statement_timeout').then((res: any) => {
    console.log('[DB] PostgreSQL statement_timeout:', res.rows[0]?.statement_timeout);
  }).catch((err: any) => {
    console.error('[DB] Failed to read statement_timeout:', err.message);
  });

// ═══════════════════════════════════════════════════════════════════════════
// РЕЖИМ 3: PostgreSQL через отдельные параметры (резервный вариант)
// ═══════════════════════════════════════════════════════════════════════════
} else {
  const { Pool } = require('pg');
  poolInstance = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'pulse',
    user: process.env.DB_USER || 'pulse_user',
    password: process.env.DB_PASSWORD || '',
    max: 20,
    statement_timeout: 30000,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  poolInstance.on('error', (err: any) => {
    console.error('PostgreSQL pool error:', err);
  });
  queryFn = (text: string, params?: any[]) => poolInstance.query(text, params);
  console.log('[DB] Using PostgreSQL (individual config)');
  poolInstance.query('SHOW statement_timeout').then((res: any) => {
    console.log('[DB] PostgreSQL statement_timeout:', res.rows[0]?.statement_timeout);
  }).catch((err: any) => {
    console.error('[DB] Failed to read statement_timeout:', err.message);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Экспорт
// ═══════════════════════════════════════════════════════════════════════════
export const query = queryFn;
export const pool = poolInstance;  // ← для транзакций (null в SQLite)
export default { query };
