-- =============================================================================
-- PULSE — Article Enrichment v3.0 Migration
-- =============================================================================
-- Phase 1: Schema
-- 
-- Запуск: psql $DATABASE_URL -f enrichment_v3.sql
-- Или через endpoint: POST /migrate-v3-enrichment

-- 1. Таблица связей статья-тег с контекстом LLM-анализа
CREATE TABLE IF NOT EXISTS news_tag_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id         UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  tag_id          VARCHAR(50) NOT NULL,
  impact_score    INTEGER,              -- из tag_impacts[i].score (-10..+10)
  impact_reasoning TEXT,                -- из tag_impacts[i].reasoning
  link_source     VARCHAR(20) NOT NULL DEFAULT 'keyword',
    -- 'keyword'    = matched_tags (Layer 1)
    -- 'llm_impact' = из unified batch tag_impacts
    -- 'hashtag'    = из внешней БД (#тег)
  link_version    INTEGER DEFAULT 1,
  linked_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE(news_id, tag_id, link_source)
);

-- 2. Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_news_tag_links_news_id ON news_tag_links(news_id);
CREATE INDEX IF NOT EXISTS idx_news_tag_links_tag_id ON news_tag_links(tag_id);

-- 3. Версионирование обогащения (для будущих пересчётов)
ALTER TABLE news ADD COLUMN IF NOT EXISTS enrichment_version INTEGER DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_news_enrichment_version ON news(enrichment_version);

-- 4. GIN индекс для поиска по тегу в старых статьях (через @>)
CREATE INDEX IF NOT EXISTS idx_news_tag_impact_gin ON news USING GIN (tag_impact jsonb_path_ops);

-- =============================================================================
-- Проверка
-- =============================================================================
SELECT 'news_tag_links created' as check, COUNT(*) as rows FROM news_tag_links
UNION ALL
SELECT 'news with enrichment_version', COUNT(*) FROM news WHERE enrichment_version IS NOT NULL;
