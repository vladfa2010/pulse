// ============================================================
// SQLite adapter (sql.js) — zero-config, file-based
// Set USE_SQLITE=true in .env to use instead of PostgreSQL
// ============================================================
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_FILE = process.env.SQLITE_FILE || './pulse.db';

let db: any = null;

// Generate simple UUID v4
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Initialize SQLite database
export async function initSQLite(): Promise<void> {
  const SQL = await initSqlJs();

  // Load existing DB or create new
  if (fs.existsSync(DB_FILE)) {
    const filebuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(filebuffer);
    console.log('[SQLite] Loaded existing database:', DB_FILE);
  } else {
    db = new SQL.Database();
    console.log('[SQLite] Created new database:', DB_FILE);
  }

  // Auto-save on exit
  process.on('exit', saveDb);
  process.on('SIGINT', () => { saveDb(); process.exit(0); });
  process.on('SIGTERM', () => { saveDb(); process.exit(0); });
}

// Save database to file
export function saveDb(): void {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// Query helper — compatible with pg interface
export async function query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }> {
  if (!db) throw new Error('SQLite not initialized');

  // Convert PostgreSQL $1, $2 → SQLite ?
  let sql = text;
  if (params) {
    for (let i = params.length; i >= 1; i--) {
      sql = sql.replace(new RegExp(`\\$${i}`, 'g'), '?');
    }
  }

  // Convert PostgreSQL-specific syntax
  sql = sql
    .replace(/UUID PRIMARY KEY DEFAULT uuid_generate_v4\(\)/g, 'TEXT PRIMARY KEY')
    .replace(/UUID REFERENCES/g, 'TEXT REFERENCES')
    .replace(/UUID/g, 'TEXT')
    .replace(/BOOLEAN/g, 'INTEGER')
    .replace(/TEXT\[\]/g, 'TEXT') // arrays → JSON text
    .replace(/TIMESTAMP/g, 'TEXT')
    .replace(/DEFAULT NOW\(\)/g, "DEFAULT (datetime('now'))")
    .replace(/DEFAULT TRUE/g, 'DEFAULT 1')
    .replace(/DEFAULT FALSE/g, 'DEFAULT 0')
    .replace(/SERIAL/g, 'INTEGER')
    .replace(/::text\[\]/g, '')
    .replace(/ON CONFLICT DO NOTHING/g, 'OR IGNORE')
    .replace(/ON CONFLICT \([^)]+\) DO UPDATE SET/g, 'ON CONFLICT DO UPDATE SET')
    .replace(/COALESCE\(/g, 'COALESCE(')
    .replace(/INTERVAL '/g, '')
    .replace(/' days'/g, " days")
    .replace(/' hours'/g, " hours")
    .replace(/NOW\(\) \+ /g, "datetime('now', '+")
    .replace(/NOW\(\) - INTERVAL '/g, "datetime('now', '-")
    .replace(/' \+ INTERVAL '/g, ", '")
    .replace(/CURRENT_TIMESTAMP \+ INTERVAL '/g, "datetime('now', '")
    .replace(/NOW\(\)/g, "datetime('now')")
    .replace(/GIN/g, ''); // remove GIN

  try {
    const isWrite = /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(sql.trim());

    // Flatten params
    const flatParams: any[] = [];
    if (params) {
      for (const p of params) {
        if (Array.isArray(p)) {
          flatParams.push(JSON.stringify(p));
        } else if (typeof p === 'boolean') {
          flatParams.push(p ? 1 : 0);
        } else if (p instanceof Date) {
          flatParams.push(p.toISOString());
        } else {
          flatParams.push(p);
        }
      }
    }

    let result: any[] = [];

    if (isWrite) {
      // Write operation: use run()
      db.run(sql, flatParams);
    } else {
      // Read operation: use prepare + step + getAsObject
      const stmt = db.prepare(sql);
      stmt.bind(flatParams);
      while (stmt.step()) {
        result.push(stmt.getAsObject());
      }
      stmt.free();
    }

    // Save after every write operation
    if (isWrite) {
      saveDb();
    }

    return { rows: result, rowCount: isWrite ? db.getRowsModified() : 0 };
  } catch (err: any) {
    console.error('[SQLite] Query ERROR:', err.message);
    console.error('[SQLite] Failed SQL:', sql.trim().slice(0, 200));
    return { rows: [] };
  }
}

// Initialize schema for SQLite
export async function initSQLiteSchema(): Promise<void> {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_verified INTEGER DEFAULT 0,
      subscription_active INTEGER DEFAULT 0,
      subscription_expires_at TEXT,
      subscription_auto_renew INTEGER DEFAULT 1,
      is_admin INTEGER DEFAULT 0,
      news_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portfolios (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      tag_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      base_amount REAL NOT NULL DEFAULT 490.00,
      discount INTEGER DEFAULT 0,
      method TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      provider_ref TEXT,
      paid_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      title_ru TEXT NOT NULL,
      summary_ru TEXT,
      title_original TEXT,
      lang_original TEXT,
      source TEXT,
      source_id TEXT,
      url TEXT,
      published_at TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      sentiment TEXT,
      sentiment_score INTEGER,
      matched_tags TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      last_connected_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_channels (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, channel)
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tg_enabled INTEGER DEFAULT 1,
      email_enabled INTEGER DEFAULT 1,
      push_enabled INTEGER DEFAULT 0,
      report_frequency TEXT DEFAULT 'weekly',
      report_type TEXT DEFAULT 'all',
      alert_negative INTEGER DEFAULT 1,
      alert_positive INTEGER DEFAULT 1,
      alert_threshold INTEGER DEFAULT 3,
      report_time TEXT DEFAULT '13:00',
      quiet_hours_start TEXT DEFAULT '22:00',
      quiet_hours_end TEXT DEFAULT '08:00',
      quiet_hours_enabled INTEGER DEFAULT 1,
      report_format TEXT DEFAULT 'full',
      report_language TEXT DEFAULT 'ru',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS translation_cache (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      text_en TEXT NOT NULL,
      text_ru TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_news_published_at ON news (published_at);
    CREATE INDEX IF NOT EXISTS idx_news_source_id ON news (source_id);
    CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios (user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
    CREATE INDEX IF NOT EXISTS idx_user_channels_user_id ON user_channels (user_id);
    CREATE INDEX IF NOT EXISTS idx_translation_hash ON translation_cache (hash);

    CREATE TABLE IF NOT EXISTS sentiment_votes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote_value INTEGER NOT NULL CHECK (vote_value IN (-1, 0, 1)),
      created_at TEXT DEFAULT (datetime('now')),
      tickers TEXT DEFAULT '[]',
      index_at_vote INTEGER DEFAULT 0,
      imoex_at_vote REAL,
      imoex_after_1h REAL,
      index_after_2h INTEGER,
      check_status TEXT DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_sentiment_votes_user_time ON sentiment_votes(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_votes_created ON sentiment_votes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_votes_check ON sentiment_votes(check_status, created_at);

    CREATE TABLE IF NOT EXISTS sentiment_user_windows (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_vote_at TEXT,
      next_vote_at TEXT,
      vote_count_today INTEGER DEFAULT 0,
      total_votes_all_time INTEGER DEFAULT 0,
      sync_count INTEGER DEFAULT 0,
      total_votes_count INTEGER DEFAULT 0,
      streak_days INTEGER DEFAULT 0,
      max_streak_days INTEGER DEFAULT 0,
      favorite_sentiment TEXT DEFAULT NULL,
      impact_sum INTEGER DEFAULT 0,
      last_streak_date TEXT DEFAULT NULL,
      unlocked_badges TEXT DEFAULT '[]',
      forecast_streak INTEGER DEFAULT 0,
      max_forecast_streak INTEGER DEFAULT 0,
      contrarian_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sentiment_windows_next_vote ON sentiment_user_windows(next_vote_at);

    CREATE TABLE IF NOT EXISTS sentiment_index_cache (
      date TEXT PRIMARY KEY,
      current_value INTEGER DEFAULT 0,
      vote_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `;

  const statements = schema.split(';').filter(s => s.trim());
  for (const stmt of statements) {
    db.run(stmt + ';');
  }

  // Migration: add is_admin if missing (old databases)
  try {
    db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
    console.log('[SQLite] Migration: added is_admin column');
  } catch {
    // Column already exists — ignore
  }

  saveDb();
  console.log('[SQLite] Schema initialized');
}

export default { query, initSQLite, initSQLiteSchema, saveDb };
