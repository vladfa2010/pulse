-- =============================================================================
-- ТЗ-92 (этап 2) — Сюжеты: таблица stories + связь кластеров
--
-- Применять вручную:
--   psql -U pulse_user -d pulse -f src/migrations/news_embeddings_v2.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS stories (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title        TEXT,
  summary      TEXT,
  started_at   TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMP DEFAULT NOW()
);

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS story_id UUID REFERENCES stories(id);

CREATE INDEX IF NOT EXISTS clusters_story ON clusters(story_id);
