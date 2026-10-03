-- ТЗ-124: CTA-кнопки урока.
-- course_lessons.buttons: JSONB-массив 0–3 элементов
-- [{ label ≤30, url https|/path, color accent/violet/green/ghost,
--    target self|new_tab }]. Валидация — на уровне API (adminEducation),
-- в БД хранится уже нормализованный набор. Идемпотентна (IF NOT EXISTS).
ALTER TABLE course_lessons
  ADD COLUMN IF NOT EXISTS buttons JSONB NOT NULL DEFAULT '[]';
