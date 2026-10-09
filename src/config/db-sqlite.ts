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

  // ТЗ-удаление-новости-админом v1.3: без этого PRAGMA внешние ключи выключены
  // и ON DELETE CASCADE не срабатывает (сироты в user_news_reads / fact_check_*).
  // Включаем для dev-паритета с PostgreSQL. На проде (PG) этот файл не используется.
  db.exec('PRAGMA foreign_keys = ON');
  console.log('[SQLite] PRAGMA foreign_keys = ON');

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

  // Convert PostgreSQL $1, $2 → SQLite ?1, ?2 (numbered params to support reuse like $1)
  let sql = text;
  if (params) {
    for (let i = params.length; i >= 1; i--) {
      sql = sql.replace(new RegExp(`\\$${i}`, 'g'), `?${i}`);
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
    .replace(/::jsonb/g, '')
    .replace(/COALESCE\(/g, 'COALESCE(')
    .replace(/INTERVAL '/g, '')
    .replace(/' days'/g, " days")
    .replace(/' hours'/g, " hours")
    .replace(/NOW\(\) \+ /g, "datetime('now', '+")
    .replace(/NOW\(\) - INTERVAL '/g, "datetime('now', '-")
    .replace(/' \+ INTERVAL '/g, ", '")
    .replace(/CURRENT_TIMESTAMP \+ INTERVAL '/g, "datetime('now', '")
    .replace(/NOW\(\)/g, "datetime('now')")
    .replace(/\s*USING GIN\s*/g, ' '); // remove GIN index clause (SQLite has no GIN)

  // SQLite не поддерживает ADD COLUMN IF NOT EXISTS — эмулируем через PRAGMA table_info
  const alterMatch = sql.match(/^\s*ALTER\s+TABLE\s+([\w"]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([\w"]+)\s+(.+?);?\s*$/i);
  if (alterMatch) {
    const tableName = alterMatch[1].replace(/"/g, '');
    const colName = alterMatch[2].replace(/"/g, '');
    const colInfo = db.exec(`PRAGMA table_info("${tableName}")`)[0];
    const existing = colInfo ? colInfo.values.map((v: any[]) => String(v[1])) : [];
    if (existing.includes(colName)) {
      return { rows: [], rowCount: 0 };
    }
    sql = `ALTER TABLE "${tableName}" ADD COLUMN "${colName}" ${alterMatch[3]}`;
  }

  // ON CONFLICT DO NOTHING → INSERT OR IGNORE (OR IGNORE после VALUES — синтаксическая ошибка SQLite)
  if (/^\s*INSERT\b/i.test(sql) && /\bON CONFLICT\b/i.test(sql)) {
    sql = sql
      .replace(/\s*ON CONFLICT(\s*\([^)]*\))?\s*DO NOTHING\s*;?\s*$/i, '')
      .replace(/^\s*INSERT\b/i, 'INSERT OR IGNORE');
  }

  try {
    const isWrite = /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim());

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

    let rowsModified = 0;
    // UPDATE/DELETE ... RETURNING: строки есть и у write-операций — выполняем
    // через prepare/step, иначе RETURNING-строки теряются (db.run их отбрасывает)
    const hasReturning = /\bRETURNING\b/i.test(sql);
    if (isWrite && !hasReturning) {
      // Write operation: use run()
      db.run(sql, flatParams);
      rowsModified = db.getRowsModified();
    } else {
      // Read operation (или write с RETURNING): use prepare + step + getAsObject
      const stmt = db.prepare(sql);
      stmt.bind(flatParams);
      while (stmt.step()) {
        result.push(stmt.getAsObject());
      }
      stmt.free();
    }

    // Save after every write operation (DDL/DML only; BEGIN/COMMIT/ROLLBACK must not save because db.export() closes the active transaction in sql.js)
    if (isWrite && !/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) {
      saveDb();
    }

    return { rows: result, rowCount: isWrite ? rowsModified : 0 };
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
      expiry_notified TEXT DEFAULT '{}',
      is_blocked INTEGER DEFAULT 0,
      last_login_at TEXT,
      login_count INTEGER DEFAULT 0,
      registration_source TEXT,
      registration_ip TEXT,
      timezone TEXT,
      locale TEXT,
      cohort_date TEXT,
      news_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_logins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      login_at TEXT DEFAULT (datetime('now')),
      ip_address TEXT,
      user_agent TEXT,
      platform TEXT,
      device_type TEXT,
      os TEXT,
      browser TEXT,
      country TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_user_logins_user_id ON user_logins(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username)); -- ТЗ-157
    CREATE INDEX IF NOT EXISTS idx_user_logins_login_at ON user_logins(login_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_logins_platform ON user_logins(platform);
    CREATE INDEX IF NOT EXISTS idx_user_logins_device_type ON user_logins(device_type);
    CREATE INDEX IF NOT EXISTS idx_user_logins_country ON user_logins(country);

    CREATE TABLE IF NOT EXISTS user_news_reads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      read_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, news_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_news_reads_user_id ON user_news_reads(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_news_reads_news_id ON user_news_reads(news_id);
    CREATE INDEX IF NOT EXISTS idx_user_news_reads_read_at ON user_news_reads(read_at DESC);

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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
      product_type TEXT NOT NULL DEFAULT 'subscription',
      product_ref TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_promo ON payments(promo_code);
    -- ADM-J: per-user платёжные lookup'ы и агрегаты (SQLite: без INCLUDE)
    CREATE INDEX IF NOT EXISTS idx_payments_status_user_paid ON payments(status, user_id, paid_at DESC);
    -- ADM-J: partial indexes для подписочных кронов
    CREATE INDEX IF NOT EXISTS idx_users_scheduled_downgrade ON users(subscription_expires_at) WHERE scheduled_plan_downgrade IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(subscription_expires_at) WHERE subscription_expires_at IS NOT NULL;
    -- ADM-J: сортировка admin users по created_at
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

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
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_user_promo_uses_user ON user_promo_uses(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_promo_uses_promo ON user_promo_uses(promo_code_id);

    CREATE TABLE IF NOT EXISTS features_registry (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT DEFAULT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS securities (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      ticker      TEXT NOT NULL,
      exchange    TEXT NOT NULL,
      short_name  TEXT,
      isin        TEXT,
      sec_type    TEXT,
      source      TEXT NOT NULL DEFAULT 'finam',
      resolved_at TEXT DEFAULT (datetime('now')),
      UNIQUE (ticker, exchange)
    );

    CREATE INDEX IF NOT EXISTS idx_securities_ticker_exchange ON securities(ticker, exchange);

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

    CREATE TABLE IF NOT EXISTS broker_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      broker TEXT NOT NULL CHECK(broker IN ('inside','finam','bcs','other')),
      label TEXT NOT NULL DEFAULT '',
      token_encrypted TEXT NOT NULL,
      token_tail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_broker_keys_user_broker ON broker_keys(user_id, broker);

    CREATE TABLE IF NOT EXISTS broker_portfolios (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      broker TEXT NOT NULL CHECK(broker IN ('inside','finam','bcs','other')),
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','manual','import')),
      broker_key_id TEXT REFERENCES broker_keys(id) ON DELETE SET NULL,
      last_synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, broker, name)
    );

    CREATE INDEX IF NOT EXISTS idx_broker_portfolios_user_broker_name ON broker_portfolios(user_id, broker, name);

    CREATE TABLE IF NOT EXISTS broker_positions (
      id TEXT PRIMARY KEY,
      broker_portfolio_id TEXT NOT NULL REFERENCES broker_portfolios(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'MOEX',
      company_name TEXT,
      quantity REAL NOT NULL,
      avg_price REAL,
      currency TEXT NOT NULL DEFAULT 'RUB',
      external_id TEXT,
      source TEXT NOT NULL DEFAULT 'api' CHECK(source IN ('api','manual','import')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(broker_portfolio_id, ticker, exchange)
    );

    CREATE INDEX IF NOT EXISTS idx_broker_positions_portfolio_ticker_exchange ON broker_positions(broker_portfolio_id, ticker, exchange);

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

    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      frequency TEXT,
      last_sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, product, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_lookup
      ON notification_subscriptions (product, channel, enabled);

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

    -- TZ_FACTCHECK_PAGE v1.3 §8.3: ad-hoc фактчекинг (ручной дубль схемы).
    -- is_public INTEGER 0/1 — все проверки частные (v1), result TEXT (JSON).
    CREATE TABLE IF NOT EXISTS fact_check_requests (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      input_type TEXT NOT NULL CHECK (input_type IN ('text','url','image','file')),
      input_raw TEXT,
      input_hash TEXT,
      title TEXT,
      extracted_text TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      result TEXT,
      error_message TEXT,
      is_public INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fact_check_requests_user_created ON fact_check_requests (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fact_check_requests_status ON fact_check_requests (status);
    CREATE INDEX IF NOT EXISTS idx_fact_check_requests_input_hash ON fact_check_requests (input_hash);
    CREATE INDEX IF NOT EXISTS idx_fact_check_requests_public ON fact_check_requests (is_public, status, created_at DESC);

    -- ═══════════════════════════════════════════════════════════════════════
    -- LMS «Образование» (ТЗ-100 v15, Задача 1) — зеркало src/migrations/lms_v1.sql
    -- SQLite-диалект: UUID→TEXT, BOOLEAN→INTEGER, JSONB→TEXT, NOW()→datetime('now').
    -- Добавлено в КОНЕЦ шаблона: порядок существующих CREATE TABLE не меняется.
    -- ═══════════════════════════════════════════════════════════════════════

    -- (v10) Категории курсов — ДО courses (FK category_id)
    CREATE TABLE IF NOT EXISTS course_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      cover_url TEXT,
      type TEXT NOT NULL DEFAULT 'course',
      size TEXT NOT NULL DEFAULT 'standard',
      price INTEGER NOT NULL DEFAULT 0,
      badges TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'public',
      subscription_unlock_mode TEXT NOT NULL DEFAULT 'full',
      category_id TEXT REFERENCES course_categories(id) ON DELETE SET NULL,
      author TEXT NOT NULL DEFAULT 'Редакция PULSE',
      relevant_until TEXT,
      source_type TEXT,
      source_news_id TEXT REFERENCES news(id) ON DELETE SET NULL,
      embedding TEXT,
      deleted_at TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_category ON courses(category_id) WHERE deleted_at IS NULL;

    -- Единая база тегов: те же tag_id, что у новостей/портфелей
    CREATE TABLE IF NOT EXISTS course_tags (
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (course_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS course_lessons (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      text_content TEXT,
      video_source TEXT,
      video_embed_url TEXT,
      video_file_url TEXT,
      duration_min INTEGER,
      is_free_preview INTEGER NOT NULL DEFAULT 0,
      unlock_after_days INTEGER NOT NULL DEFAULT 0,
      -- ТЗ-124: CTA-кнопки урока (JSON-массив, валидация на уровне API)
      buttons TEXT NOT NULL DEFAULT '[]',
      -- ТЗ-157: ключ идемпотентности создания (NULL у старых уроков)
      idempotency_key TEXT,
      UNIQUE (course_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_lessons_course ON course_lessons(course_id, position);
    -- ТЗ-157: частичный уникальный индекс — повтор с тем же ключом не создаёт дубль
    CREATE UNIQUE INDEX IF NOT EXISTS course_lessons_idem_key
      ON course_lessons (course_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS lesson_tests (
      id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
      pass_score INTEGER NOT NULL DEFAULT 70,
      is_blocking INTEGER NOT NULL DEFAULT 0,
      questions TEXT NOT NULL DEFAULT '[]',
      UNIQUE (lesson_id)
    );

    CREATE TABLE IF NOT EXISTS course_materials (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      news_id TEXT REFERENCES news(id) ON DELETE CASCADE,
      is_free INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'editorial',
      status TEXT NOT NULL DEFAULT 'approved',
      submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      reject_reason TEXT,
      scan_status TEXT NOT NULL DEFAULT 'clean',
      -- ТЗ-123: NULL = материал курса, задан = материал урока
      lesson_id TEXT REFERENCES course_lessons(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_materials_moderation ON course_materials(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_materials_lesson ON course_materials(lesson_id);

    CREATE TABLE IF NOT EXISTS course_enrollments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'free',
      payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (user_id, course_id)
    );

    CREATE TABLE IF NOT EXISTS course_tariffs (
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
      PRIMARY KEY (course_id, plan_id)
    );

    -- (v8) Шеринг пути: один активный шеринг на юзера, users НЕ трогаем
    CREATE TABLE IF NOT EXISTS user_path_shares (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lesson_progress (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
      completed_at TEXT DEFAULT (datetime('now')),
      test_score INTEGER,
      PRIMARY KEY (user_id, lesson_id)
    );

    CREATE TABLE IF NOT EXISTS news_course_links (
      news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (news_id, course_id)
    );

    -- ТЗ-102 v2: предложения новостей от учеников (очередь модерации).
    -- news_course_links остаётся чисто редакционной.
    CREATE TABLE IF NOT EXISTS news_course_suggestions (
      id TEXT PRIMARY KEY,
      news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      submitted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      reject_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (news_id, course_id, submitted_by)
    );

    -- ТЗ-103: рекомендации «новость ↔ курс» (система только рекомендует).
    -- score NULL = LLM не оценивал (дневной лимит), status+decided_* — датасет
    -- решений редактора. PG-зеркало: src/migrations/lms_v3_matching.sql.
    CREATE TABLE IF NOT EXISTS course_match_suggestions (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      score REAL,
      reason TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (course_id, news_id)
    );
    CREATE INDEX IF NOT EXISTS cms_course_status ON course_match_suggestions(course_id, status);
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

  // Migration: TZ_FACTCHECK_PAGE §5 — согласие на передачу файлов оператору ИИ
  try {
    db.run('ALTER TABLE users ADD COLUMN ai_file_consent_at TEXT');
    console.log('[SQLite] Migration: added ai_file_consent_at column');
  } catch {
    // Column already exists — ignore
  }

  // Migration: ТЗ-102 (UGC + модерация) — SQLite-диалект: ADD COLUMN без
  // IF NOT EXISTS и строго по одной колонке на ALTER (диалектный риск ТЗ-102 §4).
  // created_at сверх буквы ТЗ-102: индекс idx_materials_moderation и FIFO-
  // сортировка очереди модерации опираются на него.
  const lmsV2Columns: Array<[string, string]> = [
    ["origin", "TEXT NOT NULL DEFAULT 'editorial'"],
    ['status', "TEXT NOT NULL DEFAULT 'approved'"],
    ['submitted_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL'],
    ['reviewed_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL'],
    ['reviewed_at', 'TEXT'],
    ['reject_reason', 'TEXT'],
    ["scan_status", "TEXT NOT NULL DEFAULT 'clean'"],
    ['created_at', 'TEXT'], // nullable: ADD COLUMN запрещает expression-default
  ];
  for (const [name, ddl] of lmsV2Columns) {
    try {
      db.run(`ALTER TABLE course_materials ADD COLUMN ${name} ${ddl}`);
      console.log(`[SQLite] Migration: course_materials.${name} added`);
    } catch {
      // Column already exists — ignore
    }
  }
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_materials_moderation ON course_materials(status, created_at)');
  } catch {
    // ignore
  }

  // Migration: ТЗ-123 (материалы урока) — SQLite-диалект: ADD COLUMN без
  // IF NOT EXISTS, строго одна колонка на ALTER (тот же риск, что в ТЗ-102 §4).
  try {
    db.run('ALTER TABLE course_materials ADD COLUMN lesson_id TEXT REFERENCES course_lessons(id) ON DELETE CASCADE');
    console.log('[SQLite] Migration: course_materials.lesson_id added');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_materials_lesson ON course_materials(lesson_id)');
  } catch {
    // ignore
  }

  // Migration: ТЗ-124 (CTA-кнопки урока) — SQLite-диалект: ADD COLUMN без
  // IF NOT EXISTS, строго одна колонка на ALTER (тот же риск, что в ТЗ-102 §4).
  try {
    db.run("ALTER TABLE course_lessons ADD COLUMN buttons TEXT NOT NULL DEFAULT '[]'");
    console.log('[SQLite] Migration: course_lessons.buttons added');
  } catch {
    // Column already exists — ignore
  }

  // Migration: ТЗ-103 (мэтчинг курсов) — эмбеддинг курса как JSON-текст.
  // course_match_suggestions создаётся CREATE TABLE IF NOT EXISTS выше (схема).
  try {
    db.run('ALTER TABLE courses ADD COLUMN embedding TEXT');
    console.log('[SQLite] Migration: courses.embedding added');
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
    // ADM-K: removed boot-time UPDATE that nulled coming_soon_label on every restart.
  } catch {
    // ignore
  }

  // Seed features registry
  try {
    db.run(`INSERT OR IGNORE INTO features_registry (id, label, description) VALUES
      ('telegram', 'Telegram-дайджест', 'Дайджест новостей в Telegram'),
      ('push', 'Push-уведомления', 'Push-уведомления в браузере/приложении'),
      ('ai_summary', 'AI-саммари по портфелю', 'AI-анализ портфеля каждый час'),
      ('alerts', 'Sentiment-алерты', 'Уведомления при резком изменении сентимента'),
      ('priority', 'Приоритетная доставка', 'Приоритет обработки новостей'),
      ('early_delivery', 'Ранняя доставка', 'Доступ к новостям на 5 минут раньше'),
      ('custom_thresholds', 'Кастомные пороги', 'Настройка порогов для алертов'),
      ('club_access', 'Club доступ', 'Доступ к закрытому Telegram-чату'),
      ('api_access', 'API доступ', 'Доступ к REST API с токеном')`);
    console.log('[SQLite] Migration: features_registry seeded');
  } catch {
    // ignore
  }

  saveDb();
  console.log('[SQLite] Schema initialized');
}

export default { query, initSQLite, initSQLiteSchema, saveDb };
