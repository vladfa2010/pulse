-- TZ-197-club: закрытый Telegram-канал «Клуб» — членство и контроль доступа.
-- PG-диалект. SQLite-вариант — в initSQLiteSchema() (src/config/db-sqlite.ts).
-- v2: + is_manual / manual_revoked_at (ручные выдачи админом, аудит их не сносит).
-- v3: kick_reason пополняется 'no_access_at_join' / 'invite_expired'.

CREATE TABLE IF NOT EXISTS telegram_club_members (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user_id   VARCHAR(32),             -- Telegram user id (= user_channels.target), NULL до вступления
  invite_link  TEXT,                    -- последняя выданная персональная ссылка
  status       VARCHAR(16) NOT NULL DEFAULT 'invited',  -- invited | member | kicked | left
  invited_at   TIMESTAMP DEFAULT NOW(),
  joined_at    TIMESTAMP,
  kicked_at    TIMESTAMP,
  kick_reason  VARCHAR(32),             -- 'subscription_expired' | 'feature_disabled' | 'manual_leave' | 'admin' | 'no_access_at_join' (v3) | 'invite_expired' (v3)
  -- v2: ручная выдача доступа админом без тарифа. Пока is_manual=TRUE и
  -- manual_revoked_at IS NULL — доступ есть, крон-аудит такого юзера ПРОПУСКАЕТ.
  is_manual         BOOLEAN NOT NULL DEFAULT FALSE,
  manual_revoked_at TIMESTAMP DEFAULT NULL,
  updated_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tg_club_members_status ON telegram_club_members(status);
CREATE INDEX IF NOT EXISTS idx_tg_club_members_tg_user ON telegram_club_members(tg_user_id);
