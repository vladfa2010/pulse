-- ТЗ-218: карусель саммари бакетов «Пока вас не было» — архивация просмотров бакетов.
-- PG-диалект. SQLite-вариант — в initSQLiteSchema() (src/config/db-sqlite.ts).
-- Просмотр бакета = архивация карточки: одна строка на (user, bucket_start);
-- sentinel bucket_start = 'epoch' — просмотр корешка «Вчера» (variant older).

CREATE TABLE IF NOT EXISTS user_bucket_reads (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_start TIMESTAMPTZ NOT NULL,          -- начало окна бакета (UTC-инстант границы МСК); 'epoch' для «Вчера»
  bucket_end   TIMESTAMPTZ NOT NULL,
  viewed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_ubr_user ON user_bucket_reads (user_id);
