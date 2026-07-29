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

  const normalized = String(
    value || "latest"
  ).toLowerCase();

  return allowed.has(normalized)
    ? normalized
    : "latest";
}

function normalizeView(value) {
  const allowed = new Set([
    "all",
    "latest",
    "largest-buys",
    "largest-sells",
    "compensation",
  ]);

  const normalized = String(
    value || "latest"
  )
    .trim()
    .toLowerCase();

  return allowed.has(normalized)
    ? normalized
    : "latest";
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(
    value ?? ""
  )
    .trim()
    .toLowerCase();

  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function formatDatabaseDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value);
  const directMatch = text.match(
    /^(\d{4}-\d{2}-\d{2})/
  );

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

function numberOrZero(value) {
  return nullableNumber(value) ?? 0;
}
const CEO_NAME_SUFFIXES = new Map([
  ["JR", "Jr."],
  ["SR", "Sr."],
  ["II", "II"],
  ["III", "III"],
  ["IV", "IV"],
  ["V", "V"],
]);

function normalizeComparableName(value) {
  return String(value ?? "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function titleCaseCeoNameToken(value) {
  const token = String(
    value ?? ""
  ).trim();

  if (!token) {
    return "";
  }

  const upper = token
    .replace(/\./g, "")
    .toUpperCase();

  if (CEO_NAME_SUFFIXES.has(upper)) {
    return CEO_NAME_SUFFIXES.get(upper);
  }

  if (/^[A-Z]$/.test(upper)) {
    return `${upper}.`;
  }

  const titleCasePiece = (piece) => {
    if (!piece) {
      return piece;
    }

    const lower = piece.toLowerCase();

    let output =
      lower.charAt(0).toUpperCase() +
      lower.slice(1);

    if (/^mc[a-z]/i.test(output)) {
      output =
        output.slice(0, 2) +
        output.charAt(2).toUpperCase() +
        output.slice(3);
    }

    return output;
  };

  return token
    .split("-")
    .map((hyphenPart) =>
      hyphenPart
        .split("'")
        .map(titleCasePiece)
        .join("'")
    )
    .join("-");
}

function formatLegacySecCeoName(value) {
  const normalized = String(
    value || "Unknown CEO"
  )
    .replace(/\s+/g, " ")
    .trim();

  if (
    !normalized ||
    normalized === "Unknown CEO"
  ) {
    return "Unknown CEO";
  }

  if (normalized.includes(",")) {
    const [
      lastPart,
      ...remainingParts
    ] = normalized.split(",");

    return [
      ...remainingParts
        .join(" ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(titleCaseCeoNameToken),

      titleCaseCeoNameToken(
        lastPart
      ),
    ]
      .filter(Boolean)
      .join(" ");
  }

  const tokens = normalized
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length < 2) {
    return tokens
      .map(titleCaseCeoNameToken)
      .join(" ");
  }

  /*
   * SEC reporting-owner names are normally supplied as:
   *
   * LAST FIRST MIDDLE SUFFIX
   */
  const lastName = tokens[0];
  const givenAndMiddle =
    tokens.slice(1);

  const suffixTokens = [];

  while (
    givenAndMiddle.length &&
    CEO_NAME_SUFFIXES.has(
      givenAndMiddle[
        givenAndMiddle.length - 1
      ]
        .replace(/\./g, "")
        .toUpperCase()
    )
  ) {
    suffixTokens.unshift(
      givenAndMiddle.pop()
    );
  }

  return [
    ...givenAndMiddle.map(
      titleCaseCeoNameToken
    ),

    titleCaseCeoNameToken(
      lastName
    ),

    ...suffixTokens.map(
      titleCaseCeoNameToken
    ),
  ]
    .filter(Boolean)
    .join(" ");
}

function parseJsonValue(value, fallback) {
  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  if (typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

function parseJsonArray(value) {
  const parsed = parseJsonValue(
    value,
    []
  );

  return Array.isArray(parsed)
    ? parsed
    : [];
}

function parseJsonObject(value) {
  const parsed = parseJsonValue(
    value,
    {}
  );

  return (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed)
  )
    ? parsed
    : {};
}

function normalizeTradeLine(line) {
  const source = (
    line &&
    typeof line === "object"
  )
    ? line
    : {};

  const economicUnits = numberOrZero(
    source.economicUnits ??
      source.shares
  );

  const reportedPrice = nullableNumber(
    source.reportedPrice
  );

  const exercisePrice = nullableNumber(
    source.exercisePrice
  );

  const displayPrice = nullableNumber(
    source.price ??
      exercisePrice ??
      reportedPrice
  );

  const calculatedValue =
    source.calculationTrusted === false
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
      source.transactionCode || "",

    transactionNature:
      source.transactionNature || null,

    acquiredDisposedCode:
      source.acquiredDisposedCode || null,

    securityTitle:
      source.securityTitle ||
      "Unknown Security",

    securityKind:
      source.securityKind || null,

    sourceTable:
      source.sourceTable || null,

    cardCategory:
      source.cardCategory || null,

    compensationSubtype:
      source.compensationSubtype || null,

    ownershipForm:
      source.ownershipForm || null,

    natureOfOwnership:
      source.natureOfOwnership || null,

    ownershipEntity:
      source.ownershipEntity || null,

    reportedShares:
      numberOrZero(
        source.reportedShares
      ),

    reportedPrice,

    exercisePrice,

    reportedTransactionValue:
      nullableNumber(
        source.reportedTransactionValue
      ),

    reportedSharesOwnedAfter:
      nullableNumber(
        source.reportedSharesOwnedAfter
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
        source.adsConversionApplied
      ),

    economicUnits,

    economicUnitLabel:
      source.economicUnitLabel ||
      "securities",

    calculatedValue,

    valueRole:
      source.valueRole || null,

    calculationTrusted:
      source.calculationTrusted === true,

    calculationWarnings:
      parseJsonArray(
        source.calculationWarnings
      ),

    tenB51:
      Boolean(source.tenB51),

    isMarketTransaction:
      Boolean(
        source.isMarketTransaction
      ),

    isCompensationEvent:
      Boolean(
        source.isCompensationEvent
      ),

    isWithholding:
      Boolean(
        source.isWithholding
      ),

    /*
     * Compatibility aliases for the current frontend.
     * Missing and inapplicable prices remain null.
     */
    shares:
      economicUnits,

    price:
      displayPrice,

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
    dates.push(firstTransactionDate);
  }

  if (lastTransactionDate) {
    dates.push(lastTransactionDate);
  }

  return [
    ...new Set(dates),
  ].sort(
    (a, b) =>
      new Date(a) -
      new Date(b)
  );
}

function normalizeSecurityTotals(row) {
  const stored = parseJsonObject(
    row.security_totals
  );

  return {
    ...stored,

    commonSharesAcquired:
      numberOrZero(
        row.common_shares_acquired ??
          stored.commonSharesAcquired
      ),

    commonSharesDisposed:
      numberOrZero(
        row.common_shares_disposed ??
          stored.commonSharesDisposed
      ),

    sharesWithheld:
      numberOrZero(
        row.shares_withheld ??
          stored.sharesWithheld
      ),

    netCommonShares:
      numberOrZero(
        row.net_common_shares ??
          stored.netCommonShares
      ),

    optionsAcquired:
      numberOrZero(
        row.options_acquired ??
          stored.optionsAcquired
      ),

    optionsDisposed:
      numberOrZero(
        row.options_disposed ??
          stored.optionsDisposed
      ),

    averageExercisePrice:
      nullableNumber(
        row.average_exercise_price ??
          stored.averageExercisePrice
      ),
  };
}

function mapTradeRow(row) {
  const lines = parseJsonArray(
    row.lines
  ).map(normalizeTradeLine);

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

  const tenB51 = Boolean(
    row.ten_b5_1
  );

  const calculationTrusted =
    row.calculation_trusted === true;

  const isMarketCard =
    row.card_category ===
      "market" ||
    [
      "buy",
      "sell",
    ].includes(
      row.trade_type
    );

  const usableMarketPrice =
    nullableNumber(
      row.average_price
    );

  const securityTotals =
    normalizeSecurityTotals(row);

  const rawCeoName =
    row.raw_ceo_name ||
    row.reporting_owner_name ||
    row.ceo ||
    "Unknown CEO";

  const storedDisplayCeoName =
    row.display_ceo_name ||
    row.ceo ||
    rawCeoName;

  /*
   * The migration copied legacy CEO names into display_ceo_name.
   * When the stored display name is effectively identical to the
   * raw SEC name, calculate the reader-facing order here.
   */
  const displayCeoName =
    normalizeComparableName(
      storedDisplayCeoName
    ) ===
    normalizeComparableName(
      rawCeoName
    )
      ? formatLegacySecCeoName(
          rawCeoName
        )
      : storedDisplayCeoName;

  return {
    id:
      row.id,

    permanentSlug:
      row.permanent_slug ||
      row.id,

    accessionNumber:
      row.accession_number,

    issuerCik:
      row.issuer_cik || null,

    reportingOwnerName:
      row.reporting_owner_name ||
      row.raw_ceo_name ||
      displayCeoName,

    reportingOwnerId:
      row.reporting_owner_id || null,

    reportingOwnerKey:
      row.reporting_owner_key || null,

    rawCeoName,

    displayCeoName,

    ceo:
      displayCeoName,

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

    cardCategory:
      row.card_category || "other",

    marketAction:
      row.market_action || null,

    compensationSubtypes:
      parseJsonArray(
        row.compensation_subtypes
      ),

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

    reportedShares:
      numberOrZero(
        row.reported_shares
      ),

    reportedPrice:
      nullableNumber(
        row.reported_average_price
      ),

    reportedValue:
      nullableNumber(
        row.reported_total_value
      ),

    shares:
      numberOrZero(
        row.shares
      ),

    price:
      nullableNumber(
        row.average_price
      ),

    value:
      calculationTrusted &&
      (
        !isMarketCard ||
        (
          usableMarketPrice !== null &&
          usableMarketPrice > 0
        )
      )
        ? nullableNumber(
            row.total_value
          )
        : null,

    economicUnitLabel:
      row.economic_unit_label ||
      "securities",

    commonSharesAcquired:
      securityTotals
        .commonSharesAcquired,

    commonSharesDisposed:
      securityTotals
        .commonSharesDisposed,

    sharesWithheld:
      securityTotals
        .sharesWithheld,

    netCommonShares:
      securityTotals
        .netCommonShares,

    optionsAcquired:
      securityTotals
        .optionsAcquired,

    optionsDisposed:
      securityTotals
        .optionsDisposed,

    averageExercisePrice:
      securityTotals
        .averageExercisePrice,

    securityTotals,

    priceBasis:
      row.price_basis || null,

    valueBasis:
      row.value_basis || null,

    rankingEligible:
      row.ranking_eligible === true,

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
        row.ceo_match_confidence
      ),

    upvotes:
      numberOrZero(
        row.upvotes
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

    const limit = clampInteger(
      q.limit,
      50,
      1,
      100
    );

    const offset = clampInteger(
      q.offset,
      0,
      0,
      1_000_000
    );

    let sort = normalizeSort(
      q.sort
    );

    const view = normalizeView(
      q.view
    );

    const company = String(
      q.company || ""
    ).trim();

    const ceo = String(
      q.ceo || ""
    ).trim();

    const ticker = String(
      q.ticker || ""
    ).trim();

    const requestedTrade = String(
      q.trade ??
        q.permanent_slug ??
        ""
    ).trim();

    let tradeType = String(
      q.trade_type ??
        q.tradeType ??
        ""
    ).trim();

    let cardCategory = String(
      q.card_category ??
        q.cardCategory ??
        ""
    ).trim();

    let marketAction = String(
      q.market_action ??
        q.marketAction ??
        ""
    ).trim();

    const search = String(
      q.search || ""
    )
      .trim()
      .toLowerCase();

    const searchPattern =
      `%${search}%`;

    const year = clampInteger(
      q.year,
      0,
      0,
      9999
    );

    const plan = [
      "yes",
      "no",
    ].includes(
      String(
        q.plan || ""
      ).toLowerCase()
    )
      ? String(
          q.plan
        ).toLowerCase()
      : "";

    const valueBand = new Set([
      "lt1m",
      "1to5m",
      "5to25m",
      "gt25m",
    ]).has(
      String(
        q.value_band ??
          q.valueBand ??
          ""
      ).toLowerCase()
    )
      ? String(
          q.value_band ??
            q.valueBand
        ).toLowerCase()
      : "";

    const includeFacets =
      normalizeBoolean(
        q.include_facets ??
          q.includeFacets,
        offset === 0
      );

    const showAll = normalizeBoolean(
      q.show_all ??
        q.showAll,
      false
    );

    const rankingEligibleOnly =
      normalizeBoolean(
        q.ranking_eligible ??
          q.rankingEligible,
        false
      );

    /*
     * Public feed views intentionally use only SEC Form 4 data.
     * Performance rankings and market-price calculations are no
     * longer part of the product.
     */
    if (view === "latest") {
      cardCategory = "market";
      tradeType = "";
      sort = "latest";
    } else if (
      view === "largest-buys"
    ) {
      cardCategory = "market";
      tradeType = "";
      marketAction = "buy";
      sort = "largest";
    } else if (
      view === "largest-sells"
    ) {
      cardCategory = "market";
      tradeType = "";
      marketAction = "sell";
      sort = "largest";
    } else if (
      view === "compensation"
    ) {
      cardCategory =
        "compensation";
      tradeType = "";
      marketAction = "";
      sort = "latest";
    }

    const requiresRankableValue =
      !requestedTrade &&
      (
        view === "largest-buys" ||
        view === "largest-sells"
      );

    if (requestedTrade) {
      cardCategory = "";
      tradeType = "";
      marketAction = "";
      sort = "latest";
    }

    const minimumValue = clampInteger(
      q.min_value ??
        q.minValue,
      0,
      0,
      1_000_000_000
    );

    const voterId = String(
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
        error: "Invalid voter ID.",
      });
    }

    const rows = await sql`
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
        (
          ${requestedTrade} = ''
          OR t.id = ${requestedTrade}
          OR t.permanent_slug =
            ${requestedTrade}
        )

        AND
        (
          ${company} = ''
          OR t.company = ${company}
        )

        AND (
          ${ceo} = ''
          OR t.display_ceo_name = ${ceo}
          OR t.ceo = ${ceo}
          OR t.reporting_owner_name = ${ceo}
        )

        AND (
          ${ticker} = ''
          OR t.ticker = ${ticker}
        )

        AND (
          ${tradeType} = ''
          OR t.trade_type = ${tradeType}
        )

        AND (
          ${cardCategory} = ''
          OR t.card_category = ${cardCategory}
        )

        AND (
          ${marketAction} = ''
          OR t.market_action = ${marketAction}
        )

        AND LOWER(
          COALESCE(
            t.officer_title,
            ''
          )
        ) !~ (
          '(^|[^a-z])regional([^a-z]|$)' ||
          '|southern africa' ||
          '|north america' ||
          '|latin america' ||
          '|asia pacific' ||
          '|(^|[^a-z])emea([^a-z]|$)' ||
          '|(^|[^a-z])apac([^a-z]|$)'
        )

        AND (
          ${year} = 0
          OR EXTRACT(
            YEAR FROM t.filed_date
          )::integer = ${year}
        )

        AND (
          ${plan} = ''
          OR (
            ${plan} = 'yes'
            AND t.ten_b5_1 = TRUE
          )
          OR (
            ${plan} = 'no'
            AND t.ten_b5_1 = FALSE
          )
        )

        AND (
          ${valueBand} = ''
          OR (
            ${valueBand} = 'lt1m'
            AND t.total_value >= 0
            AND t.total_value < 1000000
          )
          OR (
            ${valueBand} = '1to5m'
            AND t.total_value >= 1000000
            AND t.total_value < 5000000
          )
          OR (
            ${valueBand} = '5to25m'
            AND t.total_value >= 5000000
            AND t.total_value < 25000000
          )
          OR (
            ${valueBand} = 'gt25m'
            AND t.total_value >= 25000000
          )
        )

        AND (
          NOT ${rankingEligibleOnly}
          OR t.ranking_eligible = TRUE
        )

        AND (
          NOT ${requiresRankableValue}
          OR (
            t.total_value IS NOT NULL
            AND t.total_value > 0
          )
        )

        AND (
          ${showAll}
          OR t.trade_type NOT IN (
            'buy',
            'sell'
          )
          OR t.total_value >= ${minimumValue}
        )

        AND (
          ${search} = ''
          OR LOWER(t.company) LIKE ${searchPattern}
          OR LOWER(t.ceo) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.display_ceo_name,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.raw_ceo_name,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.reporting_owner_name,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.ticker,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(t.title) LIKE ${searchPattern}
          OR LOWER(t.summary) LIKE ${searchPattern}
        )

      GROUP BY t.id

      ORDER BY
        CASE
          WHEN ${sort} = 'largest'
            THEN t.total_value
        END DESC NULLS LAST,

        CASE
          WHEN ${sort} = 'popular'
            THEN COUNT(v.trade_id)
        END DESC NULLS LAST,

        CASE
          WHEN ${sort} = 'latest'
            THEN t.filed_date
        END DESC NULLS LAST,

        t.filed_date DESC NULLS LAST,
        t.transaction_date DESC,
        t.created_at DESC

      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const countRows = await sql`
      SELECT
        COUNT(*)::integer AS total

      FROM trades t

      WHERE
        (
          ${requestedTrade} = ''
          OR t.id = ${requestedTrade}
          OR t.permanent_slug =
            ${requestedTrade}
        )

        AND
        (
          ${company} = ''
          OR t.company = ${company}
        )

        AND (
          ${ceo} = ''
          OR t.display_ceo_name = ${ceo}
          OR t.ceo = ${ceo}
          OR t.reporting_owner_name = ${ceo}
        )

        AND (
          ${ticker} = ''
          OR t.ticker = ${ticker}
        )

        AND (
          ${tradeType} = ''
          OR t.trade_type = ${tradeType}
        )

        AND (
          ${cardCategory} = ''
          OR t.card_category = ${cardCategory}
        )

        AND (
          ${marketAction} = ''
          OR t.market_action = ${marketAction}
        )

        AND LOWER(
          COALESCE(
            t.officer_title,
            ''
          )
        ) !~ (
          '(^|[^a-z])regional([^a-z]|$)' ||
          '|southern africa' ||
          '|north america' ||
          '|latin america' ||
          '|asia pacific' ||
          '|(^|[^a-z])emea([^a-z]|$)' ||
          '|(^|[^a-z])apac([^a-z]|$)'
        )

        AND (
          ${year} = 0
          OR EXTRACT(
            YEAR FROM t.filed_date
          )::integer = ${year}
        )

        AND (
          ${plan} = ''
          OR (
            ${plan} = 'yes'
            AND t.ten_b5_1 = TRUE
          )
          OR (
            ${plan} = 'no'
            AND t.ten_b5_1 = FALSE
          )
        )

        AND (
          ${valueBand} = ''
          OR (
            ${valueBand} = 'lt1m'
            AND t.total_value >= 0
            AND t.total_value < 1000000
          )
          OR (
            ${valueBand} = '1to5m'
            AND t.total_value >= 1000000
            AND t.total_value < 5000000
          )
          OR (
            ${valueBand} = '5to25m'
            AND t.total_value >= 5000000
            AND t.total_value < 25000000
          )
          OR (
            ${valueBand} = 'gt25m'
            AND t.total_value >= 25000000
          )
        )

        AND (
          NOT ${rankingEligibleOnly}
          OR t.ranking_eligible = TRUE
        )

        AND (
          NOT ${requiresRankableValue}
          OR (
            t.total_value IS NOT NULL
            AND t.total_value > 0
          )
        )

        AND (
          ${showAll}
          OR t.trade_type NOT IN (
            'buy',
            'sell'
          )
          OR t.total_value >= ${minimumValue}
        )

        AND (
          ${search} = ''
          OR LOWER(t.company) LIKE ${searchPattern}
          OR LOWER(t.ceo) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.display_ceo_name,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.raw_ceo_name,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.reporting_owner_name,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(
            COALESCE(
              t.ticker,
              ''
            )
          ) LIKE ${searchPattern}
          OR LOWER(t.title) LIKE ${searchPattern}
          OR LOWER(t.summary) LIKE ${searchPattern}
        )
    `;

    const coverageRows = await sql`
      SELECT
        MIN(filed_date) AS earliest_filing_date,
        MAX(filed_date) AS latest_filing_date,
        MAX(updated_at) AS data_updated_at
      FROM trades
    `;

    let facets = null;

    if (includeFacets) {
      const facetRows = await sql`
        SELECT
          ARRAY_REMOVE(
            ARRAY_AGG(
              DISTINCT company
              ORDER BY company
            ),
            NULL
          ) AS companies,

          ARRAY_REMOVE(
            ARRAY_AGG(
              DISTINCT COALESCE(
                display_ceo_name,
                ceo,
                reporting_owner_name
              )
              ORDER BY COALESCE(
                display_ceo_name,
                ceo,
                reporting_owner_name
              )
            ),
            NULL
          ) AS ceos,

          ARRAY_REMOVE(
            ARRAY_AGG(
              DISTINCT EXTRACT(
                YEAR FROM filed_date
              )::integer
              ORDER BY EXTRACT(
                YEAR FROM filed_date
              )::integer DESC
            ),
            NULL
          ) AS years

        FROM trades
      `;

      const facetRow =
        facetRows?.[0] || {};

      facets = {
        companies:
          Array.isArray(
            facetRow.companies
          )
            ? facetRow.companies
            : [],

        ceos:
          Array.isArray(
            facetRow.ceos
          )
            ? facetRow.ceos
            : [],

        years:
          Array.isArray(
            facetRow.years
          )
            ? facetRow.years
            : [],
      };
    }

    const trades = rows.map(
      mapTradeRow
    );

    const total = Number(
      countRows?.[0]?.total || 0
    );

    const coverage =
      coverageRows?.[0] || {};

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
      fetchedAt:
        new Date().toISOString(),

      coverage: {
        earliestFilingDate:
          formatDatabaseDate(
            coverage.earliest_filing_date
          ),

        latestFilingDate:
          formatDatabaseDate(
            coverage.latest_filing_date
          ),

        dataUpdatedAt:
          coverage.data_updated_at || null,
      },

      facets,

      pagination: {
        limit,
        offset,
        hasMore:
          offset + trades.length < total,
        nextOffset:
          offset + trades.length,
      },

      query: {
        view,
        sort,
        company,
        ceo,
        ticker,
        requestedTrade,
        tradeType,
        cardCategory,
        marketAction,
        search,
        year,
        plan,
        valueBand,
        showAll,
        rankingEligibleOnly,

        minimumValue:
          showAll
            ? null
            : minimumValue,
      },
    });
  } catch (error) {
    console.error(
      "Stored Form 4 feed error:",
      error
    );

    return res.status(500).json({
      error:
        "Could not load stored Form 4 trades.",

      detail:
        process.env.NODE_ENV ===
        "production"
          ? undefined
          : String(
              error?.message || error
            ),
    });
  }
}
