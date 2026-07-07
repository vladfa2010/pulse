-- ============================================================
-- PULSE — Subscription plans v2: 4+1 tariffs, payments, freeze
-- ============================================================

-- 1. Plans catalog
CREATE TABLE IF NOT EXISTS subscription_plans (
  id              VARCHAR(20) PRIMARY KEY,
  name            VARCHAR(50) NOT NULL,
  price_monthly   DECIMAL(10,2) NOT NULL,
  price_yearly    DECIMAL(10,2) NOT NULL,
  yearly_discount INTEGER DEFAULT 20,
  tag_limit       INTEGER NOT NULL,
  features        JSONB NOT NULL DEFAULT '{}',
  display_order   INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN DEFAULT TRUE,
  coming_soon_label VARCHAR(50) DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

INSERT INTO subscription_plans
  (id, name, price_monthly, price_yearly, tag_limit, features, display_order, is_active, coming_soon_label)
VALUES
  ('free',    'Free',    0,     0,      3,
   '{"telegram":false,"push":false,"ai_summary":false,"alerts":false,"priority":"normal"}',
   1, TRUE, NULL),
  ('base',    'Base',    450,   4320,   10,
   '{"telegram":true,"push":true,"ai_summary":false,"alerts":false,"priority":"normal"}',
   2, TRUE, NULL),
  ('premium', 'Premium', 990,   9504,   25,
   '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"high"}',
   3, TRUE, NULL),
  ('club',    'Club',    2500,  24000,  -1,
   '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"club_access":true}',
   4, FALSE, 'Скоро'),
  ('pro',     'Pro',     2500,  24000,  -1,
   '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"api_access":true}',
   5, FALSE, 'Скоро')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_monthly = EXCLUDED.price_monthly,
  price_yearly = EXCLUDED.price_yearly,
  tag_limit = EXCLUDED.tag_limit,
  features = EXCLUDED.features,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  coming_soon_label = EXCLUDED.coming_soon_label;

-- 2. Users: plan + scheduled downgrade
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS scheduled_plan_downgrade VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_users_plan' AND table_name = 'users'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_plan
      FOREIGN KEY (subscription_plan) REFERENCES subscription_plans(id);
  END IF;
END $$;

-- Migrate existing users
UPDATE users SET subscription_plan = 'premium'
WHERE subscription_active = TRUE AND (subscription_plan IS NULL OR subscription_plan = 'free');

UPDATE users SET subscription_plan = 'free'
WHERE (subscription_active = FALSE OR subscription_active IS NULL)
  AND (subscription_plan IS NULL OR subscription_plan = '');

-- 3. Payment methods for future auto-renew
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

-- 4. Renewals history
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

-- 5. Payments: plan + cycle + duration
ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_id VARCHAR(20) REFERENCES subscription_plans(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) DEFAULT 'monthly';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS duration_days INTEGER DEFAULT 30;

-- 6. Frozen tags (audit + optional source of truth)
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE;

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

-- 7. Web push subscriptions (VAPID), separate from FCM user_channels
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

-- 8. Webhook events audit log
CREATE TABLE IF NOT EXISTS webhook_events (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider   VARCHAR(20) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  payload    JSONB DEFAULT '{}',
  processed  BOOLEAN DEFAULT FALSE,
  error      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at DESC);
