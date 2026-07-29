-- =============================================================================
-- PULSE — Notification Matrix v1
-- Единая матрица подписок: продукт × канал.
-- Заменяет разрозненные колонки notification_settings:
--   tg_digest_enabled / digest_frequency / last_digest_sent
--   email_digest_enabled / digest_email
--   tg_enabled / email_enabled / report_format
--   fact_check_tg_enabled / fact_check_email_enabled
-- Старые колонки НЕ удаляются (rollback), но перестают быть источником правды.
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product       VARCHAR(32) NOT NULL,   -- 'digest' | 'weekly_report' | 'fact_check'
  channel       VARCHAR(16) NOT NULL,   -- 'telegram' | 'email' | 'push'
  enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  frequency     VARCHAR(8),             -- только для digest: '1h'|'3h'|'6h'|'12h'|'24h'
  last_sent_at  TIMESTAMPTZ,            -- per product+channel (НЕ общий, как раньше)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product, channel)
);

CREATE INDEX IF NOT EXISTS idx_notif_subs_lookup
  ON notification_subscriptions (product, channel) WHERE enabled = TRUE;

-- ── Backfill: TG-дайджест ───────────────────────────────────────────────────
INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency, last_sent_at)
SELECT user_id, 'digest', 'telegram',
       COALESCE(tg_digest_enabled, FALSE),
       COALESCE(digest_frequency, '1h'),
       last_digest_sent
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: Email-дайджест (настройка существовала, отправителя не было) ──
INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency)
SELECT user_id, 'digest', 'email',
       COALESCE(email_digest_enabled, FALSE),
       COALESCE(digest_frequency, '1h')
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: Push-дайджест ─────────────────────────────────────────────────
INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency)
SELECT user_id, 'digest', 'push',
       COALESCE(push_enabled, FALSE),
       COALESCE(digest_frequency, '1h')
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: Weekly report (tg/email/push) ─────────────────────────────────
INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'weekly_report', 'telegram', COALESCE(tg_enabled, TRUE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'weekly_report', 'email', COALESCE(email_enabled, TRUE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'weekly_report', 'push', COALESCE(push_enabled, FALSE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: Fact-check notifications ──────────────────────────────────────
INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'fact_check', 'telegram', COALESCE(fact_check_tg_enabled, TRUE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'fact_check', 'email', COALESCE(fact_check_email_enabled, TRUE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: мгновенные пуши о новых статьях (push.ts:pushArticleToUsers) ──
-- Раньше управлялись общим push_enabled — теперь отдельный продукт.
INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'news_alert', 'push', COALESCE(push_enabled, FALSE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: engagement (sentiment-напоминания и др. механики) ───────────
-- Раньше гейтились общим push_enabled — наследуем его.
INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'engagement', 'push', COALESCE(push_enabled, FALSE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Backfill: биллинг-уведомления (истечение подписки, оплата) ─────────────
-- Раньше: web_push_enabled (пуши) и безусловные email.
INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'billing', 'push', COALESCE(web_push_enabled, TRUE)
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT user_id, 'billing', 'email', TRUE   -- transactional email: включён, отключается явно
FROM notification_settings
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- ── Добор: юзеры БЕЗ строки notification_settings (legacy) ─────────────────
-- Основной backfill их не покрывает → матрица была бы пустой (см. аудит D-1/D-8).
-- Заводим дефолты, идентичные дефолтам схемы notification_settings.
INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency)
SELECT u.id, 'digest', 'telegram', FALSE, '1h' FROM users u
WHERE NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id)
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT u.id, 'weekly_report', 'telegram', TRUE FROM users u
WHERE NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id)
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT u.id, 'weekly_report', 'email', TRUE FROM users u
WHERE NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id)
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT u.id, 'fact_check', 'telegram', TRUE FROM users u
WHERE NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id)
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT u.id, 'fact_check', 'email', TRUE FROM users u
WHERE NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id)
ON CONFLICT (user_id, product, channel) DO NOTHING;

INSERT INTO notification_subscriptions (user_id, product, channel, enabled)
SELECT u.id, 'billing', 'email', TRUE FROM users u
WHERE NOT EXISTS (SELECT 1 FROM notification_settings ns WHERE ns.user_id = u.id)
ON CONFLICT (user_id, product, channel) DO NOTHING;

-- digest_email (отдельный адрес для дайджеста) остаётся в notification_settings —
-- это не подписка, а адрес доставки. Используется каналом email как override.
