-- ТЗ-107 v3: граф знаний (смысловые связи уроков и курсов).
-- Применяется POST /migrate-lms-kg (см. src/index.ts, образец /migrate-lms-matching).
-- Идемпотентна: IF NOT EXISTS везде. SQLite-режим — initSQLiteSchema() в db-sqlite.ts.
-- Вектор урока — BLOB float32[1024]: pgvector-колонку НЕ плодим — поиск
-- пакетный (раз в сутки ночной джобой), вектор читается целиком в память.

CREATE TABLE IF NOT EXISTS lesson_embeddings (
  lesson_id   UUID PRIMARY KEY REFERENCES course_lessons(id) ON DELETE CASCADE,
  model       VARCHAR(50) NOT NULL,              -- 'qwen3-emb-0.6b-1024'
  vector      BYTEA,                             -- float32[1024] little-endian
  text_hash   CHAR(64) NOT NULL,                 -- SHA-256(title + plain text)
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lesson_similarity (
  lesson_a     UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  lesson_b     UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  sim          REAL NOT NULL,
  cross_course BOOLEAN NOT NULL,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lesson_a, lesson_b),
  CHECK (lesson_a::text < lesson_b::text)
);
CREATE INDEX IF NOT EXISTS idx_lessim_a ON lesson_similarity(lesson_a, sim DESC);
CREATE INDEX IF NOT EXISTS idx_lessim_b ON lesson_similarity(lesson_b, sim DESC);

CREATE TABLE IF NOT EXISTS course_similarity (
  course_a     UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  course_b     UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  sim          REAL NOT NULL,                    -- итоговая близость (Задача 2 п.5 ТЗ)
  sim_embed    REAL,                             -- косинус courses.embedding (отладка)
  shared_pairs INTEGER NOT NULL,                 -- cross-пары уроков выше порога
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (course_a, course_b),
  CHECK (course_a::text < course_b::text)
);
