BEGIN;


-- ============================================================
-- ADD NEW SOURCE AND IDENTITY COLUMNS
-- ============================================================

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS issuer_cik TEXT;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS reporting_owner_name TEXT;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS reporting_owner_id TEXT;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS reporting_owner_key TEXT;


UPDATE trades
SET
  reporting_owner_name =
    COALESCE(
      NULLIF(reporting_owner_name, ''),
      ceo
    ),

  reporting_owner_key =
    COALESCE(
      NULLIF(reporting_owner_key, ''),
      LOWER(
        REGEXP_REPLACE(
          TRIM(ceo),
          '\s+',
          ' ',
          'g'
        )
      )
    );


ALTER TABLE trades
ALTER COLUMN reporting_owner_name
SET NOT NULL;


ALTER TABLE trades
ALTER COLUMN reporting_owner_key
SET NOT NULL;


-- ============================================================
-- ADD DATE-RANGE COLUMNS
-- ============================================================

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS first_transaction_date DATE;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS last_transaction_date DATE;


UPDATE trades
SET
  first_transaction_date =
    COALESCE(
      first_transaction_date,
      transaction_date
    ),

  last_transaction_date =
    COALESCE(
      last_transaction_date,
      transaction_date
    );


ALTER TABLE trades
ALTER COLUMN first_transaction_date
SET NOT NULL;


ALTER TABLE trades
ALTER COLUMN last_transaction_date
SET NOT NULL;


-- ============================================================
-- ADD REPORTED-VALUE COLUMNS
-- ============================================================

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS reported_shares
NUMERIC(24, 6) NOT NULL DEFAULT 0;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS reported_average_price
NUMERIC(24, 2) NOT NULL DEFAULT 0;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS reported_total_value
NUMERIC(24, 2) NOT NULL DEFAULT 0;


UPDATE trades
SET
  reported_shares =
    CASE
      WHEN reported_shares = 0
        THEN shares
      ELSE reported_shares
    END,

  reported_average_price =
    CASE
      WHEN reported_average_price = 0
        THEN average_price
      ELSE reported_average_price
    END,

  reported_total_value =
    CASE
      WHEN reported_total_value = 0
        THEN total_value
      ELSE reported_total_value
    END;


-- ============================================================
-- ADD CALCULATION METADATA
-- ============================================================

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS economic_unit_label
TEXT NOT NULL DEFAULT 'securities';


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS ads_ratio
NUMERIC(24, 6);


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS ads_conversion_applied
BOOLEAN NOT NULL DEFAULT FALSE;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS calculation_trusted
BOOLEAN NOT NULL DEFAULT FALSE;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS calculation_warnings
JSONB NOT NULL DEFAULT '[]'::jsonb;


ALTER TABLE trades
ADD COLUMN IF NOT EXISTS ownership_entities
JSONB NOT NULL DEFAULT '[]'::jsonb;


-- Existing records have not been checked using the new rules.
UPDATE trades
SET calculation_trusted = FALSE;


-- ============================================================
-- CHANGE UNKNOWN VALUES FROM ZERO TO NULL
-- ============================================================

ALTER TABLE trades
ALTER COLUMN pct_holdings_change
DROP NOT NULL;


ALTER TABLE trades
ALTER COLUMN pct_holdings_change
DROP DEFAULT;


ALTER TABLE trades
ALTER COLUMN shares_owned_after
DROP NOT NULL;


ALTER TABLE trades
ALTER COLUMN shares_owned_after
DROP DEFAULT;


UPDATE trades
SET
  pct_holdings_change = NULL,
  shares_owned_after = NULL,
  perf =
    '{"sinceTrade":{"changePct":null}}'::jsonb;


ALTER TABLE trades
ALTER COLUMN perf
SET DEFAULT
  '{"sinceTrade":{"changePct":null}}'::jsonb;


-- ============================================================
-- TEMPORARY GROUP LOOKUP INDEX
-- ============================================================

/*
 * Remove the old date-based identity index.
 *
 * Do not create the final unique index yet because the current
 * database still contains multiple cards from the same accession.
 */
DROP INDEX IF EXISTS trades_group_identity_idx;


CREATE INDEX IF NOT EXISTS trades_group_lookup_idx
ON trades (
  accession_number,
  reporting_owner_key,
  trade_type
);


COMMIT;