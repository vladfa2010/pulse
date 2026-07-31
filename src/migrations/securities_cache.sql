-- =============================================================================
-- PULSE — Securities cache for broker position names
-- Caches instrument short names, ISIN and type from broker API (Finam Trade API).
-- =============================================================================

CREATE TABLE IF NOT EXISTS securities (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticker      TEXT NOT NULL,
  exchange    TEXT NOT NULL,
  short_name  TEXT,                       -- name from GetAsset (NULL on cache miss / negative cache)
  isin        TEXT,
  sec_type    TEXT,                       -- EQUITIES | BONDS | ... (from GetAsset.type)
  source      TEXT NOT NULL DEFAULT 'finam',
  resolved_at TIMESTAMPTZ NOT NULL,
  UNIQUE (ticker, exchange)
);

CREATE INDEX IF NOT EXISTS idx_securities_ticker_exchange ON securities(ticker, exchange);

-- PostgreSQL-specific: 30-day positive cache, 7-day negative cache
-- (SQLite uses the same table structure but cache freshness is checked in code.)
