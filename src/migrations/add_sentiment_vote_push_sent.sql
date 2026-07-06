-- ============================================================
-- Migration: лог отправки пушей-напоминаний для голосования
-- 1 пуш на пользователя в сутки
-- ============================================================

CREATE TABLE IF NOT EXISTS sentiment_vote_push_sent (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_date  DATE NOT NULL,  -- календарная дата по МСК
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, sent_date)
);

CREATE INDEX IF NOT EXISTS idx_sentiment_vote_push_sent_user_id ON sentiment_vote_push_sent (user_id);
CREATE INDEX IF NOT EXISTS idx_sentiment_vote_push_sent_date ON sentiment_vote_push_sent (sent_date);
