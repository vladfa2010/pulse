-- Migration: LMS «Образование» — базовые таблицы (ТЗ-100 v15, Задача 1)
-- Run manually or via POST /migrate-lms?secret=KEY.
-- Идемпотентна (CREATE TABLE IF NOT EXISTS) — повторный вызов безопасен.
-- Правило ТЗ: существующие таблицы (news, users, payments, subscription_plans)
-- НЕ изменяются — только FK-ссылки на них.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- в продовой БД уже включено; для устойчивости при пересоздании

-- (v10) Категории курсов — ручная редакционная классификация.
-- Должна создаваться ДО courses (FK category_id).
CREATE TABLE IF NOT EXISTS course_categories (
  id          VARCHAR(50) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title         VARCHAR(255) NOT NULL,
  slug          VARCHAR(255) NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  cover_url     TEXT,
  type          VARCHAR(20) NOT NULL DEFAULT 'course',   -- 'course' | 'situational'
  size          VARCHAR(10) NOT NULL DEFAULT 'standard', -- 'micro' | 'standard' | 'full'
  price         INTEGER NOT NULL DEFAULT 0,              -- рубли, INTEGER (решение ТЗ-100 v1)
  badges        JSONB NOT NULL DEFAULT '[]',
  status        VARCHAR(20) NOT NULL DEFAULT 'draft',    -- 'draft' | 'published' | 'archived'
  visibility    VARCHAR(10) NOT NULL DEFAULT 'public',   -- 'public' | 'hidden'
  subscription_unlock_mode VARCHAR(10) NOT NULL DEFAULT 'full', -- 'full' | 'drip'
  category_id   VARCHAR(50) REFERENCES course_categories(id) ON DELETE SET NULL,
  author        VARCHAR(100) NOT NULL DEFAULT 'Редакция PULSE',
  relevant_until TIMESTAMPTZ,
  source_type   VARCHAR(20),                             -- 'news' | 'cascade' | 'storyline' | 'topic'
  source_news_id UUID REFERENCES news(id) ON DELETE SET NULL,
  deleted_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_array_length(badges) <= 2)
);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_courses_category ON courses(category_id) WHERE deleted_at IS NULL;

-- Единая база тегов: те же tag_id, что у новостей/портфелей.
CREATE TABLE IF NOT EXISTS course_tags (
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  tag_id    VARCHAR(50) NOT NULL,
  PRIMARY KEY (course_id, tag_id)
);

CREATE TABLE IF NOT EXISTS course_lessons (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id     UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  title         VARCHAR(255) NOT NULL,
  kind          VARCHAR(20) NOT NULL DEFAULT 'text',   -- 'text' | 'video' | 'video_text'
  text_content  TEXT,
  video_source  VARCHAR(20),                           -- 'external_embed' | 'hosted' | NULL
  video_embed_url TEXT,
  video_file_url  TEXT,
  duration_min  INTEGER,
  is_free_preview BOOLEAN NOT NULL DEFAULT FALSE,
  unlock_after_days INTEGER NOT NULL DEFAULT 0,
  -- ТЗ-157: ключ идемпотентности создания (NULL у старых уроков)
  idempotency_key TEXT,
  UNIQUE (course_id, position)
);
CREATE INDEX IF NOT EXISTS idx_lessons_course ON course_lessons(course_id, position);
-- ТЗ-157: частичный уникальный индекс — повтор с тем же ключом не создаёт дубль
CREATE UNIQUE INDEX IF NOT EXISTS course_lessons_idem_key
  ON course_lessons (course_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS lesson_tests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id       UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  pass_score      INTEGER NOT NULL DEFAULT 70,
  is_blocking     BOOLEAN NOT NULL DEFAULT FALSE,
  questions       JSONB NOT NULL DEFAULT '[]',
  UNIQUE (lesson_id)
);

CREATE TABLE IF NOT EXISTS course_materials (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL,                    -- 'file' | 'link' | 'news'
  title       VARCHAR(255) NOT NULL,
  url         TEXT NOT NULL,
  news_id     UUID REFERENCES news(id) ON DELETE CASCADE,
  is_free     BOOLEAN NOT NULL DEFAULT FALSE,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_enrollments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source      VARCHAR(20) NOT NULL DEFAULT 'free',     -- 'free' | 'purchase' | 'admin_grant' | 'subscription'
  payment_id  UUID REFERENCES payments(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, course_id)
);

-- Курс включён в тарифы подписки (ссылка на СУЩЕСТВУЮЩУЮ subscription_plans).
CREATE TABLE IF NOT EXISTS course_tariffs (
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  plan_id   VARCHAR(20) NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, plan_id)
);

-- (v8) Шеринг пути: один активный шеринг на юзера, users НЕ трогаем.
CREATE TABLE IF NOT EXISTS user_path_shares (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  test_score   INTEGER,
  PRIMARY KEY (user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS news_course_links (
  news_id   UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (news_id, course_id)
);
