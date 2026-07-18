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
      is_admin INTEGER DEFAULT 0,
      subscription_active INTEGER DEFAULT 0,
      subscription_plan TEXT DEFAULT 'free' REFERENCES subscription_plans(id),
      subscription_expires_at TEXT,
      subscription_auto_renew INTEGER DEFAULT 1,
      auto_renew_failures INTEGER DEFAULT 0,
      scheduled_plan_downgrade TEXT,
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

    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      billing_frequency TEXT NOT NULL DEFAULT 'monthly',
      yearly_discount INTEGER DEFAULT 0,
      tag_limit INTEGER NOT NULL,
      features TEXT NOT NULL DEFAULT '{}',
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_popular INTEGER DEFAULT 0,
      coming_soon_label TEXT DEFAULT NULL,
      plan_level INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
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
      plan_id TEXT REFERENCES subscription_plans(id),
      billing_cycle TEXT DEFAULT 'monthly',
      duration_days INTEGER DEFAULT 30,
      is_upgrade INTEGER DEFAULT 0,
      promo_code TEXT DEFAULT NULL,
      promo_discount_type TEXT DEFAULT NULL,
      promo_discount_value INTEGER DEFAULT NULL,
      paid_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_promo ON payments(promo_code);

    CREATE TABLE IF NOT EXISTS promo_codes (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT NULL,
      discount_type TEXT NOT NULL DEFAULT 'percent',
      discount_value INTEGER NOT NULL DEFAULT 0,
      applicable_plans TEXT DEFAULT NULL,
      max_uses INTEGER DEFAULT NULL,
      uses_count INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
    CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active) WHERE is_active = 1;

    CREATE TABLE IF NOT EXISTS user_promo_uses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promo_code_id TEXT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      discount_applied INTEGER NOT NULL DEFAULT 0,
      trial_days_used INTEGER DEFAULT NULL,
      expected_renewal_price REAL DEFAULT NULL,
      payment_id TEXT REFERENCES payments(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, promo_code_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_promo_uses_user ON user_promo_uses(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_promo_uses_promo ON user_promo_uses(promo_code_id);

    CREATE TABLE IF NOT EXISTS features_registry (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'boolean',
      options TEXT DEFAULT NULL,
      description TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_payment_methods (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_method_id TEXT NOT NULL,
      provider TEXT DEFAULT 'yookassa',
      card_last4 TEXT,
      card_brand TEXT,
      card_expiry TEXT,
      is_active INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      deactivated_at TEXT,
      UNIQUE(user_id, payment_method_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_payment_methods_user_id ON user_payment_methods(user_id);

    CREATE TABLE IF NOT EXISTS subscription_renewals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
      billing_cycle TEXT NOT NULL,
      payment_id TEXT REFERENCES payments(id),
      status TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_renewals_user_id ON subscription_renewals(user_id);
    CREATE INDEX IF NOT EXISTS idx_renewals_period_end ON subscription_renewals(period_end);

    CREATE TABLE IF NOT EXISTS frozen_tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      tag_type TEXT NOT NULL,
      frozen_at TEXT DEFAULT (datetime('now')),
      unfrozen_at TEXT,
      UNIQUE(user_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_frozen_tags_user_id ON frozen_tags(user_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, endpoint)
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      processed INTEGER DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS subscription_notifications_sent (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, type)
    );

    CREATE INDEX IF NOT EXISTS idx_sub_notif_user_type ON subscription_notifications_sent(user_id, type);

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
      fact_check_status TEXT NOT NULL DEFAULT 'not_checked',
      fact_check_result TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_news_fact_check_status ON news(fact_check_status);

    CREATE TABLE IF NOT EXISTS fact_check_jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed')),
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_retry_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(news_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_status ON fact_check_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_news_id ON fact_check_jobs(news_id);
    CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_user_id ON fact_check_jobs(user_id);

    CREATE TABLE IF NOT EXISTS fact_check_sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queries','search','fetch','claims','verdict','completed','failed')),
      queries_json TEXT,
      sources_json TEXT,
      sources_count INTEGER DEFAULT 0,
      fetched_json TEXT,
      fetched_count INTEGER DEFAULT 0,
      claims_json TEXT,
      claims_count INTEGER DEFAULT 0,
      final_verdict TEXT CHECK(final_verdict IN ('reliable','partly_reliable','unreliable','unverified')),
      final_confidence INTEGER CHECK(final_confidence BETWEEN 0 AND 100),
      final_reasoning TEXT,
      error_message TEXT,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      model TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fc_sessions_news ON fact_check_sessions(news_id);
    CREATE INDEX IF NOT EXISTS idx_fc_sessions_user ON fact_check_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_fc_sessions_status ON fact_check_sessions(status);

    CREATE TABLE IF NOT EXISTS search_cache (
      query_hash TEXT PRIMARY KEY,
      results TEXT,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);

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
      imoex_candles TEXT DEFAULT '[]',
      imoex_updated_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_expires
    ON password_reset_codes (user_id, expires_at DESC);

    CREATE TABLE IF NOT EXISTS user_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_data TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_user_events_user_id ON user_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_user_events_created_at ON user_events(created_at DESC);
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

  // Migration: add auto_renew_failures if missing (old databases)
  try {
    db.run('ALTER TABLE users ADD COLUMN auto_renew_failures INTEGER DEFAULT 0');
    console.log('[SQLite] Migration: added auto_renew_failures column');
  } catch {
    // Column already exists — ignore
  }

  // Seed subscription plans
  try {
    db.run(`INSERT OR IGNORE INTO subscription_plans
      (id, name, price, billing_frequency, yearly_discount, tag_limit, features, display_order, is_active, is_popular, coming_soon_label, plan_level)
    VALUES
      ('free', 'Free', 0, 'monthly', 0, 3, '{"telegram":false,"push":false,"ai_summary":false,"alerts":false,"priority":"normal"}', 1, 1, 0, NULL, 0),
      ('base', 'Base', 100, 'monthly', 20, 10, '{"telegram":true,"push":true,"ai_summary":false,"alerts":false,"priority":"normal"}', 2, 1, 0, NULL, 1),
      ('premium', 'Premium', 990, 'monthly', 20, 25, '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"high"}', 3, 1, 1, NULL, 2),
      ('club', 'Club', 2500, 'monthly', 20, -1, '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"club_access":true}', 4, 1, 0, 'Скоро', 3),
      ('pro', 'Pro', 2500, 'monthly', 20, -1, '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"api_access":true}', 5, 1, 0, 'Скоро', 4)`);
    console.log('[SQLite] Migration: subscription_plans seeded');
  } catch {
    // ignore
  }

  // Seed features registry
  try {
    db.run(`INSERT OR IGNORE INTO features_registry (id, label, type, options, description) VALUES
      ('telegram', 'Telegram-дайджест', 'boolean', NULL, 'Дайджест новостей в Telegram'),
      ('push', 'Push-уведомления', 'boolean', NULL, 'Push-уведомления в браузере/приложении'),
      ('ai_summary', 'AI-саммари по портфелю', 'boolean', NULL, 'AI-анализ портфеля каждый час'),
      ('alerts', 'Sentiment-алерты', 'boolean', NULL, 'Уведомления при резком изменении сентимента'),
      ('priority', 'Приоритетная доставка', 'string', '["normal", "high", "max"]', 'Приоритет обработки новостей'),
      ('early_delivery', 'Ранняя доставка', 'boolean', NULL, 'Доступ к новостям на 5 минут раньше'),
      ('custom_thresholds', 'Кастомные пороги', 'boolean', NULL, 'Настройка порогов для алертов'),
      ('club_access', 'Club доступ', 'boolean', NULL, 'Доступ к закрытому Telegram-чату'),
      ('api_access', 'API доступ', 'boolean', NULL, 'Доступ к REST API с токеном')`);
    console.log('[SQLite] Migration: features_registry seeded');
  } catch {
    // ignore
  }

  saveDb();
  console.log('[SQLite] Schema initialized');
}

export default { query, initSQLite, initSQLiteSchema, saveDb };
