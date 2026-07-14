-- ============================================================
-- Migration: simplify fact_check_jobs CHECK constraint
-- Removes old intermediate statuses, keeps only queued/done/failed
-- ============================================================

-- PostgreSQL
ALTER TABLE fact_check_jobs DROP CONSTRAINT IF EXISTS fact_check_jobs_status_check;
ALTER TABLE fact_check_jobs ADD CONSTRAINT fact_check_jobs_status_check
  CHECK (status IN ('queued', 'done', 'failed'));

-- SQLite (if needed): recreate table
-- BEGIN TRANSACTION;
-- CREATE TABLE fact_check_jobs_new (
--   id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
--   news_id TEXT NOT NULL REFERENCES news(id) ON DELETE CASCADE,
--   user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed')),
--   error_message TEXT,
--   attempts INTEGER NOT NULL DEFAULT 0,
--   max_attempts INTEGER NOT NULL DEFAULT 3,
--   next_retry_at DATETIME,
--   created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
--   updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
--   UNIQUE(news_id, user_id)
-- );
-- INSERT INTO fact_check_jobs_new SELECT * FROM fact_check_jobs;
-- DROP TABLE fact_check_jobs;
-- ALTER TABLE fact_check_jobs_new RENAME TO fact_check_jobs;
-- COMMIT;
