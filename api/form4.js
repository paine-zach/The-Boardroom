import { sql } from "../lib/db.js";

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeSort(value) {
  const allowed = new Set([
    "latest",
    "largest",
    "popular",
  ]);

  const normalized = String(value || "latest").toLowerCase();

  return allowed.has(normalized) ? normalized : "latest";
}

function formatDatabaseDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value);
  const directMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);

  if (directMatch) {
    return directMatch[1];
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
}

function nullableNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function requiredNumber(
  value,
  fallback = 0
) {
  const parsed =
    nullableNumber(value);

  return parsed === null
    ? fallback
    : parsed;
}

function parseJsonValue(
  value,
  fallback
) {
  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  if (
    typeof value === "object"
  ) {
    return value;
  }

  if (
    typeof value === "string"
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function parseJsonArray(value) {
  const parsed =
    parseJsonValue(
      value,
      []
    );

  return Array.isArray(parsed)
    ? parsed
    : [];
}

function normalizePerformance(value) {
  const parsed =
    parseJsonValue(
      value,
      {}
    );

  const performance =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
      ? parsed
      : {};

  const sinceTrade =
    performance.sinceTrade &&
    typeof performance.sinceTrade ===
      "object"
      ? performance.sinceTrade
      : {};

  return {
    ...performance,

    sinceTrade: {
      ...sinceTrade,

      changePct:
        nullableNumber(
          sinceTrade.changePct
        ),
    },
  };
}

function normalizeTradeLine(line) {
  const source =
    line &&
    typeof line === "object"
      ? line
      : {};

  const economicUnits =
    requiredNumber(
      source.economicUnits ??
        source.shares,
      0
    );

  const calculatedValue =
    source.calculationTrusted ===
    false
      ? null
      : nullableNumber(
          source.calculatedValue ??
            source.value
        );

  return {
    id:
      source.id || null,

    transactionDedupeKey:
      source.transactionDedupeKey ||
      null,

    transactionIndex:
      nullableNumber(
        source.transactionIndex
      ),

    transactionDate:
      formatDatabaseDate(
        source.transactionDate
      ),

    filedDate:
      formatDatabaseDate(
        source.filedDate
      ),

    transactionCode:
      source.transactionCode ||
      "",

    acquiredDisposedCode:
      source.acquiredDisposedCode ||
      null,

    securityTitle:
      source.securityTitle ||
      "Unknown Security",

    ownershipForm:
      source.ownershipForm ||
      null,

    natureOfOwnership:
      source.natureOfOwnership ||
      null,

    ownershipEntity:
      source.ownershipEntity ||
      null,

    reportedShares:
      requiredNumber(
        source.reportedShares,
        0
      ),

    reportedPrice:
      requiredNumber(
        source.reportedPrice,
        0
      ),

    reportedTransactionValue:
      requiredNumber(
        source
          .reportedTransactionValue,
        0
      ),

    reportedSharesOwnedAfter:
      nullableNumber(
        source
          .reportedSharesOwnedAfter
      ),

    adsRatio:
      nullableNumber(
        source.adsRatio
      ),

    priceIsPerAds:
      Boolean(
        source.priceIsPerAds
      ),

    adsConversionApplied:
      Boolean(
        source
          .adsConversionApplied
      ),

    economicUnits,

    economicUnitLabel:
      source.economicUnitLabel ||
      "securities",

    calculatedValue,

    calculationTrusted:
      source.calculationTrusted ===
      true,

    calculationWarnings:
      parseJsonArray(
        source
          .calculationWarnings
      ),

    tenB51:
      Boolean(
        source.tenB51
      ),

    /*
     * Compatibility aliases for the existing frontend.
     */
    shares:
      economicUnits,

    price:
      requiredNumber(
        source.reportedPrice ??
          source.price,
        0
      ),

    value:
      calculatedValue,
  };
}

function collectTransactionDates(
  lines,
  firstTransactionDate,
  lastTransactionDate
) {
  const dates = lines
    .map(
      (line) =>
        line.transactionDate
    )
    .filter(Boolean);

  if (firstTransactionDate) {
    dates.push(
      firstTransactionDate
    );
  }

  if (lastTransactionDate) {
    dates.push(
      lastTransactionDate
    );
  }

  return [
    ...new Set(dates),
  ].sort(
    (a, b) =>
      new Date(a) -
      new Date(b)
  );
}

function mapTradeRow(row) {
  const lines =
    parseJsonArray(
      row.lines
    ).map(
      normalizeTradeLine
    );

  const firstTransactionDate =
    formatDatabaseDate(
      row.first_transaction_date ||
        row.transaction_date
    );

  const lastTransactionDate =
    formatDatabaseDate(
      row.last_transaction_date ||
        row.transaction_date
    );

  const transactionDates =
    collectTransactionDates(
      lines,
      firstTransactionDate,
      lastTransactionDate
    );

  const tenB51 =
    Boolean(
      row.ten_b5_1
    );

  const calculationTrusted =
    row.calculation_trusted ===
    true;

  return {
    id:
      row.id,

    accessionNumber:
      row.accession_number,

    issuerCik:
      row.issuer_cik || null,

    reportingOwnerName:
      row.reporting_owner_name ||
      row.ceo,

    reportingOwnerId:
      row.reporting_owner_id ||
      null,

    reportingOwnerKey:
      row.reporting_owner_key ||
      null,

    ceo:
      row.ceo,

    officerTitle:
      row.officer_title || "",

    company:
      row.company,

    ticker:
      row.ticker || "N/A",

    sector:
      row.sector || "Unknown",

    tradeType:
      row.trade_type,

    tradeTypeLabel:
      row.trade_type_label,

    /*
     * The primary card date is the latest transaction date.
     */
    transactionDate:
      formatDatabaseDate(
        row.transaction_date
      ),

    firstTransactionDate,

    lastTransactionDate,

    transactionDates,

    filedDate:
      formatDatabaseDate(
        row.filed_date
      ),

    /*
     * Original values retained for filing audits.
     */
    reportedShares:
      requiredNumber(
        row.reported_shares,
        0
      ),

    reportedPrice:
      requiredNumber(
        row.reported_average_price,
        0
      ),

    reportedValue:
      requiredNumber(
        row.reported_total_value,
        0
      ),

    /*
     * Checked public values.
     */
    shares:
      requiredNumber(
        row.shares,
        0
      ),

    price:
      requiredNumber(
        row.average_price,
        0
      ),

    value:
      calculationTrusted
        ? requiredNumber(
            row.total_value,
            0
          )
        : null,

    economicUnitLabel:
      row.economic_unit_label ||
      "securities",

    adsRatio:
      nullableNumber(
        row.ads_ratio
      ),

    adsConversionApplied:
      Boolean(
        row.ads_conversion_applied
      ),

    calculationTrusted,

    calculationWarnings:
      parseJsonArray(
        row.calculation_warnings
      ),

    ownershipEntities:
      parseJsonArray(
        row.ownership_entities
      ),

    /*
     * Unknown ownership values remain null.
     */
    pctHoldingsChange:
      nullableNumber(
        row.pct_holdings_change
      ),

    sharesOwnedAfter:
      nullableNumber(
        row.shares_owned_after
      ),

    tenB51,

    planStatus:
      tenB51
        ? "10b5-1"
        : "not-indicated",

    lines,

    title:
      row.title ||
      "Form 4 transaction",

    summary:
      row.summary ||
      "No summary available.",

    tags:
      parseJsonArray(
        row.tags
      ),

    sourceUrl:
      row.source_url || "#",

    ceoMatch:
      Boolean(
        row.ceo_match
      ),

    ceoMatchConfidence:
      nullableNumber(
        row
          .ceo_match_confidence
      ),

    /*
     * Uncalculated performance becomes null, never zero.
     */
    perf:
      normalizePerformance(
        row.perf
      ),

    upvotes:
      requiredNumber(
        row.upvotes,
        0
      ),

    voted:
      Boolean(
        row.voted
      ),

    createdAt:
      row.created_at || null,

    updatedAt:
      row.updated_at || null,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res.status(405).json({
        error: "Method not allowed",
      });
    }

    const q = req.query || {};

    const limit = clampInteger(q.limit, 50, 1, 100);
    const offset = clampInteger(q.offset, 0, 0, 1_000_000);
    const sort = normalizeSort(q.sort);

    const company = String(q.company || "").trim();
    const ceo = String(q.ceo || "").trim();
    const ticker = String(q.ticker || "").trim();
   const tradeType =
  String(
    q.trade_type || ""
  ).trim();

const search =
  String(
    q.search || ""
  )
    .trim()
    .toLowerCase();

/*
 * Small trades remain stored in Neon.
 *
 * By default, buy and sell cards below $100K are hidden.
 * Compensation events remain visible because their reported cash
 * value may legitimately be zero.
 *
 * The frontend Show all control will send show_all=true.
 */
const showAll =
  [
    "true",
    "1",
    "yes",
  ].includes(
    String(
      q.show_all ??
        q.showAll ??
        ""
    )
      .trim()
      .toLowerCase()
  );

const minimumValue =
  clampInteger(
    q.min_value ??
      q.minValue,
    100_000,
    0,
    1_000_000_000
  );
    const searchPattern = `%${search}%`;
    const voterId =
  String(
    q.voter_id ??
      q.voterId ??
      ""
  ).trim();

if (
  voterId &&
  !/^[a-zA-Z0-9_-]{8,128}$/.test(
    voterId
  )
) {
  return res.status(400).json({
    error:
      "Invalid voter ID.",
  });
}

    let rows;

    if (sort === "largest") {
      rows = await sql`
        SELECT
  t.*,
  COUNT(v.trade_id)::integer AS upvotes,

  EXISTS (
    SELECT 1
    FROM trade_votes current_vote
    WHERE
      current_vote.trade_id = t.id
      AND current_vote.voter_id = ${voterId}
  ) AS voted
        FROM trades t
        LEFT JOIN trade_votes v
          ON v.trade_id = t.id
        WHERE
          (${company} = '' OR t.company = ${company})
          AND (${ceo} = '' OR t.ceo = ${ceo})
          AND (${ticker} = '' OR t.ticker = ${ticker})
          AND (${tradeType} = '' OR t.trade_type = ${tradeType})

AND (
  ${showAll}
  OR t.trade_type NOT IN ('buy', 'sell')
  OR t.total_value >= ${minimumValue}
)

AND (
  ${search} = ''
            OR LOWER(t.company) LIKE ${searchPattern}
            OR LOWER(t.ceo) LIKE ${searchPattern}
OR LOWER(COALESCE(t.reporting_owner_name, '')) LIKE ${searchPattern}
OR LOWER(COALESCE(t.ticker, '')) LIKE ${searchPattern}
            OR LOWER(t.title) LIKE ${searchPattern}
            OR LOWER(t.summary) LIKE ${searchPattern}
          )
        GROUP BY t.id
        ORDER BY
          t.total_value DESC,
          t.transaction_date DESC,
          t.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    } else if (sort === "popular") {
      rows = await sql`
        SELECT
  t.*,
  COUNT(v.trade_id)::integer AS upvotes,

  EXISTS (
    SELECT 1
    FROM trade_votes current_vote
    WHERE
      current_vote.trade_id = t.id
      AND current_vote.voter_id = ${voterId}
  ) AS voted
        FROM trades t
        LEFT JOIN trade_votes v
          ON v.trade_id = t.id
        WHERE
          (${company} = '' OR t.company = ${company})
          AND (${ceo} = '' OR t.ceo = ${ceo})
          AND (${ticker} = '' OR t.ticker = ${ticker})
          AND (${tradeType} = '' OR t.trade_type = ${tradeType})

AND (
  ${showAll}
  OR t.trade_type NOT IN ('buy', 'sell')
  OR t.total_value >= ${minimumValue}
)

AND (
  ${search} = ''
            OR LOWER(t.company) LIKE ${searchPattern}
            OR LOWER(t.ceo) LIKE ${searchPattern}
OR LOWER(COALESCE(t.reporting_owner_name, '')) LIKE ${searchPattern}
OR LOWER(COALESCE(t.ticker, '')) LIKE ${searchPattern}
            OR LOWER(t.title) LIKE ${searchPattern}
            OR LOWER(t.summary) LIKE ${searchPattern}
          )
        GROUP BY t.id
        ORDER BY
          upvotes DESC,
          t.transaction_date DESC,
          t.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT
  t.*,
  COUNT(v.trade_id)::integer AS upvotes,

  EXISTS (
    SELECT 1
    FROM trade_votes current_vote
    WHERE
      current_vote.trade_id = t.id
      AND current_vote.voter_id = ${voterId}
  ) AS voted
        FROM trades t
        LEFT JOIN trade_votes v
          ON v.trade_id = t.id
        WHERE
          (${company} = '' OR t.company = ${company})
          AND (${ceo} = '' OR t.ceo = ${ceo})
          AND (${ticker} = '' OR t.ticker = ${ticker})
          AND (${tradeType} = '' OR t.trade_type = ${tradeType})

AND (
  ${showAll}
  OR t.trade_type NOT IN ('buy', 'sell')
  OR t.total_value >= ${minimumValue}
)

AND (
  ${search} = ''
            OR LOWER(t.company) LIKE ${searchPattern}
            OR LOWER(t.ceo) LIKE ${searchPattern}
OR LOWER(COALESCE(t.reporting_owner_name, '')) LIKE ${searchPattern}
OR LOWER(COALESCE(t.ticker, '')) LIKE ${searchPattern}
            OR LOWER(t.title) LIKE ${searchPattern}
            OR LOWER(t.summary) LIKE ${searchPattern}
          )
        GROUP BY t.id
        ORDER BY
          t.transaction_date DESC,
          t.filed_date DESC,
          t.created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    }

    const countRows = await sql`
      SELECT COUNT(*)::integer AS total
      FROM trades t
      WHERE
        (${company} = '' OR t.company = ${company})
        AND (${ceo} = '' OR t.ceo = ${ceo})
        AND (${ticker} = '' OR t.ticker = ${ticker})
        AND (${tradeType} = '' OR t.trade_type = ${tradeType})

AND (
  ${showAll}
  OR t.trade_type NOT IN ('buy', 'sell')
  OR t.total_value >= ${minimumValue}
)

AND (
  ${search} = ''
          OR LOWER(t.company) LIKE ${searchPattern}
          OR LOWER(t.ceo) LIKE ${searchPattern}
OR LOWER(COALESCE(t.reporting_owner_name, '')) LIKE ${searchPattern}
OR LOWER(COALESCE(t.ticker, '')) LIKE ${searchPattern}
          OR LOWER(t.title) LIKE ${searchPattern}
          OR LOWER(t.summary) LIKE ${searchPattern}
        )
    `;

    const trades = rows.map(mapTradeRow);
    const total = Number(countRows?.[0]?.total || 0);

    res.setHeader(
  "Cache-Control",
  voterId
    ? "private, no-store, max-age=0"
    : "s-maxage=60, stale-while-revalidate=300"
);

    return res.status(200).json({
      source: "neon-postgres",
      trades,
      count: trades.length,
      total,
      fetchedAt: new Date().toISOString(),

      pagination: {
        limit,
        offset,
        hasMore: offset + trades.length < total,
        nextOffset: offset + trades.length,
      },

      query: {
  sort,
  company,
  ceo,
  ticker,
  tradeType,
  search,

  showAll,

  minimumValue:
    showAll
      ? null
      : minimumValue,
},
    });
  } catch (error) {
    console.error("Stored Form 4 feed error:", error);

    return res.status(500).json({
      error: "Could not load stored Form 4 trades.",
      detail:
        process.env.NODE_ENV === "production"
          ? undefined
          : String(error?.message || error),
    });
  }
}