import fs from 'fs';
import path from 'path';
import { query } from '../config/db';

async function initDb() {
  try {
    const schemaPath = path.join(__dirname, '../models/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // Split and execute each statement
    const statements = schema.split(';').filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        await query(stmt + ';');
      }
    }

    console.log('Database initialized successfully');
    process.exit(0);
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1);
  }
}

initDb();
