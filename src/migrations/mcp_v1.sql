-- ТЗ-183/ТЗ-185: MCP-токены и аудит вызовов инструментов.
-- PG-диалект. SQLite-вариант — в initSQLiteSchema() (src/config/db-sqlite.ts).

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           VARCHAR(64) NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  prefix         VARCHAR(24) NOT NULL,
  scopes         VARCHAR(32) NOT NULL DEFAULT 'read',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  requests_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user_id ON mcp_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_expires ON mcp_tokens (expires_at);

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_id    UUID REFERENCES mcp_tokens(id) ON DELETE SET NULL,
  user_id     UUID NOT NULL,
  tool        VARCHAR(64) NOT NULL,
  args        JSONB,
  status      VARCHAR(10) NOT NULL,
  duration_ms INTEGER,
  ip          VARCHAR(45),
  user_agent  VARCHAR(256),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_created ON mcp_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_token ON mcp_audit_log (token_id);
