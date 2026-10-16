-- ТЗ-177: порог косинусной записи предложений на уровне курса.
-- embedding_threshold REAL NULL: NULL = поведение как раньше (косинусные пары
-- без LLM не пишутся), число 0.30–0.95 = пары с sim >= порога пишутся
-- (score NULL, source 'embedding'). Идемпотентна.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS embedding_threshold REAL;
