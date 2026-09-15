-- ТЗ-115 — Темы: таблицы ночной HDBSCAN-кластеризации эмбеддингов (третий уровень
-- пирамиды: ТЕМА недели–месяцы → СЮЖЕТ дни–недели → КАСКАД часы–сутки).
-- Воркер: topics-worker (Python-sidecar, one-shot, --profile worker, 03:40 МСК).
-- Нейминг тем: Node-cron topics-naming (04:10 МСК, LLM по конвенциям §9.1 методологии).
--
-- Применение: ТОЛЬКО на VPS (psql -U pulse_user -d pulse -f src/migrations/topics_v1.sql
-- из /opt/pulse). На Render-БД НЕ применять — там вкладка «Темы» скрыта флагом,
-- ручки отвечают 404, таблиц быть не должно.
--
-- Осознанное отклонение от стиля news_embeddings_v1.sql: файл обёрнут в транзакцию —
-- эталон транзакции не имеет, но для 3 таблиц с FK атомарность важнее единообразия.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- в продовой БД уже включено; для устойчивости при пересоздании

CREATE TABLE IF NOT EXISTS topic_runs (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  window_days   integer NOT NULL,
  news_count    integer,
  topics_found  integer,
  noise_count   integer,
  params        jsonb,               -- {min_cluster_size, min_samples, pca_dims, jaccard_threshold}
  status        text NOT NULL DEFAULT 'running',  -- running | done | error
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE IF NOT EXISTS topics (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        uuid NOT NULL REFERENCES topic_runs(id) ON DELETE CASCADE,
  prev_topic_id uuid REFERENCES topics(id),       -- сматчено с темой прошлого прогона (Jaccard)
  label         integer NOT NULL,                 -- номер кластера из HDBSCAN
  name          text,                             -- заполняет Node-cron topics-naming
  summary       text,
  named         boolean NOT NULL DEFAULT false,
  keywords      jsonb,                            -- top-terms (TF-IDF по текстам кластера)
  news_count    integer NOT NULL,
  span_days     numeric,
  sources_count integer,
  trend         text,                             -- growing | stable | fading
  daily         jsonb,                            -- [{d: 'YYYY-MM-DD', n: 12}, ...] по Europe/Moscow
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topic_items (
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  news_id  uuid NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  is_core  boolean NOT NULL DEFAULT false,        -- membership_probability >= 0.5
  PRIMARY KEY (topic_id, news_id)
);

CREATE INDEX IF NOT EXISTS idx_topic_items_news ON topic_items(news_id);
CREATE INDEX IF NOT EXISTS idx_topics_run ON topics(run_id);

COMMIT;
