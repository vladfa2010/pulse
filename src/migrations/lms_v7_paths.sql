-- ТЗ-105 v2: программы (плейлисты курсов).
-- Применяется POST /migrate-lms-paths (см. src/index.ts, образец /migrate-lms-matching).
-- Идемпотентна: IF NOT EXISTS везде. SQLite-режим — initSQLiteSchema() в db-sqlite.ts.

CREATE TABLE IF NOT EXISTS course_paths (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       VARCHAR(255) NOT NULL,
  slug        VARCHAR(255) NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  cover_url   TEXT,
  status      VARCHAR(20) NOT NULL DEFAULT 'draft',   -- 'draft' | 'published' | 'archived'
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_path_items (
  path_id   UUID NOT NULL REFERENCES course_paths(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,          -- непрерывная 1..N
  PRIMARY KEY (path_id, course_id)
);

CREATE TABLE IF NOT EXISTS course_path_enrollments (
  path_id    UUID NOT NULL REFERENCES course_paths(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (path_id, user_id)
);
