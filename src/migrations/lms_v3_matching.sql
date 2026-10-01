-- =============================================================================
-- ТЗ-103 — LMS: мэтчинг курсов с новостями (эмбеддинги курсов + рекомендации)
--
-- Применять вручную после lms_v1.sql и lms_v2_ugc.sql:
--   psql -U pulse_user -d pulse -f src/migrations/lms_v3_matching.sql
-- или через POST /migrate-lms-matching?secret=KEY.
-- Идемпотентна (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).
--
-- HNSW-индекс НЕ создаётся намеренно: курсов десятки, seq scan по vector(1024)
-- — микросекунды (в отличие от 119k новостей).
-- =============================================================================

-- Эмбеддинг курса (PG: pgvector; SQLite-режим: TEXT JSON — db-sqlite.ts).
-- Текст: title + '\n' + description + '\n' + названия уроков (обрезка 1000).
ALTER TABLE courses ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Рекомендации «новость ↔ курс». Система только РЕКОМЕНДУЕТ — автоприкрепления
-- нет (решение редактора: attach/dismiss ниже). Переходы status + decided_by/
-- decided_at — датасет обратной связи для будущего замера precision
-- (отдельная таблица match_feedback НЕ делается — осознанное упрощение ТЗ-103).
CREATE TABLE IF NOT EXISTS course_match_suggestions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  news_id     UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  score       REAL,                    -- NULL = LLM не оценивал (лимит)
  reason      TEXT,                    -- фраза от LLM или 'общий тег: X'
  source      VARCHAR(20) NOT NULL,    -- tag | embedding | both
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | attached | dismissed
  decided_by  UUID,                    -- user id редактора; вместе со status
  decided_at  TIMESTAMPTZ,             -- это и есть датасет обратной связи
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (course_id, news_id)
);
CREATE INDEX IF NOT EXISTS cms_course_status ON course_match_suggestions(course_id, status);
