-- =============================================================================
-- ТЗ-91 (этап 1) — Смысловые эмбеддинги новостей: pgvector, колонка и таблицы кластеров
--
-- Применять вручную после задачи 2 (образ pgvector/pgvector):
--   psql -U pulse_user -d pulse -f src/migrations/news_embeddings_v1.sql
--
-- ВАЖНО: HNSW-индекс здесь НЕ создаётся — он строится после бэкфилла (задача 6),
-- иначе вставка 119k векторов будет заметно медленнее.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE news ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE news ADD COLUMN IF NOT EXISTS cluster_id UUID;

CREATE TABLE IF NOT EXISTS clusters (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind               VARCHAR(20) NOT NULL DEFAULT 'cascade',  -- cascade | story_candidate
  tags               TEXT[],
  verdict            VARCHAR(20),        -- сильный | средний | сомнительный
  max_sim            REAL,
  first_published_at TIMESTAMPTZ,
  last_seen_at       TIMESTAMPTZ,
  size               INTEGER NOT NULL DEFAULT 0,
  source             VARCHAR(20) NOT NULL DEFAULT 'realtime', -- realtime | sandbox-import
  created_at         TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cluster_items (
  cluster_id UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  news_id    UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  lag_min    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, news_id)
);

CREATE INDEX IF NOT EXISTS cluster_items_news ON cluster_items(news_id);
CREATE INDEX IF NOT EXISTS clusters_last_seen ON clusters(last_seen_at);
