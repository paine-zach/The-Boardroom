-- ============================================================
-- THE BOARDROOM DATABASE SCHEMA
-- ============================================================

-- Stores each grouped Form 4 filing event.
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,

  accession_number TEXT NOT NULL,

  issuer_cik TEXT,

  reporting_owner_name TEXT NOT NULL,
  reporting_owner_id TEXT,
  reporting_owner_key TEXT NOT NULL,

  ceo TEXT NOT NULL,
  officer_title TEXT,

  company TEXT NOT NULL,
  ticker TEXT,
  sector TEXT NOT NULL DEFAULT 'Unknown',

  trade_type TEXT NOT NULL,
  trade_type_label TEXT NOT NULL,

  -- Latest transaction date, used for feed sorting.
  transaction_date DATE NOT NULL,

  -- Full date range represented by the grouped card.
  first_transaction_date DATE NOT NULL,
  last_transaction_date DATE NOT NULL,

  filed_date DATE,

  -- Values as reported by the source before unit conversion.
  reported_shares NUMERIC(24, 6) NOT NULL DEFAULT 0,
  reported_average_price NUMERIC(24, 2) NOT NULL DEFAULT 0,
  reported_total_value NUMERIC(24, 2) NOT NULL DEFAULT 0,

  -- Checked economic values used by the public feed.
  shares NUMERIC(24, 6) NOT NULL DEFAULT 0,
  average_price NUMERIC(24, 2) NOT NULL DEFAULT 0,
  total_value NUMERIC(24, 2) NOT NULL DEFAULT 0,

  economic_unit_label TEXT NOT NULL DEFAULT 'securities',

  ads_ratio NUMERIC(24, 6),
  ads_conversion_applied BOOLEAN NOT NULL DEFAULT FALSE,

  calculation_trusted BOOLEAN NOT NULL DEFAULT FALSE,
  calculation_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,

  ownership_entities JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Unknown values remain NULL rather than appearing as 0.0%.
  pct_holdings_change NUMERIC(12, 4),
  shares_owned_after NUMERIC(24, 6),

  ten_b5_1 BOOLEAN NOT NULL DEFAULT FALSE,

  -- Complete underlying Form 4 transaction lines.
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,

  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,

  source_url TEXT,

  ceo_match BOOLEAN NOT NULL DEFAULT FALSE,
  ceo_match_confidence NUMERIC(8, 4),

  -- Market performance is unavailable until calculated.
  perf JSONB NOT NULL DEFAULT
    '{"sinceTrade":{"changePct":null}}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- One grouped card per accession, reporting owner, and trade type.
CREATE UNIQUE INDEX IF NOT EXISTS trades_group_identity_idx
ON trades (
  accession_number,
  reporting_owner_key,
  trade_type
);


CREATE INDEX IF NOT EXISTS trades_transaction_date_idx
ON trades (transaction_date DESC);


CREATE INDEX IF NOT EXISTS trades_filed_date_idx
ON trades (filed_date DESC);


CREATE INDEX IF NOT EXISTS trades_company_idx
ON trades (company);


CREATE INDEX IF NOT EXISTS trades_ceo_idx
ON trades (ceo);


CREATE INDEX IF NOT EXISTS trades_reporting_owner_idx
ON trades (reporting_owner_key);


CREATE INDEX IF NOT EXISTS trades_ticker_idx
ON trades (ticker);


CREATE INDEX IF NOT EXISTS trades_trade_type_idx
ON trades (trade_type);


CREATE INDEX IF NOT EXISTS trades_total_value_idx
ON trades (total_value DESC);


-- ============================================================
-- PERSISTENT VOTES
-- ============================================================

CREATE TABLE IF NOT EXISTS trade_votes (
  trade_id TEXT NOT NULL
    REFERENCES trades(id)
    ON DELETE CASCADE,

  voter_id TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (trade_id, voter_id)
);


CREATE INDEX IF NOT EXISTS trade_votes_trade_id_idx
ON trade_votes (trade_id);


CREATE INDEX IF NOT EXISTS trade_votes_created_at_idx
ON trade_votes (created_at DESC);


-- ============================================================
-- AUTOMATIC updated_at TIMESTAMP
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DROP TRIGGER IF EXISTS trades_set_updated_at ON trades;


CREATE TRIGGER trades_set_updated_at
BEFORE UPDATE ON trades
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();