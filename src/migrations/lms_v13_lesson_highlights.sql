-- ТЗ-237: выделения и заметки в уроках (W3C TextQuoteSelector-якоря).
-- Правки аудита: REFERENCES course_lessons (не lessons), uuid_generate_v4
-- (стандарт lms-линейки, uuid-ossp включён в lms_v1).
CREATE TABLE IF NOT EXISTS lesson_highlights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  exact_text TEXT NOT NULL,
  prefix VARCHAR(64),
  suffix VARCHAR(64),
  pos_hint INTEGER,
  note TEXT,
  kind VARCHAR(8) NOT NULL DEFAULT 'hl',
  share_token VARCHAR(64) UNIQUE,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_highlights_user_lesson ON lesson_highlights(user_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_highlights_review ON lesson_highlights(user_id, (COALESCE(last_reviewed_at, created_at)));
