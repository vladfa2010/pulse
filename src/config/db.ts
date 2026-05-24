import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'pulse',
  user: process.env.DB_USER || 'pulse_user',
  password: process.env.DB_PASSWORD || '',
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

export const query = (text: string, params?: any[]) => pool.query(text, params);
export default pool;
