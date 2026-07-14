-- ============================================================
-- Migration: add fact_check_sessions table for v3 pipeline stages
-- ============================================================

CREATE TABLE IF NOT EXISTS fact_check_sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id           UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','queries','search','fetch','claims','verdict','completed','failed')),
  queries_json      TEXT,
  sources_json      TEXT,
  sources_count     INTEGER DEFAULT 0,
  fetched_json      TEXT,
  fetched_count     INTEGER DEFAULT 0,
  claims_json       TEXT,
  claims_count      INTEGER DEFAULT 0,
  final_verdict     TEXT CHECK(final_verdict IN ('reliable','partly_reliable','unreliable','unverified')),
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
