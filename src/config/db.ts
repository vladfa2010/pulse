import dotenv from 'dotenv';

dotenv.config();

const USE_SQLITE = process.env.USE_SQLITE === 'true';

let queryFn: (text: string, params?: any[]) => Promise<{ rows: any[] }>;

if (USE_SQLITE) {
  // Lazy-load SQLite adapter
  const sqlite = require('./db-sqlite');
  queryFn = sqlite.query;
  console.log('[DB] Using SQLite (file-based, zero-config)');
} else {
  // PostgreSQL
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
  console.log('[DB] Using PostgreSQL');
}

export const query = queryFn;
export default { query };
