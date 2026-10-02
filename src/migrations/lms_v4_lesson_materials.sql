-- ТЗ-123: материалы на уровне урока.
-- course_materials.lesson_id: NULL = материал курса (нынешнее поведение),
-- задан = материал урока. Весь контур (storage/ClamAV/модерация/is_free/position)
-- переиспользуется без дублирования. Идемпотентна (IF NOT EXISTS).
ALTER TABLE course_materials
  ADD COLUMN IF NOT EXISTS lesson_id UUID NULL
    REFERENCES course_lessons(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_materials_lesson ON course_materials(lesson_id);
