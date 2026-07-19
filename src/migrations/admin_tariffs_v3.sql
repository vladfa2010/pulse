-- ============================================================
-- PULSE v3 — Admin tariffs: plan_level, is_popular, deleted_at,
--            billing_frequency, price, promo_codes,
--            user_promo_uses, payments.promo_*, features_registry
-- ============================================================

-- 1. subscription_plans — новые поля + billing_frequency
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_popular BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- billing_frequency: weekly | monthly | quarterly | yearly
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly';

-- price — единая цена за billing_frequency период (заменяет price_monthly/price_yearly)
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Перенос существующих данных: price_monthly → price, billing_frequency = 'monthly'
-- Безопасно для fresh DB, где price_monthly уже не существует
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscription_plans' AND column_name = 'price_monthly'
  ) THEN
    UPDATE subscription_plans SET
      price = price_monthly,
      billing_frequency = 'monthly'
    WHERE price = 0 AND price_monthly IS NOT NULL;
  END IF;
END $$;

-- 2. Инициализация plan_level для существующих тарифов
UPDATE subscription_plans SET plan_level = CASE
  WHEN id = 'free' THEN 0
  WHEN id = 'base' THEN 1
  WHEN id = 'premium' THEN 2
  WHEN id = 'club' THEN 3
  WHEN id = 'pro' THEN 4
END WHERE plan_level = 0;

-- 3. Premium = популярный
UPDATE subscription_plans SET is_popular = TRUE WHERE id = 'premium';

-- 4. Включить club и pro
UPDATE subscription_plans SET is_active = TRUE WHERE id IN ('club', 'pro');

-- 5. payments — promo поля
ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50) DEFAULT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_discount_type VARCHAR(20) DEFAULT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_discount_value INTEGER DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_promo ON payments(promo_code);

-- 6. promo_codes
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

-- 7. user_promo_uses
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

-- 8. features_registry
CREATE TABLE IF NOT EXISTS features_registry (
  id          VARCHAR(50) PRIMARY KEY,
  label       VARCHAR(100) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);
ALTER TABLE features_registry DROP COLUMN IF EXISTS type;
ALTER TABLE features_registry DROP COLUMN IF EXISTS options;
ALTER TABLE features_registry ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

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
