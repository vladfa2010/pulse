-- ТЗ-157: идемпотентное создание урока — защита от дублей в списке уроков.
-- Ключ намерения: повторный POST с тем же idempotency_key возвращает
-- уже созданный урок (200 already_created), а не вторую строку.
-- Частичный индекс: NULL-ключи (старые уроки, ручные вставки) не участвуют.
-- Уникальность по (course_id, title) НЕ делаем: одинаковые названия легитимны.
-- SQLite-контур: колонку и индекс добавляет initSQLiteSchema() (db-sqlite.ts).

ALTER TABLE course_lessons ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS course_lessons_idem_key
  ON course_lessons (course_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
