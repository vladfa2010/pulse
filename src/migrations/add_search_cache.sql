-- ============================================================
-- Migration: add search_cache table for fact-check web search caching
-- ============================================================

CREATE TABLE IF NOT EXISTS search_cache (
  query_hash  TEXT PRIMARY KEY,
  results     TEXT,
  expires_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);
