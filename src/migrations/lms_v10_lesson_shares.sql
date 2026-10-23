-- ТЗ-187 «Меджик-линк»: разовый шеринг урока гостю без регистрации.
-- Идемпотентна (IF NOT EXISTS). Применение: POST /migrate-lms-lesson-shares?secret=KEY
-- (см. src/index.ts) или вручную: psql -U pulse_user -d pulse -f src/migrations/lms_v10_lesson_shares.sql
-- SQLite-зеркало — initSQLiteSchema() в src/config/db-sqlite.ts (для смоук-тестов).

CREATE TABLE IF NOT EXISTS lesson_shares (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token             VARCHAR(64) NOT NULL UNIQUE,
  lesson_id         UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  course_id         UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  owner_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  used_ip           VARCHAR(45),
  converted_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Бесплатные ссылки (is_free_preview-урок / бесплатный курс) лимитом не
  -- ограничиваются и квоту платных не расходуют (правка к ТЗ-187).
  is_free           BOOLEAN NOT NULL DEFAULT FALSE
);

-- Квота шеринга: 2 ПЛАТНЫЕ ссылки за скользящие 12 часов на пользователя
CREATE INDEX IF NOT EXISTS idx_lesson_shares_owner_created
  ON lesson_shares(owner_user_id, created_at DESC);

-- Для существующих таблиц (прод до правки): добавить колонку без пересоздания
ALTER TABLE lesson_shares ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;
