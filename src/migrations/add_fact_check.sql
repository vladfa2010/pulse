-- Fact-checking feature v3
-- Run manually or via migration endpoint if needed

ALTER TABLE news
  ADD COLUMN IF NOT EXISTS fact_check_status TEXT NOT NULL DEFAULT 'not_checked'
    CHECK(fact_check_status IN ('not_checked', 'in_progress', 'checked')),
  ADD COLUMN IF NOT EXISTS fact_check_result JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_news_fact_check_status ON news(fact_check_status);

CREATE TABLE IF NOT EXISTS fact_check_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id       UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'extracting_claims', 'searching', 'verifying', 'done', 'failed')),
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
