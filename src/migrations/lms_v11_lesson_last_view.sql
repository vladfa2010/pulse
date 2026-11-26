-- ТЗ-234: последний просмотренный урок + скролл-позиция (resume с проверкой пропусков).
-- scroll_percent NULLABLE: «открывал, но не скроллил» — легальное состояние.
-- Индексов сверх PK не надо: чтения — по (user_id) в /my и по паре в уроке.

CREATE TABLE IF NOT EXISTS lesson_last_view (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id      UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  viewed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scroll_percent REAL,
  PRIMARY KEY (user_id, lesson_id)
);
