-- ============================================================
-- PULSE Backend — PostgreSQL Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 0. subscription_plans (must exist before users/payments FK)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id              VARCHAR(20) PRIMARY KEY,
  name            VARCHAR(50) NOT NULL,
  price           DECIMAL(10,2) NOT NULL DEFAULT 0,
  billing_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
  yearly_discount INTEGER DEFAULT 0,
  tag_limit       INTEGER NOT NULL,
  features        JSONB NOT NULL DEFAULT '{}',
  display_order   INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  is_popular      BOOLEAN DEFAULT FALSE,
  coming_soon_label VARCHAR(50) DEFAULT NULL,
  plan_level      INTEGER NOT NULL DEFAULT 0,
  deleted_at      TIMESTAMP DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

INSERT INTO subscription_plans
  (id, name, price, billing_frequency, yearly_discount, tag_limit, features, display_order, is_active, is_popular, coming_soon_label, plan_level)
VALUES
  ('free',    'Free',    0,     'monthly', 0,  3,
   '{"telegram":false,"push":false,"ai_summary":false,"alerts":false,"priority":"normal"}',
   1, TRUE, FALSE, NULL, 0),
  ('base',    'Base',    100,   'monthly', 20, 10,
   '{"telegram":true,"push":true,"ai_summary":false,"alerts":false,"priority":"normal"}',
   2, TRUE, FALSE, NULL, 1),
  ('premium', 'Premium', 990,   'monthly', 20, 25,
   '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"high"}',
   3, TRUE, TRUE, NULL, 2),
  ('club',    'Club',    2500,  'monthly', 20, -1,
   '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"club_access":true}',
   4, TRUE, FALSE, 'Скоро', 3),
  ('pro',     'Pro',     2500,  'monthly', 20, -1,
   '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"api_access":true}',
   5, TRUE, FALSE, 'Скоро', 4)
ON CONFLICT (id) DO NOTHING;

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
  subscription_plan      VARCHAR(20) DEFAULT 'free' REFERENCES subscription_plans(id),
  subscription_expires_at TIMESTAMP,
  subscription_auto_renew BOOLEAN DEFAULT TRUE,
  auto_renew_failures    INTEGER DEFAULT 0,
  scheduled_plan_downgrade VARCHAR(20),
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
  is_frozen  BOOLEAN DEFAULT FALSE,
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
  plan_id     VARCHAR(20) REFERENCES subscription_plans(id),
  billing_cycle VARCHAR(10) DEFAULT 'monthly',
  duration_days INTEGER DEFAULT 30,
  is_upgrade  BOOLEAN DEFAULT FALSE,
  promo_code  VARCHAR(50) DEFAULT NULL,
  promo_discount_type VARCHAR(20) DEFAULT NULL,
  promo_discount_value INTEGER DEFAULT NULL,
  paid_at     TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_promo ON payments(promo_code);

-- ============================================================
-- 3b. promo_codes
-- ============================================================
CREATE TABLE IF NOT EXISTS promo_codes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            VARCHAR(50) NOT NULL UNIQUE,
  description     VARCHAR(255) DEFAULT NULL,
  discount_type   VARCHAR(20) NOT NULL DEFAULT 'percent',
  discount_value  INTEGER NOT NULL DEFAULT 0,
  applicable_plans VARCHAR(20)[] DEFAULT NULL,
  max_uses        INTEGER DEFAULT NULL,
  uses_count      INTEGER NOT NULL DEFAULT 0,
  valid_from      TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP DEFAULT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active) WHERE is_active = TRUE;

-- ============================================================
-- 3c. user_promo_uses
-- ============================================================
CREATE TABLE IF NOT EXISTS user_promo_uses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  promo_code_id   UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  plan_id         VARCHAR(20) NOT NULL,
  billing_cycle   VARCHAR(10) NOT NULL,
  discount_applied INTEGER NOT NULL DEFAULT 0,
  trial_days_used INTEGER DEFAULT NULL,
  expected_renewal_price DECIMAL(10,2) DEFAULT NULL,
  payment_id      UUID REFERENCES payments(id),
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, promo_code_id)
);

CREATE INDEX IF NOT EXISTS idx_user_promo_uses_user ON user_promo_uses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_promo_uses_promo ON user_promo_uses(promo_code_id);

-- ============================================================
-- 3d. features_registry
-- ============================================================
CREATE TABLE IF NOT EXISTS features_registry (
  id          VARCHAR(50) PRIMARY KEY,
  label       VARCHAR(100) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

INSERT INTO features_registry (id, label, description) VALUES
  ('telegram', 'Telegram-дайджест', 'Дайджест новостей в Telegram'),
  ('push', 'Push-уведомления', 'Push-уведомления в браузере/приложении'),
  ('ai_summary', 'AI-саммари по портфелю', 'AI-анализ портфеля каждый час'),
  ('alerts', 'Sentiment-алерты', 'Уведомления при резком изменении сентимента'),
  ('priority', 'Приоритетная доставка', 'Приоритет обработки новостей'),
  ('early_delivery', 'Ранняя доставка', 'Доступ к новостям на 5 минут раньше'),
  ('custom_thresholds', 'Кастомные пороги', 'Настройка порогов для алертов'),
  ('club_access', 'Club доступ', 'Доступ к закрытому Telegram-чату'),
  ('api_access', 'API доступ', 'Доступ к REST API с токеном')
ON CONFLICT (id) DO NOTHING;

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
  fact_check_status TEXT NOT NULL DEFAULT 'not_checked'
    CHECK(fact_check_status IN ('not_checked', 'in_progress', 'checked')),
  fact_check_result JSONB DEFAULT NULL,
  slug            VARCHAR(250) UNIQUE,
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
  fact_check_email_enabled BOOLEAN DEFAULT TRUE,
  fact_check_tg_enabled    BOOLEAN DEFAULT TRUE,
  updated_at           TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 7c. user_payment_methods
-- ============================================================
CREATE TABLE IF NOT EXISTS user_payment_methods (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_method_id VARCHAR(255) NOT NULL,
  provider          VARCHAR(20) DEFAULT 'yookassa',
  card_last4        VARCHAR(4),
  card_brand        VARCHAR(20),
  card_expiry       VARCHAR(5),
  is_active         BOOLEAN DEFAULT TRUE,
  is_default        BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMP DEFAULT NOW(),
  deactivated_at    TIMESTAMP,
  UNIQUE(user_id, payment_method_id)
);

CREATE INDEX IF NOT EXISTS idx_user_payment_methods_user_id ON user_payment_methods(user_id);

-- ============================================================
-- 7d. subscription_renewals
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_renewals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         VARCHAR(20) NOT NULL REFERENCES subscription_plans(id),
  billing_cycle   VARCHAR(10) NOT NULL,
  payment_id      UUID REFERENCES payments(id),
  status          VARCHAR(20) NOT NULL,
  period_start    TIMESTAMP NOT NULL,
  period_end      TIMESTAMP NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_renewals_user_id ON subscription_renewals(user_id);
CREATE INDEX IF NOT EXISTS idx_renewals_period_end ON subscription_renewals(period_end);

-- ============================================================
-- 7e. frozen_tags (audit for downgrade)
-- ============================================================
CREATE TABLE IF NOT EXISTS frozen_tags (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_id      VARCHAR(50) NOT NULL,
  tag_name    VARCHAR(100) NOT NULL,
  tag_type    VARCHAR(20) NOT NULL,
  frozen_at   TIMESTAMP DEFAULT NOW(),
  unfrozen_at TIMESTAMP,
  UNIQUE(user_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_frozen_tags_user_id ON frozen_tags(user_id);

-- ============================================================
-- 7f. push_subscriptions (web push VAPID)
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- ============================================================
-- 7g. webhook_events audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider   VARCHAR(20) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload    JSONB DEFAULT '{}',
  processed  BOOLEAN DEFAULT FALSE,
  error      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
-- Migration: ensure auto_renew_failures column exists for existing databases
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_renew_failures INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at DESC);

-- ============================================================
-- 7h. subscription notification log (dedup)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_notifications_sent (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(30) NOT NULL,
  sent_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, type)
);

CREATE INDEX IF NOT EXISTS idx_sub_notif_user_type ON subscription_notifications_sent(user_id, type);

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
CREATE INDEX IF NOT EXISTS idx_news_fact_check_status ON news(fact_check_status);
CREATE INDEX IF NOT EXISTS idx_news_slug ON news(slug);
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
-- 9b. push_notifications_sent (immediate push deduplication)
-- ============================================================
CREATE TABLE IF NOT EXISTS push_notifications_sent (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  news_id    UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  sent_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, news_id)
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_user_id ON push_notifications_sent (user_id);
CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_news_id ON push_notifications_sent (news_id);

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

-- ============================================================
-- 15. password_reset_codes (восстановление пароля)
-- ============================================================
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        VARCHAR(6) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  used        BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_expires
ON password_reset_codes (user_id, expires_at DESC);


-- ============================================================
-- 16. user_events — лог событий пользователей (Activities List)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type  VARCHAR(50) NOT NULL,
  event_data  JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_events_user_id ON user_events(user_id);
CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events(event_type);
CREATE INDEX IF NOT EXISTS idx_user_events_created_at ON user_events(created_at DESC);


-- ============================================================
-- 17. admin_tg_settings — настройки TG-уведомлений админов
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_tg_settings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_chat_id      VARCHAR(50) NOT NULL,
  event_types     TEXT[] DEFAULT '{}',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(admin_user_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_tg_settings_active ON admin_tg_settings(is_active);


-- ============================================================
-- 18. fact_check_jobs — очередь on-demand факт-чекинга новостей
-- ============================================================
CREATE TABLE IF NOT EXISTS fact_check_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id       UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'done', 'failed')),
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(news_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_status ON fact_check_jobs(status);
CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_news_id ON fact_check_jobs(news_id);
CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_user_id ON fact_check_jobs(user_id);


-- ============================================================
-- 19. fact_check_sessions — промежуточные этапы факт-чекинга
-- ============================================================
CREATE TABLE IF NOT EXISTS fact_check_sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id           UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','search','analysis','sources','assessment','completed','failed')),
  queries_json      TEXT,
  sources_json      TEXT,
  sources_count     INTEGER DEFAULT 0,
  fetched_json      TEXT,
  fetched_count     INTEGER DEFAULT 0,
  claims_json       TEXT,
  claims_count      INTEGER DEFAULT 0,
  final_verdict     TEXT,
  final_confidence  INTEGER CHECK(final_confidence BETWEEN 0 AND 100),
  final_reasoning   TEXT,
  error_message     TEXT,
  tokens_input      INTEGER DEFAULT 0,
  tokens_output     INTEGER DEFAULT 0,
  model             TEXT,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fc_sessions_news ON fact_check_sessions(news_id);
CREATE INDEX IF NOT EXISTS idx_fc_sessions_user ON fact_check_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_fc_sessions_status ON fact_check_sessions(status);

-- Migration: обновить CHECK-ограничения для v4 pipeline
ALTER TABLE fact_check_sessions DROP CONSTRAINT IF EXISTS fact_check_sessions_status_check;
ALTER TABLE fact_check_sessions ADD CONSTRAINT fact_check_sessions_status_check
  CHECK(status IN ('pending','search','analysis','sources','assessment','completed','failed'));
ALTER TABLE fact_check_sessions DROP CONSTRAINT IF EXISTS fact_check_sessions_final_verdict_check;


-- ============================================================
-- 20. search_cache — кэш результатов веб-поиска
-- ============================================================
CREATE TABLE IF NOT EXISTS search_cache (
  query_hash  TEXT PRIMARY KEY,
  results     TEXT,
  expires_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);
