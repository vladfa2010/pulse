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
  title_ru        TEXT,
  summary_ru      TEXT,
  title_original  TEXT,
  summary_original TEXT,
  source_type     VARCHAR(20) DEFAULT 'rss',
  lang_original   VARCHAR(2),
  source          VARCHAR(100),
  source_id       VARCHAR(50),
  url             TEXT,
  url_normalized  TEXT,        -- Нормализованный URL (для поиска дубликатов)
  content_hash    TEXT,        -- MD5 от title_ru + summary_ru (группировка дубликатов)
  all_sources     TEXT[] DEFAULT '{}',  -- Все источники публиковавшие эту новость
  source_count    INTEGER DEFAULT 1,    -- Сколько источников опубликовали
  published_at    TIMESTAMPTZ,
  fetched_at      TIMESTAMP DEFAULT NOW(),
  sentiment       VARCHAR(20),
  sentiment_source VARCHAR(20) DEFAULT 'keyword', -- keyword | llm
  matched_tags    TEXT[],
  tag_impact      JSONB DEFAULT '[]',  -- [{"tag":"tesla","impact":"negative","reasoning":"Stock dropped"}]
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(url),              -- Защита по оригинальному URL (один URL = одна запись)
  -- UNIQUE(url_normalized) УБРАНО: normalizeUrl() даёт одинаковый результат
  -- для URL с разными query params (?id=xxx). UNIQUE(url) достаточно.
  UNIQUE(content_hash)      -- Одна новость = одна запись. Дубликаты обновляют all_sources
);

-- ============================================================
-- 5. user_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS user_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  last_connected_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 5c. user_defined_tags (пользовательские теги)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_defined_tags (
  tag_id        VARCHAR(50) PRIMARY KEY,
  tag_name      VARCHAR(100) NOT NULL,
  tag_type      VARCHAR(20) DEFAULT 'company',
  keywords      TEXT[] DEFAULT '{}',
  enriched_data JSONB,                        -- LLM enrichment: ticker, description, synonyms, etc.
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Fallback: если таблица создана без enriched_data (существующие БД)
ALTER TABLE user_defined_tags
  ADD COLUMN IF NOT EXISTS enriched_data JSONB;

-- Index for fast lookup by tag name (deduplication)
CREATE INDEX IF NOT EXISTS idx_user_defined_tags_lower_name
ON user_defined_tags (LOWER(tag_name));

-- ============================================================
-- 5d. news_tag_links (tag ↔ news связи)
-- ============================================================
CREATE TABLE IF NOT EXISTS news_tag_links (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id       UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  tag_id        VARCHAR(50) NOT NULL,
  impact_score  INTEGER,
  impact_reasoning TEXT,
  link_source   VARCHAR(20) NOT NULL DEFAULT 'keyword',
  link_version  INTEGER DEFAULT 1,
  linked_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE(news_id, tag_id, link_source)
);

CREATE INDEX IF NOT EXISTS idx_news_tag_links_news_id ON news_tag_links(news_id);
CREATE INDEX IF NOT EXISTS idx_news_tag_links_tag_id ON news_tag_links(tag_id);

-- ============================================================
-- 5x. news_sources (RSS + API sources)
-- ============================================================
CREATE TABLE IF NOT EXISTS news_sources (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL UNIQUE,
  display_name  VARCHAR(100) NOT NULL,
  type          VARCHAR(20) NOT NULL,      -- 'rss' | 'api_search' | 'api_feed'
  config        JSONB DEFAULT '{}',
  enabled       BOOLEAN DEFAULT true,
  last_fetch_at TIMESTAMP,
  last_error    TEXT,                       -- последняя ошибка (429, timeout, etc)
  last_error_at TIMESTAMP,                  -- когда была ошибка
  error_count   INTEGER DEFAULT 0,          -- счётчик ошибок для мониторинга
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 5b. smart_tag_cache (LLM matching results)
-- ============================================================
CREATE TABLE IF NOT EXISTS smart_tag_cache (
  text_hash   VARCHAR(64) PRIMARY KEY,
  tags        TEXT[] DEFAULT '{}',
  created_at  TIMESTAMP DEFAULT NOW()
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
-- ============================================================
-- 9. user_news_reads (КЛЮЧЕВАЯ: отслеживание прочитанных)
-- ============================================================
-- Каждая запись = пользователь прочитал новость.
-- При запросе ленты: SELECT * FROM news WHERE id NOT IN (
--   SELECT news_id FROM user_news_reads WHERE user_id = $1
-- )
CREATE TABLE IF NOT EXISTS user_news_reads (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  news_id    UUID REFERENCES news(id) ON DELETE CASCADE,
  read_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, news_id)
);

-- Индексы для быстрого исключения прочитанных
CREATE INDEX IF NOT EXISTS idx_user_news_reads_user_id ON user_news_reads (user_id);
CREATE INDEX IF NOT EXISTS idx_user_news_reads_news_id ON user_news_reads (news_id);

-- ============================================================
-- 10. rss_source_meta (SOURCE DEDUP: last fetch time per source)
-- ============================================================
CREATE TABLE IF NOT EXISTS rss_source_meta (
  source_id       VARCHAR(50) PRIMARY KEY,
  last_fetched_at TIMESTAMP NOT NULL DEFAULT NOW() - INTERVAL '24 hours',
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 11. llm_batches (LLM metrics dashboard)
-- ============================================================
CREATE TABLE IF NOT EXISTS llm_batches (
  id              SERIAL PRIMARY KEY,
  status          VARCHAR(20) NOT NULL,  -- 'success', 'partial', 'error', 'keyword-only'
  started_at      TIMESTAMP NOT NULL,
  finished_at     TIMESTAMP NOT NULL,
  articles_count  INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  partial_count   INTEGER NOT NULL DEFAULT 0,
  error_types     JSONB DEFAULT '{}',
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- Индексы (остальные)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_translation_hash ON translation_cache (hash);
CREATE INDEX IF NOT EXISTS idx_llm_batches_created_at ON llm_batches (created_at DESC);

-- ============================================================
-- 12. sentiment_votes (голоса пользователей за индекс настроения)
-- ============================================================
CREATE TABLE IF NOT EXISTS sentiment_votes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_value      SMALLINT NOT NULL CHECK (vote_value IN (-1, 0, 1)),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  tickers         JSONB DEFAULT '[]',
  index_at_vote   INT DEFAULT 0,
  imoex_at_vote   DECIMAL(10,2),
  imoex_after_1h  DECIMAL(10,2),
  index_after_2h  INT,
  check_status    VARCHAR(20) DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_sentiment_votes_user_time ON sentiment_votes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_votes_created    ON sentiment_votes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_votes_check      ON sentiment_votes(check_status, created_at);

-- ============================================================
-- 13. sentiment_user_windows (персональные окна и статистика)
-- ============================================================
CREATE TABLE IF NOT EXISTS sentiment_user_windows (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_vote_at         TIMESTAMPTZ,
  next_vote_at         TIMESTAMPTZ,
  vote_count_today     INT DEFAULT 0,
  total_votes_all_time INT DEFAULT 0,
  sync_count           INT DEFAULT 0,
  total_votes_count    INT DEFAULT 0,
  streak_days          INT DEFAULT 0,
  max_streak_days      INT DEFAULT 0,
  favorite_sentiment   VARCHAR(10) DEFAULT NULL,
  impact_sum           INT DEFAULT 0,
  last_streak_date     DATE DEFAULT NULL,
  unlocked_badges      JSONB DEFAULT '[]',
  forecast_streak      INT DEFAULT 0,
  max_forecast_streak  INT DEFAULT 0,
  contrarian_count     INT DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sentiment_windows_next_vote ON sentiment_user_windows(next_vote_at);

-- ============================================================
-- 14. sentiment_index_cache (кэш текущего индекса)
-- ============================================================
CREATE TABLE IF NOT EXISTS sentiment_index_cache (
  date             DATE PRIMARY KEY,
  current_value    INT DEFAULT 0,
  vote_count       INT DEFAULT 0,
  imoex_candles    JSONB DEFAULT '[]',
  imoex_updated_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

