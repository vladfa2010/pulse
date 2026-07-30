-- =============================================================================
-- PULSE — Broker portfolios V1
-- =============================================================================
-- V1: API-key only portfolios (Finam / BCS / Inside broker stub).
-- Manual positions and imports are in backlog and are not created by this
-- migration. Tables intentionally use broker_* prefix because `portfolios`
-- is already used for user tag subscriptions.
-- =============================================================================

-- ── API keys for broker integrations ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broker_keys (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker              TEXT NOT NULL CHECK (broker IN ('inside', 'finam', 'bcs', 'other')),
  label               TEXT NOT NULL DEFAULT '',
  token_encrypted     TEXT NOT NULL,
  token_tail          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  last_error          TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_keys_user_broker
  ON broker_keys(user_id, broker);

-- ── Broker-linked portfolios (one per key in V1, may become manual later) ──────
CREATE TABLE IF NOT EXISTS broker_portfolios (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker              TEXT NOT NULL CHECK (broker IN ('inside', 'finam', 'bcs', 'other')),
  name                TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'manual', 'import')),
  broker_key_id       UUID REFERENCES broker_keys(id) ON DELETE SET NULL,
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, broker, name)
);

CREATE INDEX IF NOT EXISTS idx_broker_portfolios_user_broker_name
  ON broker_portfolios(user_id, broker, name);

-- ── Positions inside a broker portfolio ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS broker_positions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broker_portfolio_id UUID NOT NULL REFERENCES broker_portfolios(id) ON DELETE CASCADE,
  ticker              TEXT NOT NULL,
  exchange            TEXT NOT NULL DEFAULT 'MOEX',
  company_name        TEXT,
  quantity            NUMERIC(20, 6) NOT NULL,
  avg_price           NUMERIC(20, 6),
  currency            TEXT NOT NULL DEFAULT 'RUB',
  external_id         TEXT,
  source              TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'manual', 'import')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (broker_portfolio_id, ticker, exchange)
);

CREATE INDEX IF NOT EXISTS idx_broker_positions_portfolio_ticker_exchange
  ON broker_positions(broker_portfolio_id, ticker, exchange);

-- Trigger: update `updated_at` automatically on row changes
CREATE OR REPLACE FUNCTION update_broker_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'broker_keys_updated_at'
  ) THEN
    CREATE TRIGGER broker_keys_updated_at
      BEFORE UPDATE ON broker_keys
      FOR EACH ROW EXECUTE FUNCTION update_broker_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'broker_portfolios_updated_at'
  ) THEN
    CREATE TRIGGER broker_portfolios_updated_at
      BEFORE UPDATE ON broker_portfolios
      FOR EACH ROW EXECUTE FUNCTION update_broker_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'broker_positions_updated_at'
  ) THEN
    CREATE TRIGGER broker_positions_updated_at
      BEFORE UPDATE ON broker_positions
      FOR EACH ROW EXECUTE FUNCTION update_broker_updated_at();
  END IF;
END $$;
