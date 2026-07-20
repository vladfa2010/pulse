-- ============================================================
-- Migration: push notifications sent log
-- Prevents duplicate immediate pushes for the same article/user.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_notifications_sent (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  news_id    UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  title      VARCHAR(255),
  source     VARCHAR(50) DEFAULT 'fcm',
  sent_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, news_id)
);

CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_user_id ON push_notifications_sent (user_id);
CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_news_id ON push_notifications_sent (news_id);
