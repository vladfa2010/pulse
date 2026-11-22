-- ТЗ-218: прегенерированные саммари бакетов — источник истины, переживает рестарты.
-- PG-диалект. SQLite-вариант — в initSQLiteSchema() (src/config/db-sqlite.ts).
-- Ключ кэша: variant='bucket' — sha1(sorted tagIds|range_start|range_end);
-- variant='older' — sha1(sorted tagIds|'older'|MSK-дата генерации) — окно плавает,
-- квантование защищает от LLM-вызова на каждый refetch карусели.
-- Валидность: NOW() < range_end + 24ч; для 'older' — generated_at > NOW() - 24ч.

CREATE TABLE IF NOT EXISTS bucket_summaries (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tags_hash    VARCHAR(64) NOT NULL,          -- sha1(...), см. выше
  range_start  TIMESTAMPTZ NOT NULL,
  range_end    TIMESTAMPTZ NOT NULL,          -- для 'older' плавает (now-24h на момент генерации)
  variant      VARCHAR(8) NOT NULL DEFAULT 'bucket',  -- 'bucket' | 'older'
  summary      TEXT NOT NULL,
  top_news     JSONB NOT NULL,                -- [{id, slug, title, source, sentiment}] топ-4
  model        VARCHAR(32) NOT NULL,          -- провайдер LLM ('kimi'; после ТЗ-217 — адаптер)
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, tags_hash)
);

CREATE INDEX IF NOT EXISTS idx_bs_cleanup ON bucket_summaries (range_end);
