-- ============================================================
-- THE BOARDROOM — TRANSACTION ACCURACY FOUNDATION
-- Run once in Neon before deploying the Phase 1 importer/API.
-- This migration is additive and does not delete existing cards or votes.
-- ============================================================

BEGIN;

-- Preserve the source name separately from the reader-facing name.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS raw_ceo_name TEXT,
  ADD COLUMN IF NOT EXISTS display_ceo_name TEXT;

-- Separate the broad feed category from the detailed transaction subtype.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS card_category TEXT NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS market_action TEXT,
  ADD COLUMN IF NOT EXISTS compensation_subtypes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Explicit security totals prevent shares and options from being combined
-- under one misleading unit label.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS common_shares_acquired NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS common_shares_disposed NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares_withheld NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_common_shares NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS options_acquired NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS options_disposed NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS average_exercise_price NUMERIC(24, 2),
  ADD COLUMN IF NOT EXISTS security_totals JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Describe what the aggregate price/value means. Compensation cards may
-- legitimately have no meaningful aggregate transaction price or cash value.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS price_basis TEXT,
  ADD COLUMN IF NOT EXISTS value_basis TEXT;

-- These flags will keep awards, grants, gifts, withholding, and option events
-- out of market rankings and performance leaderboards.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS ranking_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS performance_eligible BOOLEAN NOT NULL DEFAULT FALSE;

-- Stable public identity for future permanent links and Share buttons.
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS permanent_slug TEXT;

-- Missing or inapplicable prices/values must be NULL rather than invented zero.
ALTER TABLE trades
  ALTER COLUMN reported_average_price DROP NOT NULL,
  ALTER COLUMN reported_average_price DROP DEFAULT,
  ALTER COLUMN reported_total_value DROP NOT NULL,
  ALTER COLUMN reported_total_value DROP DEFAULT,
  ALTER COLUMN average_price DROP NOT NULL,
  ALTER COLUMN average_price DROP DEFAULT,
  ALTER COLUMN total_value DROP NOT NULL,
  ALTER COLUMN total_value DROP DEFAULT;

-- Seed safe compatibility values for existing cards. These are only temporary;
-- the cards will be rebuilt from source filings after the importer is updated.
UPDATE trades
SET
  raw_ceo_name = COALESCE(raw_ceo_name, reporting_owner_name, ceo),
  display_ceo_name = COALESCE(display_ceo_name, ceo, reporting_owner_name),
  card_category = CASE
    WHEN trade_type IN ('buy', 'sell') THEN 'market'
    WHEN trade_type IN ('award', 'option', 'withholding', 'gift') THEN 'compensation'
    ELSE COALESCE(NULLIF(card_category, ''), 'other')
  END,
  market_action = CASE
    WHEN trade_type IN ('buy', 'sell') THEN trade_type
    ELSE NULL
  END,
  compensation_subtypes = CASE
    WHEN trade_type IN ('award', 'option', 'withholding', 'gift')
      THEN jsonb_build_array(trade_type)
    ELSE COALESCE(compensation_subtypes, '[]'::jsonb)
  END,
  price_basis = CASE
    WHEN trade_type IN ('buy', 'sell') THEN 'weighted_average_transaction_price'
    ELSE NULL
  END,
  value_basis = CASE
    WHEN trade_type = 'buy' THEN 'estimated_purchase_cost'
    WHEN trade_type = 'sell' THEN 'estimated_sale_proceeds'
    ELSE NULL
  END,
  ranking_eligible = (
    trade_type IN ('buy', 'sell')
    AND calculation_trusted = TRUE
    AND average_price IS NOT NULL
    AND average_price > 0
    AND total_value IS NOT NULL
  ),
  performance_eligible = (
    trade_type IN ('buy', 'sell')
    AND calculation_trusted = TRUE
    AND average_price IS NOT NULL
    AND average_price > 0
    AND shares > 0
  ),
  permanent_slug = COALESCE(NULLIF(permanent_slug, ''), id)
WHERE
  raw_ceo_name IS NULL
  OR display_ceo_name IS NULL
  OR permanent_slug IS NULL
  OR card_category = 'other'
  OR (
    trade_type IN ('buy', 'sell')
    AND market_action IS NULL
  );

CREATE INDEX IF NOT EXISTS trades_card_category_idx
ON trades (card_category);

CREATE INDEX IF NOT EXISTS trades_market_action_idx
ON trades (market_action);

CREATE INDEX IF NOT EXISTS trades_ranking_eligible_idx
ON trades (ranking_eligible, trade_type, total_value DESC);

CREATE INDEX IF NOT EXISTS trades_performance_eligible_idx
ON trades (performance_eligible, trade_type, transaction_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS trades_permanent_slug_idx
ON trades (permanent_slug)
WHERE permanent_slug IS NOT NULL;

COMMIT;
