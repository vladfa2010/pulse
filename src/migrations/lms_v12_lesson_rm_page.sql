-- ТЗ-236: страница читалки (ReadMode) в прогрессе просмотра урока.
-- NULL — читалкой не пользовались / страница не сохранялась.
ALTER TABLE lesson_last_view ADD COLUMN IF NOT EXISTS rm_page INTEGER;
