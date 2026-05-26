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

// Единая функция query — работает одинаково для SQLite и PostgreSQL
let queryFn: (text: string, params?: any[]) => Promise<{ rows: any[] }>;

// ═══════════════════════════════════════════════════════════════════════════
// РЕЖИМ 1: SQLite (локальная разработка)
// ═══════════════════════════════════════════════════════════════════════════
// Файл ./pulse.db создаётся автоматически в папке бэкенда.
// Не требует отдельного сервера — всё в одном файле.
if (USE_SQLITE) {
  const sqlite = require('./db-sqlite');
  queryFn = sqlite.query;
  console.log('[DB] Using SQLite (file-based, zero-config)');

// ═══════════════════════════════════════════════════════════════════════════
// РЕЖИМ 2: PostgreSQL через DATABASE_URL (production на Render)
// ═══════════════════════════════════════════════════════════════════════════
// Render автоматически создаёт эту переменную при подключении PostgreSQL.
// SSL обязателен — без него Render отклоняет подключение.
} else if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for Render PostgreSQL
  });
  // Обработка ошибок соединения (например, если PostgreSQL перезагружается)
  pool.on('error', (err: any) => {
    console.error('PostgreSQL pool error:', err);
  });
  // pool.query — стандартный метод pg, возвращает { rows: [...] }
  queryFn = (text: string, params?: any[]) => pool.query(text, params);
  console.log('[DB] Using PostgreSQL via DATABASE_URL');

// ═══════════════════════════════════════════════════════════════════════════
// РЕЖИМ 3: PostgreSQL через отдельные параметры (резервный вариант)
// ═══════════════════════════════════════════════════════════════════════════
// Используется если DATABASE_URL не задан, но заданы DB_HOST и т.д.
} else {
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'pulse',
    user: process.env.DB_USER || 'pulse_user',
    password: process.env.DB_PASSWORD || '',
  });
  pool.on('error', (err: any) => {
    console.error('PostgreSQL pool error:', err);
  });
  queryFn = (text: string, params?: any[]) => pool.query(text, params);
  console.log('[DB] Using PostgreSQL (individual config)');
}

// Экспортируем единую функцию query — все роутеры используют её
export const query = queryFn;
export default { query };
