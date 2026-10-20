-- ТЗ-191: Еженедельный отчёт как страница платформы — снапшоты отчётов и magic-токены доступа.
-- PG-диалект. SQLite-вариант — в initSQLiteSchema() (src/config/db-sqlite.ts).

-- Снапшот отчёта: один на (user_id, week_start). payload — WeeklyReportContent + stats (ТЗ-184)
-- + AI-саммари (ТЗ-191 Задача 2), сериализованный JSON. sent_at — гейт идемпотентной отправки.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ,
  UNIQUE (user_id, week_start)
);

-- Архив юзера: свежие недели первыми
CREATE INDEX IF NOT EXISTS idx_weekly_reports_user_week ON weekly_reports (user_id, week_start DESC);
-- Фаза отправки 13:00: только невысланные снапшоты текущей недели
CREATE INDEX IF NOT EXISTS idx_weekly_reports_unsent ON weekly_reports (week_start) WHERE sent_at IS NULL;

-- Magic-link доступ к архивному отчёту: один токен на отчёт, в БД только SHA-256.
CREATE TABLE IF NOT EXISTS report_access_tokens (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id    UUID NOT NULL REFERENCES weekly_reports(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_id)
);

CREATE INDEX IF NOT EXISTS idx_report_tokens_expires ON report_access_tokens (expires_at);
