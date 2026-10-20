-- =============================================================================
-- ТЗ-185 — Аналитика виральности: таблица ночных LLM-отчётов по скоупам
--
-- Один скоуп = много строк (история, 3 строки/сутки); API читает последнюю
-- (DISTINCT ON (scope)). Таблица нужна и на VPS, и на Render — на Render
-- скоуп 'topics' в джобе мягко пропускается (TOPICS_ENABLED != 'true'),
-- скоупы каскадов/сюжетов работают на обеих сборках.
--
-- Применять вручную (стиль news_embeddings_v1.sql, PG-only — как весь модуль
-- каскадов):
--   psql -U pulse_user -d pulse -f src/migrations/virality_reports_v1.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid (в PG >= 13 встроен)

CREATE TABLE IF NOT EXISTS virality_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL,              -- 'cascades_24h' | 'stories_7d' | 'topics'
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_ids     UUID[] NOT NULL,            -- снапшот топ-20, для аудита галлюцинаций
  payload       JSONB NOT NULL              -- сырой LLM-ответ (после валидации ключей)
);

CREATE INDEX IF NOT EXISTS virality_reports_scope_time
  ON virality_reports (scope, generated_at DESC);
