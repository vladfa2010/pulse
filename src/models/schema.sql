-- ============================================================
-- PULSE Backend — PostgreSQL Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) NOT NULL UNIQUE,
  username        VARCHAR(30) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  is_verified     BOOLEAN DEFAULT FALSE,
  subscription_active    BOOLEAN DEFAULT FALSE,
  subscription_expires_at TIMESTAMP,
  subscription_auto_renew BOOLEAN DEFAULT TRUE,
  news_count      INTEGER DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 2. portfolios
-- ============================================================
CREATE TABLE IF NOT EXISTS portfolios (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  tag_id     VARCHAR(50) NOT NULL,
  tag_name   VARCHAR(100) NOT NULL,
  tag_type   VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, tag_id)
);

-- ============================================================
-- 3. payments (КРИТИЧНО)
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  amount      DECIMAL(10,2) NOT NULL,
  base_amount DECIMAL(10,2) NOT NULL DEFAULT 490.00,
  discount    INTEGER DEFAULT 0,
  method      VARCHAR(50) NOT NULL,
  status      VARCHAR(20) DEFAULT 'pending',
  provider_ref VARCHAR(255),
  paid_at     TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 4. news
-- ============================================================
CREATE TABLE IF NOT EXISTS news (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title_ru        TEXT NOT NULL,
  summary_ru      TEXT,
  title_original  TEXT,
  lang_original   VARCHAR(2),
  source          VARCHAR(100),
  source_id       VARCHAR(50),
  url             TEXT,
  published_at    TIMESTAMP,
  fetched_at      TIMESTAMP DEFAULT NOW(),
  sentiment       VARCHAR(20),
  matched_tags    TEXT[],
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 5. user_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS user_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  last_connected_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 6. user_channels (TG / Email)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_channels (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  channel    VARCHAR(20) NOT NULL,
  target     VARCHAR(255) NOT NULL,
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, channel)
);

-- ============================================================
-- 7. notification_settings
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_enabled           BOOLEAN DEFAULT TRUE,
  email_enabled        BOOLEAN DEFAULT TRUE,
  push_enabled         BOOLEAN DEFAULT FALSE,
  report_frequency     VARCHAR(20) DEFAULT 'weekly',
  report_type          VARCHAR(20) DEFAULT 'all',
  alert_negative       BOOLEAN DEFAULT TRUE,
  alert_positive       BOOLEAN DEFAULT TRUE,
  alert_threshold      INTEGER DEFAULT 3,
  report_time          VARCHAR(5) DEFAULT '13:00',
  quiet_hours_start    VARCHAR(5) DEFAULT '22:00',
  quiet_hours_end      VARCHAR(5) DEFAULT '08:00',
  quiet_hours_enabled  BOOLEAN DEFAULT TRUE,
  report_format        VARCHAR(20) DEFAULT 'full',
  report_language      VARCHAR(10) DEFAULT 'ru',
  updated_at           TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 8. translation_cache
-- ============================================================
CREATE TABLE IF NOT EXISTS translation_cache (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hash       VARCHAR(64) NOT NULL UNIQUE,
  text_en    TEXT NOT NULL,
  text_ru    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Индексы
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_news_matched_tags ON news USING GIN (matched_tags);
CREATE INDEX IF NOT EXISTS idx_news_published_at ON news (published_at);
CREATE INDEX IF NOT EXISTS idx_news_source_id ON news (source_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_user_channels_user_id ON user_channels (user_id);
CREATE INDEX IF NOT EXISTS idx_translation_hash ON translation_cache (hash);
