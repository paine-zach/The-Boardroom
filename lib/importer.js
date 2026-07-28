import { sql } from "./db.js";

/*
 * ============================================================
 * THE BOARDROOM — FORM 4 IMPORTER
 * ============================================================
 *
 * This module:
 * 1. Fetches recent Form 4 filings from HermAI.
 * 2. Normalizes and groups their transaction rows.
 * 3. Checks Neon for existing grouped trades.
 * 4. Generates an OpenAI summary only for new trades.
 * 5. Inserts new trades into Neon.
 *
 * It does not handle frontend feed requests or voting.
 */

/*
 * ============================================================
 * GENERAL HELPERS
 * ============================================================
 */

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function roundTo(value, decimalPlaces = 2) {
  const number = toFiniteNumber(value, 0);
  const factor = 10 ** decimalPlaces;

  return (
    Math.round(
      (number + Number.EPSILON) * factor
    ) / factor
  );
}

function roundMoney(value) {
  return roundTo(value, 2);
}

function roundShares(value) {
  return roundTo(value, 6);
}

function normalizeString(value, fallback = "") {
  const output = String(value ?? "").trim();

  return output || fallback;
}

function normalizeName(
  value,
  fallback = "Unknown CEO"
) {
  return normalizeString(value, fallback)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDate(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  const raw = String(value).trim();

  const directMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})/
  );

  if (directMatch) {
    return `${directMatch[1]}-${directMatch[2]}-${directMatch[3]}`;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toISOString().slice(0, 10);
}

function formatDateForQuery(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(
    date.getUTCMonth() + 1
  ).padStart(2, "0");
  const dd = String(
    date.getUTCDate()
  ).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function createStableId(parts) {
  return parts
    .map((part) =>
      String(part ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .join("--");
}

/*
 * ============================================================
 * SOURCE-DATA NORMALIZATION
 * ============================================================
 */

/*
 * Returns the first usable property from a source object.
 *
 * HermAI field naming may vary between snake_case and camelCase,
 * so the importer accepts several known aliases while preserving
 * one consistent internal data model.
 */
function firstDefined(
  source,
  keys,
  fallback = null
) {
  if (
    !source ||
    typeof source !== "object"
  ) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];

    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return fallback;
}

function normalizeBoolean(
  value,
  fallback = false
) {
  if (typeof value === "boolean") {
    return value;
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value !== 0;
  }

  const normalized = String(
    value ?? ""
  )
    .trim()
    .toLowerCase();

  if (
    [
      "true",
      "yes",
      "y",
      "1",
      "checked",
      "x",
    ].includes(normalized)
  ) {
    return true;
  }

  if (
    [
      "false",
      "no",
      "n",
      "0",
      "unchecked",
    ].includes(normalized)
  ) {
    return false;
  }

  return fallback;
}

/*
 * Footnotes may arrive as strings or structured objects.
 * Converting an object directly with String() produces
 * "[object Object]", which prevents plan and conversion details
 * from being detected.
 */
function normalizeFootnoteList(value) {
  const items = Array.isArray(value)
    ? value
    : value == null
    ? []
    : [value];

  const normalized = items
    .map((item) => {
      if (
        typeof item === "string" ||
        typeof item === "number"
      ) {
        return normalizeString(
          item,
          ""
        );
      }

      if (
        item &&
        typeof item === "object"
      ) {
        return normalizeString(
          firstDefined(
            item,
            [
              "text",
              "footnote",
              "footnote_text",
              "footnoteText",
              "content",
              "description",
              "value",
            ],
            ""
          ),
          ""
        );
      }

      return "";
    })
    .filter(Boolean);

  return [...new Set(normalized)];
}

function mergeUniqueStrings(
  ...lists
) {
  return [
    ...new Set(
      lists
        .flat()
        .map((value) =>
          normalizeString(
            value,
            ""
          )
        )
        .filter(Boolean)
    ),
  ];
}

function contains10b51(value) {
  const text = Array.isArray(value)
    ? value.join(" ")
    : String(value ?? "");

  /*
   * Accepts common dash variations:
   *
   * 10b5-1
   * 10b5–1
   * 10b5—1
   * 10b5 1
   */
  return /\b10b5[\s\u2010-\u2015-]*1\b/i.test(
    text
  );
}

function normalizeIdentityPart(
  value
) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function numericIdentityPart(
  value,
  decimalPlaces = 6
) {
  return roundTo(
    toFiniteNumber(value, 0),
    decimalPlaces
  ).toFixed(decimalPlaces);
}

function buildReportingOwnerIdentity(
  owner,
  fallbackName = "Unknown CEO"
) {
  const reportingOwnerName =
    normalizeName(
      firstDefined(
        owner,
        [
          "name",
          "reporting_owner_name",
          "reportingOwnerName",
          "owner_name",
          "ownerName",
        ],
        fallbackName
      ),
      fallbackName
    );

  const reportingOwnerId =
    normalizeString(
      firstDefined(
        owner,
        [
          "cik",
          "owner_cik",
          "ownerCik",
          "reporting_owner_cik",
          "reportingOwnerCik",
          "reporting_owner_id",
          "reportingOwnerId",
          "id",
        ],
        ""
      ),
      ""
    ) || null;

  /*
   * Prefer the SEC/owner identifier when supplied.
   * Fall back to the normalized reporting-owner name.
   */
  const reportingOwnerKey =
    normalizeIdentityPart(
      reportingOwnerId ||
        reportingOwnerName
    );

  return {
    reportingOwnerName,
    reportingOwnerId,
    reportingOwnerKey,
  };
}

/*
 * Required transaction-level identity:
 *
 * accession number
 * + reporting owner
 * + transaction date
 * + transaction code
 * + security title
 * + shares
 * + price
 */
function buildTransactionDedupeKey(
  row
) {
  return [
    normalizeIdentityPart(
      row.accessionNumber
    ),

    normalizeIdentityPart(
      row.reportingOwnerKey ||
        row.reportingOwnerId ||
        row.reportingOwnerName ||
        row.ceo
    ),

    normalizeIdentityPart(
      row.transactionDate
    ),

    normalizeIdentityPart(
      row.transactionCode
    ),

    normalizeIdentityPart(
      row.securityTitle
    ),

    numericIdentityPart(
      row.reportedShares ??
        row.shares,
      6
    ),

    numericIdentityPart(
      row.reportedPrice ??
        row.price,
      6
    ),
  ].join("|");
}

/*
 * Remove exact duplicate transaction rows before card grouping.
 *
 * When two otherwise-identical rows contain complementary
 * metadata, preserve the strongest combined metadata instead of
 * silently discarding it.
 */
function dedupeTransactionRows(
  rows
) {
  const uniqueRows = new Map();

  for (const row of rows) {
    const transactionDedupeKey =
      row.transactionDedupeKey ||
      buildTransactionDedupeKey(
        row
      );

    if (
      !uniqueRows.has(
        transactionDedupeKey
      )
    ) {
      uniqueRows.set(
        transactionDedupeKey,
        {
          ...row,
          transactionDedupeKey,
        }
      );

      continue;
    }

    const existing =
      uniqueRows.get(
        transactionDedupeKey
      );

    existing.tenB51 =
      Boolean(existing.tenB51) ||
      Boolean(row.tenB51);

    existing.filingFootnotes =
      mergeUniqueStrings(
        existing.filingFootnotes,
        row.filingFootnotes
      );

    existing.ownerFootnotes =
      mergeUniqueStrings(
        existing.ownerFootnotes,
        row.ownerFootnotes
      );

    existing.transactionFootnotes =
      mergeUniqueStrings(
        existing.transactionFootnotes,
        row.transactionFootnotes
      );

    if (
      !existing.ownershipForm &&
      row.ownershipForm
    ) {
      existing.ownershipForm =
        row.ownershipForm;
    }

    if (
      !existing.natureOfOwnership &&
      row.natureOfOwnership
    ) {
      existing.natureOfOwnership =
        row.natureOfOwnership;
    }

    if (
      !existing.securityTitle &&
      row.securityTitle
    ) {
      existing.securityTitle =
        row.securityTitle;
    }

    if (
      !existing.reportingOwnerId &&
      row.reportingOwnerId
    ) {
      existing.reportingOwnerId =
        row.reportingOwnerId;
    }
  }

  return [
    ...uniqueRows.values(),
  ];
}

/*
 * ============================================================
 * DETERMINISTIC TRANSACTION CALCULATIONS
 * ============================================================
 */

function combineTextValues(
  ...values
) {
  return values
    .flat(Infinity)
    .map((value) =>
      normalizeString(
        value,
        ""
      )
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * Detect statements such as:
 *
 * "Each ADS represents 60 Class A ordinary shares."
 * "One American Depositary Share represents 10 ordinary shares."
 * "60 ordinary shares are represented by each ADS."
 */
function extractAdsRatio(
  value
) {
  const text =
    combineTextValues(value);

  if (!text) {
    return null;
  }

  const patterns = [
    /\b(?:each|one)\s+(?:american\s+depositary\s+share|ads)\s+represents?\s+([\d,.]+)\s+(?:class\s+[a-z0-9-]+\s+)?(?:ordinary|common)\s+shares?\b/i,

    /\b([\d,.]+)\s+(?:class\s+[a-z0-9-]+\s+)?(?:ordinary|common)\s+shares?\s+(?:are|is)\s+represented\s+by\s+(?:each|one)\s+(?:american\s+depositary\s+share|ads)\b/i,

    /\bratio\s+of\s+(?:one|1)\s+(?:american\s+depositary\s+share|ads)\s+to\s+([\d,.]+)\s+(?:class\s+[a-z0-9-]+\s+)?(?:ordinary|common)\s+shares?\b/i,
  ];

  for (const pattern of patterns) {
    const match =
      text.match(pattern);

    if (!match) {
      continue;
    }

    const parsed = Number(
      String(match[1])
        .replace(/,/g, "")
    );

    if (
      Number.isFinite(parsed) &&
      parsed > 0 &&
      parsed <= 1_000_000
    ) {
      return parsed;
    }
  }

  return null;
}

function securityTitleIsAds(
  securityTitle
) {
  return /\b(?:american\s+depositary\s+shares?|ads)\b/i.test(
    String(
      securityTitle ?? ""
    )
  );
}

function securityTitleIsUnderlyingShares(
  securityTitle
) {
  return /\b(?:ordinary|common)\s+shares?\b|\bclass\s+[a-z0-9-]+\s+shares?\b/i.test(
    String(
      securityTitle ?? ""
    )
  );
}

/*
 * An ADS ratio by itself is not sufficient to divide the reported
 * share count. The filing must also make clear that the reported
 * transaction price is an ADS price.
 */
function textStatesPricePerAds(
  value
) {
  const text =
    combineTextValues(value);

  if (!text) {
    return false;
  }

  const patterns = [
    /\b(?:price|prices|purchase\s+price|sale\s+price|transaction\s+price|average\s+price|weighted\s+average\s+price)[^.;]{0,140}\bper\s+(?:american\s+depositary\s+share|ads)\b/i,

    /\b(?:price|prices)\s+(?:shown|reported|stated|quoted)\s+(?:are|is|were|was)?\s*(?:on\s+an?\s+)?(?:american\s+depositary\s+share|ads)\s+basis\b/i,

    /\b(?:american\s+depositary\s+share|ads)\s+price\b/i,

    /\bprice\s+per\s+ads\b/i,
  ];

  return patterns.some(
    (pattern) =>
      pattern.test(text)
  );
}

function normalizeOwnershipEntity(
  natureOfOwnership
) {
  const text = normalizeString(
    natureOfOwnership,
    ""
  );

  if (!text) {
    return null;
  }

  const normalized =
    text
      .replace(
        /^(?:held\s+)?(?:indirectly\s+)?by\s+/i,
        ""
      )
      .replace(
        /^(?:through|via)\s+/i,
        ""
      )
      .replace(/[.;,\s]+$/g, "")
      .trim();

  if (
    !normalized ||
    /^(?:direct|indirect)$/i.test(
      normalized
    )
  ) {
    return null;
  }

  return normalized;
}

function calculateTransactionLine(
  line
) {
  const reportedShares =
    roundShares(
      toFiniteNumber(
        line.reportedShares ??
          line.shares,
        0
      )
    );

  const reportedPrice =
    roundMoney(
      toFiniteNumber(
        line.reportedPrice ??
          line.price,
        0
      )
    );

  const calculationText =
    combineTextValues(
      line.filingFootnotes,
      line.ownerFootnotes,
      line.transactionFootnotes,
      line.allFootnotes,
      line.natureOfOwnership,
      line.securityTitle
    );

  const adsRatio =
    extractAdsRatio(
      calculationText
    );

  const securityIsAds =
    securityTitleIsAds(
      line.securityTitle
    );

  const securityIsUnderlying =
    securityTitleIsUnderlyingShares(
      line.securityTitle
    );

  const priceIsPerAds =
    textStatesPricePerAds(
      calculationText
    );

  /*
   * Convert only when all required facts are present:
   *
   * 1. A numeric ADS ratio was found.
   * 2. The transaction security is the underlying share class,
   *    rather than ADSs already.
   * 3. The filing explicitly indicates that the price is per ADS.
   */
  const adsConversionApplied =
    Number.isFinite(adsRatio) &&
    adsRatio > 0 &&
    !securityIsAds &&
    securityIsUnderlying &&
    priceIsPerAds;

  const economicUnits =
    adsConversionApplied
      ? roundShares(
          reportedShares /
            adsRatio
        )
      : reportedShares;

  const economicUnitLabel =
    adsConversionApplied ||
    securityIsAds
      ? "ADS"
      : "shares";

  const calculatedValue =
    roundMoney(
      economicUnits *
        reportedPrice
    );

  const calculationWarnings = [];

  if (
    adsRatio &&
    securityIsUnderlying &&
    !priceIsPerAds
  ) {
    calculationWarnings.push(
      "An ADS ratio was found, but the filing text supplied to the importer did not clearly state that the transaction price was per ADS. No ADS conversion was applied."
    );
  }

  if (
    priceIsPerAds &&
    securityIsUnderlying &&
    !adsRatio
  ) {
    calculationWarnings.push(
      "The filing indicates an ADS price, but no numeric ADS conversion ratio was found. No ADS conversion was applied."
    );
  }

  const calculationTrusted =
    calculationWarnings.length === 0;

  const ownershipEntity =
    normalizeOwnershipEntity(
      line.natureOfOwnership
    );

  return {
    ...line,

    reportedShares,
    reportedPrice,

    /*
     * Preserve the value received from HermAI only as source data.
     * It is not used as the public transaction value.
     */
    reportedTransactionValue:
      roundMoney(
        toFiniteNumber(
          line.reportedTransactionValue,
          reportedShares *
            reportedPrice
        )
      ),

    adsRatio:
      adsRatio || null,

    priceIsPerAds,

    adsConversionApplied,

    economicUnits,

    economicUnitLabel,

    calculatedValue,

    calculationTrusted,

    calculationWarnings,

    ownershipEntity,

    /*
     * Compatibility fields used by the existing database and feed.
     * These now contain the checked economic values.
     */
    shares:
      economicUnits,

    price:
      reportedPrice,

    value:
      calculatedValue,
  };
}

function applyDeterministicCalculations(
  trades
) {
  return trades.map((trade) => {
    const calculatedLines =
      Array.isArray(
        trade.lines
      )
        ? trade.lines.map(
            calculateTransactionLine
          )
        : [];

    const shares =
      roundShares(
        calculatedLines.reduce(
          (sum, line) =>
            sum +
            toFiniteNumber(
              line.economicUnits,
              0
            ),
          0
        )
      );

    const value =
      roundMoney(
        calculatedLines.reduce(
          (sum, line) =>
            sum +
            toFiniteNumber(
              line.calculatedValue,
              0
            ),
          0
        )
      );

    const pricedLines =
      calculatedLines.filter(
        (line) =>
          Number(
            line.reportedPrice
          ) > 0 &&
          Number(
            line.economicUnits
          ) > 0
      );

    const pricedUnits =
      pricedLines.reduce(
        (sum, line) =>
          sum +
          toFiniteNumber(
            line.economicUnits,
            0
          ),
        0
      );

    const weightedPriceTotal =
      pricedLines.reduce(
        (sum, line) =>
          sum +
          toFiniteNumber(
            line.reportedPrice,
            0
          ) *
            toFiniteNumber(
              line.economicUnits,
              0
            ),
        0
      );

    const price =
      pricedUnits > 0
        ? roundMoney(
            weightedPriceTotal /
              pricedUnits
          )
        : 0;

    const unitLabels = [
      ...new Set(
        calculatedLines
          .map(
            (line) =>
              line.economicUnitLabel
          )
          .filter(Boolean)
      ),
    ];

    const ownershipEntities = [
      ...new Set(
        calculatedLines
          .map(
            (line) =>
              line.ownershipEntity
          )
          .filter(Boolean)
      ),
    ];

    const adsRatios = [
      ...new Set(
        calculatedLines
          .map(
            (line) =>
              line.adsRatio
          )
          .filter(
            (ratio) =>
              Number.isFinite(
                ratio
              ) &&
              ratio > 0
          )
      ),
    ];

    const calculationWarnings = [
      ...new Set(
        calculatedLines
          .flatMap(
            (line) =>
              Array.isArray(
                line.calculationWarnings
              )
                ? line
                    .calculationWarnings
                : []
          )
          .filter(Boolean)
      ),
    ];

    return {
      ...trade,

      lines:
        calculatedLines,

      shares,
      price,
      value,

      economicUnitLabel:
        unitLabels.length === 1
          ? unitLabels[0]
          : "securities",

      ownershipEntities,

      adsRatio:
        adsRatios.length === 1
          ? adsRatios[0]
          : null,

      adsConversionApplied:
        calculatedLines.some(
          (line) =>
            line.adsConversionApplied
        ),

      calculationTrusted:
        calculatedLines.every(
          (line) =>
            line.calculationTrusted
        ),

      calculationWarnings,

      /*
       * Unknown ownership and performance values stay null.
       * They must not be presented as 0.0%.
       */
      pctHoldingsChange: null,
      sharesOwnedAfter: null,

      planStatus:
        trade.tenB51
          ? "10b5-1"
          : "not-indicated",

      perf: {
        sinceTrade: {
          changePct: null,
        },
      },
    };
  });
}

/*
 * ============================================================
 * TRANSACTION-TYPE NORMALIZATION
 * ============================================================
 */

function toTradeTypeLabel(value) {
  const normalized = normalizeString(
    value
  ).toLowerCase();

  if (
    normalized === "p" ||
    normalized.includes("purchase") ||
    normalized.includes("buy")
  ) {
    return "Open Market Buy";
  }

  if (
    normalized === "s" ||
    normalized.includes("sale") ||
    normalized.includes("sell")
  ) {
    return "Open Market Sell";
  }

  if (
    normalized === "m" ||
    normalized.includes("option")
  ) {
    return "Option Exercise";
  }

  if (
    normalized === "a" ||
    normalized.includes("award") ||
    normalized.includes("grant")
  ) {
    return "Award / Grant";
  }

  return "Insider Transaction";
}

function toTradeType(value) {
  const normalized = normalizeString(
    value
  ).toLowerCase();

  if (
    normalized === "p" ||
    normalized.includes("purchase") ||
    normalized.includes("buy")
  ) {
    return "buy";
  }

  if (
    normalized === "s" ||
    normalized.includes("sale") ||
    normalized.includes("sell")
  ) {
    return "sell";
  }

  if (
    normalized === "m" ||
    normalized.includes("option")
  ) {
    return "option";
  }

  if (
    normalized === "a" ||
    normalized.includes("award") ||
    normalized.includes("grant")
  ) {
    return "award";
  }

  /*
   * Preserve the current frontend category contract.
   */
  return "sell";
}

/*
 * ============================================================
 * FALLBACK CONTENT
 * ============================================================
 */

function compactDecimalPlaces(
  scaledValue
) {
  const absolute =
    Math.abs(scaledValue);

  if (absolute >= 100) {
    return 0;
  }

  if (absolute >= 10) {
    return 1;
  }

  return 2;
}

function formatCompactMoney(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return "N/A";
  }

  const amount =
    roundMoney(value);

  const absoluteAmount =
    Math.abs(amount);

  const sign =
    amount < 0 ? "-" : "";

  if (
    absoluteAmount >=
    1_000_000_000
  ) {
    const scaled =
      absoluteAmount /
      1_000_000_000;

    return `${sign}$${scaled.toFixed(
      compactDecimalPlaces(
        scaled
      )
    )}B`;
  }

  if (
    absoluteAmount >=
    1_000_000
  ) {
    const scaled =
      absoluteAmount /
      1_000_000;

    return `${sign}$${scaled.toFixed(
      compactDecimalPlaces(
        scaled
      )
    )}M`;
  }

  if (
    absoluteAmount >=
    1_000
  ) {
    const scaled =
      absoluteAmount /
      1_000;

    return `${sign}$${scaled.toFixed(
      compactDecimalPlaces(
        scaled
      )
    )}K`;
  }

  return `${sign}$${absoluteAmount.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

function formatPrice(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    ) ||
    Number(value) <= 0
  ) {
    return "N/A";
  }

  return `$${roundMoney(
    value
  ).toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

function formatWholeUnits(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return "N/A";
  }

  return Math.round(
    Number(value)
  ).toLocaleString(
    "en-US"
  );
}

function unitLabelForDisplay(
  value,
  count = 0
) {
  const normalized =
    normalizeString(
      value,
      "securities"
    ).toLowerCase();

  if (normalized === "ads") {
    return Number(count) === 1
      ? "ADS"
      : "ADSs";
  }

  if (
    normalized === "share" ||
    normalized === "shares"
  ) {
    return Number(count) === 1
      ? "share"
      : "shares";
  }

  return "securities";
}

function fallbackTitle(
  trade
) {
  const units =
    formatWholeUnits(
      trade.shares
    );

  const unitLabel =
    unitLabelForDisplay(
      trade.economicUnitLabel,
      trade.shares
    );

  const action =
    trade.tradeType === "buy"
      ? "purchased"
      : trade.tradeType === "sell"
      ? "sold"
      : trade.tradeType === "award"
      ? "received an award involving"
      : trade.tradeType === "option"
      ? "exercised options involving"
      : "reported a transaction involving";

  return `${trade.ceo} ${action} ${units} ${unitLabel} of ${trade.company}.`;
}

function fallbackSummary(
  trade
) {
  const units =
    formatWholeUnits(
      trade.shares
    );

  const unitLabel =
    unitLabelForDisplay(
      trade.economicUnitLabel,
      trade.shares
    );

  const ownershipEntities =
    Array.isArray(
      trade.ownershipEntities
    )
      ? trade.ownershipEntities
      : [];

  const ownershipText =
    ownershipEntities.length
      ? ` through ${ownershipEntities.join(
          " and "
        )}`
      : "";

  const planText =
    trade.tenB51
      ? " under a Rule 10b5-1 trading plan"
      : "";

  const firstSentence =
    `${trade.ceo} reported a ${String(
      trade.tradeTypeLabel
    ).toLowerCase()} involving ` +
    `${units} ${unitLabel} of ${trade.company} (${trade.ticker})` +
    `${ownershipText}${planText}.`;

  if (
    (
      trade.tradeType ===
        "award" ||
      trade.tradeType ===
        "option"
    ) &&
    Number(trade.value) === 0
  ) {
    return (
      `${firstSentence} ` +
      "No transaction price or cash consideration was reported in the filing."
    );
  }

  if (
    trade.calculationTrusted ===
    false
  ) {
    return (
      `${firstSentence} ` +
      "A reliable aggregate transaction value was not calculated from the available filing data."
    );
  }

  return (
    `${firstSentence} ` +
    `The checked aggregate transaction value is approximately ${formatCompactMoney(
      trade.value
    )}.`
  );
}

function fallbackTags(trade) {
  const tags = [];

  if (trade.tradeType === "buy") {
    tags.push("open-market-buy");
  } else if (trade.tradeType === "sell") {
    tags.push("open-market-sell");
  } else if (trade.tradeType === "award") {
    tags.push("stock-award");
  } else if (trade.tradeType === "option") {
    tags.push("option-exercise");
  } else {
    tags.push("insider-transaction");
  }

  const sectorTag = normalizeString(
    trade.sector,
    "unknown"
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (sectorTag) {
    tags.push(sectorTag);
  }

  if (trade.tenB51) {
    tags.push("10b5-1");
  }

  if (
    Array.isArray(trade.lines) &&
    trade.lines.length > 1
  ) {
    tags.push("multi-line-filing");
  }

  return [...new Set(tags)].slice(0, 4);
}

function sanitizeTags(value, fallback) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const cleaned = value
    .map((tag) =>
      String(tag ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean);

  return cleaned.length
    ? [...new Set(cleaned)].slice(0, 4)
    : fallback;
}

/*
 * ============================================================
 * HERMAI REQUEST
 * ============================================================
 */

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function fetchHermPage({
  hermaiKey,
  startDate,
  endDate,
  role,
  offset,
  limit,
}) {
  const maximumAttempts = 4;

  for (
    let attempt = 1;
    attempt <= maximumAttempts;
    attempt += 1
  ) {
    try {
      const response = await fetch(
        "https://api.hermai.ai/v1/fetch",
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${hermaiKey}`,
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            site: "data.sec.gov",
            endpoint: "list_form4_transactions",

            params: {
              start_date: startDate,
              end_date: endDate,
              role,
              include_amendments: false,
              offset,
              limit,
            },
          }),
        }
      );

      if (response.ok) {
        return response.json();
      }

      const detail = await response.text();

      /*
       * Retry rate limits and upstream/server failures.
       * Do not retry ordinary request-validation errors.
       */
      const retryable =
        response.status === 429 ||
        response.status >= 500;

      if (
        !retryable ||
        attempt === maximumAttempts
      ) {
        throw new Error(
          `HermAI request failed (${response.status}): ${detail}`
        );
      }

      const retryAfterHeader =
        response.headers.get("retry-after");

      const retryAfterSeconds =
        Number(retryAfterHeader);

      const delayMilliseconds =
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : 2000 * 2 ** (attempt - 1);

      console.warn(
        `HermAI request failed with status ${response.status}. ` +
          `Retrying attempt ${attempt + 1}/${maximumAttempts} ` +
          `in ${delayMilliseconds}ms.`
      );

      await wait(delayMilliseconds);
    } catch (error) {
      /*
       * fetch() itself can fail before an HTTP response exists.
       * Retry those network-level failures as well.
       */
      if (attempt === maximumAttempts) {
        throw error;
      }

      const delayMilliseconds =
        2000 * 2 ** (attempt - 1);

      console.warn(
        `HermAI network request failed. ` +
          `Retrying attempt ${attempt + 1}/${maximumAttempts} ` +
          `in ${delayMilliseconds}ms.`,
        error
      );

      await wait(delayMilliseconds);
    }
  }

  throw new Error(
    "HermAI request failed after all retry attempts."
  );
}

/*
 * ============================================================
 * OPENAI SUMMARY GENERATION
 * ============================================================
 */

async function generateAiSummary({
  openaiKey,
  model,
  input,
}) {
  const fallback = {
    title: fallbackTitle(input),
    summary: fallbackSummary(input),
    tags: fallbackTags(input),
  };

  if (!openaiKey) {
    return fallback;
  }

  const prompt = `
Return ONLY one strict JSON object with these keys:

{
  "title": "string",
  "summary": "string",
  "tags": ["string"]
}

Rules:
- Use only the facts provided in the input.
- Be neutral, factual, concise, and understandable to a general reader.
- Do not provide financial, legal, or investment advice.
- Do not infer motives that are not explicitly provided.
- Do not suggest that a sale is bearish.
- Do not suggest that a purchase guarantees confidence.

CALCULATION RULES:
- All calculations, unit conversions, aggregation, and rounding have already been completed in code.
- Never multiply, divide, add, subtract, convert, estimate, or recalculate any number.
- Never calculate transaction value from reportedShares and reportedPrice.
- The reportedShares, reportedPrice, and reportedTransactionValue fields are audit/source fields only.
- For public wording, use checkedTotals and each line's checked display fields.
- Copy displayUnitCount, displayUnitLabel, displayAveragePrice, and displayCalculatedValue exactly as supplied.
- Copy checkedTotals.displayTotalValue exactly as supplied.
- If a checked display value is "N/A", do not invent or estimate a replacement.
- If calculationTrusted is false, do not state a precise aggregate transaction value.

ADS RULES:
- When adsConversionApplied is true, describe the transaction using the supplied ADS quantity and ADS label.
- Do not describe the converted ADS quantity as ordinary shares.
- You may mention the ADS ratio only when adsRatio is supplied.
- Do not perform the ADS conversion yourself.

PLAN AND OWNERSHIP RULES:
- When tenB51 is true, explicitly state that the transactions were reported under a Rule 10b5-1 trading plan.
- When tenB51 is false, do not call the trade discretionary.
- Never use the word "Discretionary".
- Do not infer that the absence of a detected plan means the transaction was discretionary.
- When ownershipEntities is non-empty, mention the supplied ownership entity or entities.
- Do not invent an ownership entity.

TRANSACTION RULES:
- Clearly distinguish open-market trades from awards, grants, and option exercises.
- Awards and grants are compensation events, not open-market purchases.
- A transaction price or value of zero does not mean the securities have no economic value.
- When an award, grant, or option transaction has a reported price or value of zero, state that no transaction price or cash consideration was reported.
- Never say that securities are worthless, have no value, have no monetary value, or have no immediate value.
- Treat all lines as parts of one filing event.
- Preserve the individual transaction dates when more than one date is supplied.
- Do not imply that separate dates are duplicate transactions.

OUTPUT RULES:
- title: one concise sentence.
- summary: one or two concise sentences.
- tags: two to four lowercase kebab-case tags.
- Do not include markdown.
- Do not include text outside the JSON object.

Input:
${JSON.stringify(input)}
`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    20_000
  );

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: {
            type: "json_object",
          },
          messages: [
            {
              role: "system",
              content:
                "You write only from precomputed, checked Form 4 facts. Never perform calculations, conversions, estimates, or inferences. Return strict JSON only.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const detail = await response.text();

      console.error(
        `OpenAI request failed (${response.status}): ${detail.slice(
          0,
          500
        )}`
      );

      return fallback;
    }

    const result = await response.json();

    const content =
      result?.choices?.[0]?.message
        ?.content || "{}";

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (error) {
      console.error(
        "Could not parse OpenAI JSON response:",
        error
      );

      return fallback;
    }

    let title =
  typeof parsed?.title ===
    "string" &&
  parsed.title.trim()
    ? parsed.title.trim()
    : fallback.title;

let summary =
  typeof parsed?.summary ===
    "string" &&
  parsed.summary.trim()
    ? parsed.summary.trim()
    : fallback.summary;

/*
 * Never store content describing a transaction as discretionary.
 */
if (
  /\bdiscretionary\b/i.test(
    `${title} ${summary}`
  )
) {
  title =
    fallback.title;

  summary =
    fallback.summary;
}

/*
 * A zero-value compensation event does not establish that the
 * underlying securities themselves have no economic value.
 */
const isCompensationEvent =
  input.tradeType === "award" ||
  input.tradeType === "option";

const reportedValue =
  Number(
    input.checkedTotals
      ?.totalValue ??
      input.value ??
      0
  );

const unsupportedZeroValueLanguage =
  /\b(no|without)\s+(immediate\s+)?(monetary\s+|economic\s+)?value\b|\bworthless\b|\bhas no value\b/i;

if (
  isCompensationEvent &&
  reportedValue === 0 &&
  unsupportedZeroValueLanguage.test(
    summary
  )
) {
  summary =
    fallback.summary;
}

/*
 * Plan status must be stated when it has been positively detected.
 */
const summaryMentionsPlan =
  contains10b51(
    summary
  );

const ownershipEntities =
  Array.isArray(
    input.ownershipEntities
  )
    ? input.ownershipEntities
    : [];

const missingOwnershipEntities =
  ownershipEntities.filter(
    (entity) =>
      !summary
        .toLowerCase()
        .includes(
          String(entity)
            .toLowerCase()
        )
  );

if (
  input.tenB51 &&
  !summaryMentionsPlan &&
  missingOwnershipEntities.length
) {
  summary =
    `${summary.replace(
      /\s+$/g,
      ""
    )} The filing identifies the transactions as made through ` +
    `${missingOwnershipEntities.join(
      " and "
    )} under a Rule 10b5-1 trading plan.`;
} else if (
  input.tenB51 &&
  !summaryMentionsPlan
) {
  summary =
    `${summary.replace(
      /\s+$/g,
      ""
    )} The transactions were reported under a Rule 10b5-1 trading plan.`;
} else if (
  missingOwnershipEntities.length
) {
  summary =
    `${summary.replace(
      /\s+$/g,
      ""
    )} The filing identifies the transactions as made through ` +
    `${missingOwnershipEntities.join(
      " and "
    )}.`;
}

return {
  title,
  summary,
  tags: sanitizeTags(
    parsed?.tags,
    fallback.tags
  ),
};
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error(
        "OpenAI summary request timed out."
      );
    } else {
      console.error(
        "OpenAI summary request failed:",
        error
      );
    }

    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

/*
 * ============================================================
 * FILING → NORMALIZED TRANSACTION ROWS
 * ============================================================
 */

function filingToTransactionRows(
  filing,
  options = {}
) {
  const {
    skipZeroRows = true,
  } = options;

  const issuer =
    filing?.issuer &&
    typeof filing.issuer === "object"
      ? filing.issuer
      : {};

  const owners = Array.isArray(
    filing?.reporting_owners
  )
    ? filing.reporting_owners
    : Array.isArray(
        filing?.reportingOwners
      )
    ? filing.reportingOwners
    : [];

  /*
   * The endpoint currently requests CEO filings, so prefer the
   * reporting owner identified as the CEO. Fall back to the first
   * reporting owner when the source does not provide ceo_match.
   */
  const owner =
    owners.find((candidate) =>
      normalizeBoolean(
        firstDefined(
          candidate,
          [
            "ceo_match",
            "ceoMatch",
            "is_ceo",
            "isCeo",
          ],
          false
        )
      )
    ) ||
    owners[0] ||
    {};

  const ownerIdentity =
    buildReportingOwnerIdentity(
      owner,
      "Unknown CEO"
    );

  const ceoName =
    ownerIdentity.reportingOwnerName;

  const officerTitle =
    normalizeString(
      firstDefined(
        owner,
        [
          "officer_title",
          "officerTitle",
          "title",
        ],
        ""
      ),
      ""
    );

  const accessionNumber =
    normalizeString(
      firstDefined(
        filing,
        [
          "accession_number",
          "accessionNumber",
          "accession",
        ],
        "unknown-accession"
      ),
      "unknown-accession"
    );

  const issuerCik =
    normalizeString(
      firstDefined(
        issuer,
        [
          "cik",
          "issuer_cik",
          "issuerCik",
        ],
        ""
      ),
      ""
    ) || null;

  const company =
    normalizeString(
      firstDefined(
        issuer,
        [
          "name",
          "issuer_name",
          "issuerName",
          "company_name",
          "companyName",
        ],
        "Unknown Company"
      ),
      "Unknown Company"
    );

  const ticker =
    normalizeString(
      firstDefined(
        issuer,
        [
          "ticker",
          "trading_symbol",
          "tradingSymbol",
          "symbol",
        ],
        "N/A"
      ),
      "N/A"
    );

  const sourceUrl =
    normalizeString(
      firstDefined(
        filing,
        [
          "source_url",
          "sourceUrl",
          "source_document_url",
          "sourceDocumentUrl",
          "filing_url",
          "filingUrl",
        ],
        "#"
      ),
      "#"
    );

  const filingDate =
    normalizeDate(
      firstDefined(
        filing,
        [
          "filed_date",
          "filedDate",
          "filing_date",
          "filingDate",
        ],
        null
      ),
      null
    );

  /*
   * Preserve filing, owner, and transaction footnotes separately.
   * They may contain different pieces of information, including
   * plan status, ADS conversion ratios, and ownership entities.
   */
  const filingFootnotes =
    normalizeFootnoteList(
      firstDefined(
        filing,
        [
          "footnotes",
          "filing_footnotes",
          "filingFootnotes",
        ],
        []
      )
    );

  const ownerFootnotes =
    normalizeFootnoteList(
      firstDefined(
        owner,
        [
          "footnotes",
          "owner_footnotes",
          "ownerFootnotes",
          "remarks",
        ],
        []
      )
    );

  /*
   * Check explicit Form 4 plan indicators as well as footnote text.
   * The old version depended only on the words appearing in a
   * successfully stringified footnote.
   */
  const filingTenB51IndicatorValues = [
    firstDefined(
      filing,
      [
        "ten_b5_1",
        "tenB51",
        "is_10b5_1",
        "is10b51",
        "rule_10b5_1",
        "rule10b51",
        "under_10b5_1_plan",
        "under10b51Plan",
        "has_10b5_1_plan",
        "has10b51Plan",
        "checkbox_10b5_1",
        "checkbox10b51",
      ],
      null
    ),

    firstDefined(
      owner,
      [
        "ten_b5_1",
        "tenB51",
        "is_10b5_1",
        "is10b51",
        "rule_10b5_1",
        "rule10b51",
        "under_10b5_1_plan",
        "under10b51Plan",
      ],
      null
    ),
  ];

  const filingTenB51 =
    filingTenB51IndicatorValues.some(
      (value) =>
        normalizeBoolean(
          value,
          false
        )
    ) ||
    contains10b51(
      filingFootnotes
    ) ||
    contains10b51(
      ownerFootnotes
    );

  /*
   * Prefer the normalized transactions collection. The alternate
   * arrays are fallbacks for source responses that separate
   * derivative and non-derivative transactions.
   */
  let transactions;

  if (
    Array.isArray(
      filing?.transactions
    )
  ) {
    transactions =
      filing.transactions;
  } else {
    const nonDerivative =
      Array.isArray(
        filing?.non_derivative_transactions
      )
        ? filing.non_derivative_transactions
        : Array.isArray(
            filing?.nonDerivativeTransactions
          )
        ? filing.nonDerivativeTransactions
        : [];

    const derivative =
      Array.isArray(
        filing?.derivative_transactions
      )
        ? filing.derivative_transactions
        : Array.isArray(
            filing?.derivativeTransactions
          )
        ? filing.derivativeTransactions
        : [];

    transactions = [
      ...nonDerivative,
      ...derivative,
    ];
  }

  const rows = [];

  for (
    let transactionIndex = 0;
    transactionIndex <
    transactions.length;
    transactionIndex += 1
  ) {
    const transaction =
      transactions[
        transactionIndex
      ] || {};

    /*
     * Preserve the SEC-reported share and price values. These are
     * not yet assumed to use compatible units. The ADS conversion
     * step will determine whether a reported share count must be
     * converted before calculating economic value.
     */
    const reportedShares =
      roundShares(
        toFiniteNumber(
          firstDefined(
            transaction,
            [
              "shares",
              "transaction_shares",
              "transactionShares",
              "reported_shares",
              "reportedShares",
              "amount_of_securities",
              "amountOfSecurities",
            ],
            0
          ),
          0
        )
      );

    const reportedPrice =
      roundMoney(
        toFiniteNumber(
          firstDefined(
            transaction,
            [
              "price_per_share",
              "pricePerShare",
              "transaction_price",
              "transactionPrice",
              "price",
              "reported_price",
              "reportedPrice",
            ],
            0
          ),
          0
        )
      );

    const suppliedTransactionValue =
      firstDefined(
        transaction,
        [
          "transaction_value",
          "transactionValue",
          "total_value",
          "totalValue",
          "reported_value",
          "reportedValue",
        ],
        null
      );

    /*
     * Keep the currently implied value for backwards compatibility,
     * but label it as reported/provisional. Step 2 will replace this
     * with a deterministic calculation that accounts for ADS ratios.
     */
    const reportedTransactionValue =
      suppliedTransactionValue == null
        ? roundMoney(
            reportedShares *
              reportedPrice
          )
        : roundMoney(
            toFiniteNumber(
              suppliedTransactionValue,
              reportedShares *
                reportedPrice
            )
          );

    const transactionCode =
      normalizeString(
        firstDefined(
          transaction,
          [
            "transaction_code",
            "transactionCode",
            "code",
            "transaction_type_code",
            "transactionTypeCode",
            "transaction_type",
            "transactionType",
          ],
          ""
        ),
        ""
      );

    const rawTransactionType =
      normalizeString(
        firstDefined(
          transaction,
          [
            "transaction_type",
            "transactionType",
            "transaction_code",
            "transactionCode",
            "code",
          ],
          ""
        ),
        ""
      );

    const tradeType =
      toTradeType(
        transactionCode ||
          rawTransactionType
      );

    const tradeTypeLabel =
      toTradeTypeLabel(
        transactionCode ||
          rawTransactionType
      );

    const transactionDate =
      normalizeDate(
        firstDefined(
          transaction,
          [
            "transaction_date",
            "transactionDate",
            "date",
          ],
          filingDate
        ),
        filingDate
      );

    const securityTitle =
      normalizeString(
        firstDefined(
          transaction,
          [
            "security_title",
            "securityTitle",
            "title_of_security",
            "titleOfSecurity",
            "security",
            "security_name",
            "securityName",
          ],
          "Unknown Security"
        ),
        "Unknown Security"
      );

    const ownershipForm =
      normalizeString(
        firstDefined(
          transaction,
          [
            "ownership_form",
            "ownershipForm",
            "direct_or_indirect_ownership",
            "directOrIndirectOwnership",
            "direct_indirect",
            "directIndirect",
          ],
          ""
        ),
        ""
      ) || null;

    const natureOfOwnership =
      normalizeString(
        firstDefined(
          transaction,
          [
            "nature_of_ownership",
            "natureOfOwnership",
            "ownership_nature",
            "ownershipNature",
            "indirect_ownership_nature",
            "indirectOwnershipNature",
          ],
          ""
        ),
        ""
      ) || null;

    const acquiredDisposedCode =
      normalizeString(
        firstDefined(
          transaction,
          [
            "acquired_disposed_code",
            "acquiredDisposedCode",
            "acquired_or_disposed",
            "acquiredOrDisposed",
          ],
          ""
        ),
        ""
      ) || null;

    const transactionFootnotes =
      normalizeFootnoteList(
        firstDefined(
          transaction,
          [
            "footnotes",
            "transaction_footnotes",
            "transactionFootnotes",
            "remarks",
          ],
          []
        )
      );

    const transactionTenB51Indicator =
      normalizeBoolean(
        firstDefined(
          transaction,
          [
            "ten_b5_1",
            "tenB51",
            "is_10b5_1",
            "is10b51",
            "rule_10b5_1",
            "rule10b51",
            "under_10b5_1_plan",
            "under10b51Plan",
            "planned_transaction",
            "plannedTransaction",
          ],
          false
        ),
        false
      );

    const allFootnotes =
      mergeUniqueStrings(
        filingFootnotes,
        ownerFootnotes,
        transactionFootnotes
      );

    const tenB51 =
      filingTenB51 ||
      transactionTenB51Indicator ||
      contains10b51(
        transactionFootnotes
      ) ||
      contains10b51(
        natureOfOwnership
      );

    const reportedSharesOwnedAfterRaw =
      firstDefined(
        transaction,
        [
          "shares_owned_after",
          "sharesOwnedAfter",
          "securities_owned_following_transaction",
          "securitiesOwnedFollowingTransaction",
          "post_transaction_shares",
          "postTransactionShares",
        ],
        null
      );

    const reportedSharesOwnedAfter =
      reportedSharesOwnedAfterRaw == null
        ? null
        : roundShares(
            toFiniteNumber(
              reportedSharesOwnedAfterRaw,
              0
            )
          );

    if (
      skipZeroRows &&
      reportedShares === 0 &&
      reportedTransactionValue === 0
    ) {
      continue;
    }

    /*
     * Do not apply a monetary threshold during import.
     * Small valid trades remain stored and will later be hidden by
     * the feed's default $100K filter, with a Show all option.
     */
    const row = {
      accessionNumber,
      transactionIndex,

      issuerCik,

      reportingOwnerName:
        ownerIdentity
          .reportingOwnerName,

      reportingOwnerId:
        ownerIdentity
          .reportingOwnerId,

      reportingOwnerKey:
        ownerIdentity
          .reportingOwnerKey,

      ceo: ceoName,
      officerTitle,

      company,
      ticker,
      sector: "Unknown",

      tradeType,
      tradeTypeLabel,

      transactionDate,

      filedDate:
        filingDate ||
        transactionDate,

      transactionCode,
      acquiredDisposedCode,

      securityTitle,
      ownershipForm,
      natureOfOwnership,

      reportedShares,
      reportedPrice,
      reportedTransactionValue,
      reportedSharesOwnedAfter,

      /*
       * Compatibility fields used by the current grouping and
       * database code. Step 2 will replace their calculation.
       */
      shares:
        reportedShares,

      price:
        reportedPrice,

      value:
        reportedTransactionValue,

      pctHoldingsChange: null,
      sharesOwnedAfter: null,

      tenB51,

      filingFootnotes,
      ownerFootnotes,
      transactionFootnotes,
      allFootnotes,

      perf: {
        sinceTrade: {
          changePct: null,
        },
      },

      sourceUrl,

      ceoMatch:
        normalizeBoolean(
          firstDefined(
            owner,
            [
              "ceo_match",
              "ceoMatch",
              "is_ceo",
              "isCeo",
            ],
            false
          ),
          false
        ),

      ceoMatchConfidence:
        firstDefined(
          owner,
          [
            "ceo_match_confidence",
            "ceoMatchConfidence",
          ],
          null
        ),
    };

    row.transactionDedupeKey =
      buildTransactionDedupeKey(
        row
      );

    row.id = createStableId([
      row.accessionNumber,
      row.reportingOwnerKey,
      row.transactionDate,
      row.transactionCode,
      row.securityTitle,
      numericIdentityPart(
        row.reportedShares,
        6
      ),
      numericIdentityPart(
        row.reportedPrice,
        6
      ),
    ]);

    rows.push(row);
  }

  return rows;
}

/*
 * ============================================================
 * GROUP TRANSACTION ROWS
 * ============================================================
 */

function buildTradeGroupKey(row) {
  /*
   * One card represents one filing event for one reporting owner
   * and one transaction type.
   *
   * Individual transaction dates remain inside group.lines.
   */
  return [
    normalizeIdentityPart(
      row.accessionNumber
    ),

    normalizeIdentityPart(
      row.reportingOwnerKey ||
        row.reportingOwnerId ||
        row.reportingOwnerName ||
        row.ceo
    ),

    normalizeIdentityPart(
      row.tradeType
    ),
  ].join("|");
}

function groupTransactionRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const groupKey =
      buildTradeGroupKey(row);

    if (!groups.has(groupKey)) {
      const reportingOwnerKey =
        row.reportingOwnerKey ||
        normalizeIdentityPart(
          row.reportingOwnerId ||
            row.reportingOwnerName ||
            row.ceo
        );

      groups.set(groupKey, {
        id: createStableId([
  row.accessionNumber,
  reportingOwnerKey,
  row.tradeType,
]),

        accessionNumber:
          row.accessionNumber,

        issuerCik:
          row.issuerCik || null,

        reportingOwnerName:
          row.reportingOwnerName ||
          row.ceo,

        reportingOwnerId:
          row.reportingOwnerId ||
          null,

        reportingOwnerKey,

        ceo: row.ceo,

        officerTitle:
          row.officerTitle,

        company: row.company,
        ticker: row.ticker,
        sector: row.sector,

        tradeType:
          row.tradeType,

        tradeTypeLabel:
          row.tradeTypeLabel,

        transactionDate:
          row.transactionDate,

        transactionDates: [],

        filedDate:
          row.filedDate,

        /*
         * Raw SEC-reported totals.
         *
         * These remain separate because Step 2 will calculate
         * economic units and values after checking ADS ratios.
         */
        reportedShares: 0,
        reportedPrice: 0,
        reportedTransactionValue: 0,

        /*
         * Compatibility fields used by the current database and
         * frontend. Step 2 will assign checked calculated values.
         */
        shares: 0,
        price: 0,
        value: 0,

        pctHoldingsChange: null,
        sharesOwnedAfter: null,

        tenB51: false,

        filingFootnotes: [],
        ownerFootnotes: [],
        transactionFootnotes: [],
        allFootnotes: [],

        perf: {
          sinceTrade: {
            changePct: null,
          },
        },

        lines: [],

        sourceUrl:
          row.sourceUrl,

        ceoMatch:
          row.ceoMatch,

        ceoMatchConfidence:
          row.ceoMatchConfidence ??
          null,
      });
    }

    const group =
      groups.get(groupKey);

    if (
      row.transactionDate &&
      !group.transactionDates.includes(
        row.transactionDate
      )
    ) {
      group.transactionDates.push(
        row.transactionDate
      );
    }

    group.reportedShares =
      roundShares(
        group.reportedShares +
          toFiniteNumber(
            row.reportedShares,
            0
          )
      );

    group.reportedTransactionValue =
      roundMoney(
        group.reportedTransactionValue +
          toFiniteNumber(
            row.reportedTransactionValue,
            0
          )
      );

    group.shares =
      roundShares(
        group.shares +
          toFiniteNumber(
            row.shares,
            0
          )
      );

    group.value =
      roundMoney(
        group.value +
          toFiniteNumber(
            row.value,
            0
          )
      );

    group.tenB51 =
      Boolean(group.tenB51) ||
      Boolean(row.tenB51);

    group.filingFootnotes =
      mergeUniqueStrings(
        group.filingFootnotes,
        row.filingFootnotes
      );

    group.ownerFootnotes =
      mergeUniqueStrings(
        group.ownerFootnotes,
        row.ownerFootnotes
      );

    group.transactionFootnotes =
      mergeUniqueStrings(
        group.transactionFootnotes,
        row.transactionFootnotes
      );

    group.allFootnotes =
      mergeUniqueStrings(
        group.allFootnotes,
        row.allFootnotes
      );

    if (
      row.filedDate &&
      (
        !group.filedDate ||
        new Date(row.filedDate) >
          new Date(group.filedDate)
      )
    ) {
      group.filedDate =
        row.filedDate;
    }

    group.lines.push({
      id:
        row.id,

      transactionDedupeKey:
        row.transactionDedupeKey,

      transactionIndex:
        row.transactionIndex,

      transactionDate:
        row.transactionDate,

      filedDate:
        row.filedDate,

      transactionCode:
        row.transactionCode,

      acquiredDisposedCode:
        row.acquiredDisposedCode,

      securityTitle:
        row.securityTitle,

      ownershipForm:
        row.ownershipForm,

      natureOfOwnership:
        row.natureOfOwnership,

      reportedShares:
        roundShares(
          row.reportedShares
        ),

      reportedPrice:
        roundMoney(
          row.reportedPrice
        ),

      reportedTransactionValue:
        roundMoney(
          row.reportedTransactionValue
        ),

      reportedSharesOwnedAfter:
        row.reportedSharesOwnedAfter ==
        null
          ? null
          : roundShares(
              row.reportedSharesOwnedAfter
            ),

      /*
       * Compatibility values. These will be replaced with checked
       * economic values during the ADS conversion step.
       */
      shares:
        roundShares(
          row.shares
        ),

      price:
        roundMoney(
          row.price
        ),

      value:
        roundMoney(
          row.value
        ),

      tenB51:
        Boolean(row.tenB51),

      filingFootnotes:
        Array.isArray(
          row.filingFootnotes
        )
          ? row.filingFootnotes
          : [],

      ownerFootnotes:
        Array.isArray(
          row.ownerFootnotes
        )
          ? row.ownerFootnotes
          : [],

      transactionFootnotes:
        Array.isArray(
          row.transactionFootnotes
        )
          ? row.transactionFootnotes
          : [],

      allFootnotes:
        Array.isArray(
          row.allFootnotes
        )
          ? row.allFootnotes
          : [],
    });
  }

  const groupedTrades = [];

  for (const group of groups.values()) {
    const pricedLines =
      group.lines.filter(
        (line) =>
          Number(
            line.reportedPrice
          ) > 0 &&
          Number(
            line.reportedShares
          ) > 0
      );

    const pricedShares =
      pricedLines.reduce(
        (sum, line) =>
          sum +
          toFiniteNumber(
            line.reportedShares,
            0
          ),
        0
      );

    const weightedPriceTotal =
      pricedLines.reduce(
        (sum, line) =>
          sum +
          toFiniteNumber(
            line.reportedPrice,
            0
          ) *
            toFiniteNumber(
              line.reportedShares,
              0
            ),
        0
      );

    group.reportedPrice =
      pricedShares > 0
        ? roundMoney(
            weightedPriceTotal /
              pricedShares
          )
        : 0;

    /*
     * Temporary compatibility price.
     *
     * This is not used to recalculate transaction value. Step 2
     * will determine the correct economic units first.
     */
    group.price =
      group.reportedPrice;

    group.transactionDates.sort(
  (a, b) =>
    new Date(a) -
    new Date(b)
);

group.firstTransactionDate =
  group.transactionDates.length
    ? group.transactionDates[0]
    : group.transactionDate;

group.lastTransactionDate =
  group.transactionDates.length
    ? group.transactionDates[
        group.transactionDates.length - 1
      ]
    : group.transactionDate;

/*
 * The main card date is the latest underlying transaction date.
 * This keeps newest-first feed sorting accurate.
 */
group.transactionDate =
  group.lastTransactionDate;

    group.lines.sort((a, b) => {
      const dateDifference =
        new Date(
          a.transactionDate || 0
        ) -
        new Date(
          b.transactionDate || 0
        );

      if (dateDifference !== 0) {
        return dateDifference;
      }

      const codeDifference =
        String(
          a.transactionCode || ""
        ).localeCompare(
          String(
            b.transactionCode || ""
          )
        );

      if (codeDifference !== 0) {
        return codeDifference;
      }

      const securityDifference =
        String(
          a.securityTitle || ""
        ).localeCompare(
          String(
            b.securityTitle || ""
          )
        );

      if (
        securityDifference !== 0
      ) {
        return securityDifference;
      }

      if (
        b.reportedPrice !==
        a.reportedPrice
      ) {
        return (
          b.reportedPrice -
          a.reportedPrice
        );
      }

      return (
        b.reportedShares -
        a.reportedShares
      );
    });

    groupedTrades.push(group);
  }

  return groupedTrades;
}

/*
 * ============================================================
 * OPENAI INPUT
 * ============================================================
 */

function buildAiInput(
  trade
) {
  const calculationTrusted =
    trade.calculationTrusted !==
    false;

  const checkedShares =
    roundShares(
      trade.shares
    );

  const checkedPrice =
    roundMoney(
      trade.price
    );

  const checkedValue =
    calculationTrusted
      ? roundMoney(
          trade.value
        )
      : null;

  const economicUnitLabel =
    trade.economicUnitLabel ||
    "securities";

  const ownershipEntities =
    Array.isArray(
      trade.ownershipEntities
    )
      ? trade.ownershipEntities
      : [];

  const transactionDates =
    Array.isArray(
      trade.transactionDates
    ) &&
    trade.transactionDates.length
      ? trade.transactionDates
      : trade.transactionDate
      ? [trade.transactionDate]
      : [];

  return {
    schemaVersion:
      "checked-form4-summary-v1",

    accessionNumber:
      trade.accessionNumber,

    reportingOwnerName:
      trade.reportingOwnerName ||
      trade.ceo,

    reportingOwnerId:
      trade.reportingOwnerId ||
      null,

    ceo:
      trade.ceo,

    officerTitle:
      trade.officerTitle,

    ceoMatch:
      trade.ceoMatch,

    ceoMatchConfidence:
      trade.ceoMatchConfidence,

    company:
      trade.company,

    ticker:
      trade.ticker,

    tradeType:
      trade.tradeType,

    tradeTypeLabel:
      trade.tradeTypeLabel,

    transactionDate:
  trade.transactionDate,

firstTransactionDate:
  trade.firstTransactionDate ||
  trade.transactionDate,

lastTransactionDate:
  trade.lastTransactionDate ||
  trade.transactionDate,

transactionDates,

    filedDate:
      trade.filedDate,

    tenB51:
      Boolean(
        trade.tenB51
      ),

    planStatus:
      trade.tenB51
        ? "Rule 10b5-1 plan"
        : "No plan status should be inferred",

    ownershipEntities,

    adsRatio:
      trade.adsRatio ||
      null,

    adsConversionApplied:
      Boolean(
        trade.adsConversionApplied
      ),

    calculationTrusted,

    calculationWarnings:
      Array.isArray(
        trade.calculationWarnings
      )
        ? trade.calculationWarnings
        : [],

    /*
     * Compatibility fields used by deterministic fallback content.
     */
    shares:
      checkedShares,

    price:
      checkedPrice,

    value:
      checkedValue,

    economicUnitLabel,

    checkedTotals: {
      unitCount:
        checkedShares,

      unitLabel:
        economicUnitLabel,

      averagePrice:
        checkedPrice > 0
          ? checkedPrice
          : null,

      totalValue:
        checkedValue,

      displayUnitCount:
        formatWholeUnits(
          checkedShares
        ),

      displayUnitLabel:
        unitLabelForDisplay(
          economicUnitLabel,
          checkedShares
        ),

      displayAveragePrice:
        formatPrice(
          checkedPrice
        ),

      displayTotalValue:
        calculationTrusted
          ? formatCompactMoney(
              checkedValue
            )
          : "N/A",
    },

    lineCount:
      Array.isArray(
        trade.lines
      )
        ? trade.lines.length
        : 0,

    lines:
      Array.isArray(
        trade.lines
      )
        ? trade.lines.map(
            (line) => {
              const lineTrusted =
                line
                  .calculationTrusted !==
                false;

              const economicUnits =
                roundShares(
                  line.economicUnits ??
                    line.shares
                );

              const calculatedValue =
                lineTrusted
                  ? roundMoney(
                      line.calculatedValue ??
                        line.value
                    )
                  : null;

              const lineUnitLabel =
                line.economicUnitLabel ||
                economicUnitLabel;

              return {
                transactionDate:
                  line.transactionDate,

                transactionCode:
                  line.transactionCode ||
                  "",

                securityTitle:
                  line.securityTitle ||
                  "Unknown Security",

                ownershipForm:
                  line.ownershipForm ||
                  null,

                natureOfOwnership:
                  line.natureOfOwnership ||
                  null,

                ownershipEntity:
                  line.ownershipEntity ||
                  null,

                tenB51:
                  Boolean(
                    line.tenB51
                  ),

                /*
                 * Audit/source fields. These must not be used as
                 * public transaction values by the model.
                 */
                reportedShares:
                  roundShares(
                    line.reportedShares
                  ),

                reportedPrice:
                  roundMoney(
                    line.reportedPrice
                  ),

                reportedTransactionValue:
                  roundMoney(
                    line
                      .reportedTransactionValue
                  ),

                /*
                 * Checked public values.
                 */
                adsRatio:
                  line.adsRatio ||
                  null,

                adsConversionApplied:
                  Boolean(
                    line
                      .adsConversionApplied
                  ),

                calculationTrusted:
                  lineTrusted,

                economicUnits,

                economicUnitLabel:
                  lineUnitLabel,

                averagePrice:
                  roundMoney(
                    line.reportedPrice
                  ),

                calculatedValue,

                displayUnitCount:
                  formatWholeUnits(
                    economicUnits
                  ),

                displayUnitLabel:
                  unitLabelForDisplay(
                    lineUnitLabel,
                    economicUnits
                  ),

                displayAveragePrice:
                  formatPrice(
                    line.reportedPrice
                  ),

                displayCalculatedValue:
                  lineTrusted
                    ? formatCompactMoney(
                        calculatedValue
                      )
                    : "N/A",
              };
            }
          )
        : [],
  };
}

/*
 * ============================================================
 * DATABASE HELPERS
 * ============================================================
 */

/*
 * Check using both the stable ID and the database's grouped
 * identity fields. This protects against duplicates even if the
 * ID-generation logic changes later.
 */
async function findExistingTrade(
  trade
) {
  const reportingOwnerName =
    trade.reportingOwnerName ||
    trade.ceo;

  const reportingOwnerKey =
    trade.reportingOwnerKey ||
    normalizeIdentityPart(
      trade.reportingOwnerId ||
        reportingOwnerName
    );

  const rows = await sql`
    SELECT id
    FROM trades
    WHERE
      id = ${trade.id}

      OR (
        accession_number =
          ${trade.accessionNumber}

        AND reporting_owner_key =
          ${reportingOwnerKey}

        AND trade_type =
          ${trade.tradeType}
      )

    LIMIT 1
  `;

  return rows[0] || null;
}

async function insertTrade({
  trade,
  title,
  summary,
  tags,
}) {
  const reportingOwnerName =
    trade.reportingOwnerName ||
    trade.ceo;

  const reportingOwnerKey =
    trade.reportingOwnerKey ||
    normalizeIdentityPart(
      trade.reportingOwnerId ||
        reportingOwnerName
    );

  const firstTransactionDate =
    trade.firstTransactionDate ||
    trade.transactionDates?.[0] ||
    trade.transactionDate;

  const lastTransactionDate =
    trade.lastTransactionDate ||
    trade.transactionDates?.[
      trade.transactionDates.length - 1
    ] ||
    trade.transactionDate;

  const pctHoldingsChange =
    trade.pctHoldingsChange == null
      ? null
      : roundTo(
          trade.pctHoldingsChange,
          4
        );

  const sharesOwnedAfter =
    trade.sharesOwnedAfter == null
      ? null
      : roundShares(
          trade.sharesOwnedAfter
        );

  const perf =
    trade.perf &&
    typeof trade.perf === "object"
      ? trade.perf
      : {
          sinceTrade: {
            changePct: null,
          },
        };

  const inserted = await sql`
    INSERT INTO trades (
      id,

      accession_number,

      issuer_cik,

      reporting_owner_name,
      reporting_owner_id,
      reporting_owner_key,

      ceo,
      officer_title,

      company,
      ticker,
      sector,

      trade_type,
      trade_type_label,

      transaction_date,
      first_transaction_date,
      last_transaction_date,
      filed_date,

      reported_shares,
      reported_average_price,
      reported_total_value,

      shares,
      average_price,
      total_value,

      economic_unit_label,

      ads_ratio,
      ads_conversion_applied,

      calculation_trusted,
      calculation_warnings,

      ownership_entities,

      pct_holdings_change,
      shares_owned_after,

      ten_b5_1,

      lines,

      title,
      summary,
      tags,

      source_url,

      ceo_match,
      ceo_match_confidence,

      perf
    )
    VALUES (
      ${trade.id},

      ${trade.accessionNumber},

      ${trade.issuerCik || null},

      ${reportingOwnerName},
      ${trade.reportingOwnerId || null},
      ${reportingOwnerKey},

      ${trade.ceo},
      ${trade.officerTitle || null},

      ${trade.company},
      ${trade.ticker || null},
      ${trade.sector || "Unknown"},

      ${trade.tradeType},
      ${trade.tradeTypeLabel},

      ${trade.transactionDate},
      ${firstTransactionDate},
      ${lastTransactionDate},
      ${trade.filedDate || null},

      ${roundShares(
        trade.reportedShares || 0
      )},

      ${roundMoney(
        trade.reportedPrice || 0
      )},

      ${roundMoney(
        trade.reportedTransactionValue || 0
      )},

      ${roundShares(
        trade.shares || 0
      )},

      ${roundMoney(
        trade.price || 0
      )},

      ${roundMoney(
        trade.value || 0
      )},

      ${
        trade.economicUnitLabel ||
        "securities"
      },

      ${
        trade.adsRatio == null
          ? null
          : roundShares(
              trade.adsRatio
            )
      },

      ${Boolean(
        trade.adsConversionApplied
      )},

      ${
        trade.calculationTrusted ===
        true
      },

      ${JSON.stringify(
        Array.isArray(
          trade.calculationWarnings
        )
          ? trade.calculationWarnings
          : []
      )}::jsonb,

      ${JSON.stringify(
        Array.isArray(
          trade.ownershipEntities
        )
          ? trade.ownershipEntities
          : []
      )}::jsonb,

      ${pctHoldingsChange},
      ${sharesOwnedAfter},

      ${Boolean(
        trade.tenB51
      )},

      ${JSON.stringify(
        Array.isArray(
          trade.lines
        )
          ? trade.lines
          : []
      )}::jsonb,

      ${title},
      ${summary},

      ${JSON.stringify(
        Array.isArray(tags)
          ? tags
          : []
      )}::jsonb,

      ${trade.sourceUrl || null},

      ${Boolean(
        trade.ceoMatch
      )},

      ${
        trade.ceoMatchConfidence ==
        null
          ? null
          : toFiniteNumber(
              trade
                .ceoMatchConfidence,
              0
            )
      },

      ${JSON.stringify(
        perf
      )}::jsonb
    )

    ON CONFLICT DO NOTHING

    RETURNING id
  `;

  return inserted[0] || null;
}

/*
 * ============================================================
 * EXPORTED IMPORTER
 * ============================================================
 */

export async function importForm4Trades(
  options = {}
) {
  const hermaiKey =
    process.env.HERMAI_API_KEY;

  const openaiKey =
    process.env.OPENAI_API_KEY;

  const model =
    process.env.OPENAI_MODEL ||
    "gpt-4.1-mini";

  if (!hermaiKey) {
    throw new Error(
      "Missing HERMAI_API_KEY environment variable"
    );
  }

  /*
   * Import controls can be supplied by the eventual API route
   * or cron job. Defaults match the current feed behaviour.
   */
  const role =
    String(
      options.role || "ceo"
    ).toLowerCase() === "all"
      ? "all"
      : "ceo";

  const limit = clampInteger(
    options.limit,
    10,
    1,
    25
  );

  const initialOffset = clampInteger(
    options.offset,
    0,
    0,
    100000
  );

  const maxPages = clampInteger(
    options.maxPages,
    3,
    1,
    8
  );

  /*
   * This limit applies only to new trades.
   * Trades beyond the limit still get inserted using fallback
   * text, so they are not lost.
   */
  const maxAiSummaries = clampInteger(
    options.maxAiSummaries,
    12,
    0,
    30
  );

  const minimumTradeValue =
    clampNumber(
      options.minimumTradeValue,
      1000,
      0,
      1_000_000_000
    );

  const skipZeroRows =
    options.skipZeroRows !== false;

  /*
   * Default to the same seven-calendar-day import window used by
   * the existing API.
   */
  const now = new Date();

  const end = options.endDate
    ? new Date(options.endDate)
    : now;

  const start = options.startDate
    ? new Date(options.startDate)
    : new Date(
        end.getTime() -
          6 * 24 * 60 * 60 * 1000
      );

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    throw new Error(
      "Invalid import date. Use YYYY-MM-DD."
    );
  }

  const startDate =
    formatDateForQuery(start);

  const endDate =
    formatDateForQuery(end);

  const dayMs =
    24 * 60 * 60 * 1000;

  const startUtc = Date.parse(
    `${startDate}T00:00:00Z`
  );

  const endUtc = Date.parse(
    `${endDate}T00:00:00Z`
  );

  const windowDays =
    Math.floor(
      (endUtc - startUtc) /
        dayMs
    ) + 1;

  if (
    windowDays < 1 ||
    windowDays > 31
  ) {
    throw new Error(
      "Import date window must be between 1 and 31 days."
    );
  }

  /*
   * ============================================================
   * FETCH HERMAI PAGES
   * ============================================================
   */

  const allFilings = [];

  let pageCount = 0;
  let currentOffset =
    initialOffset;

  let hasMore = true;
  let lastMeta = null;
  let lastPagination = null;

  while (
    hasMore &&
    pageCount < maxPages
  ) {
    const page =
      await fetchHermPage({
        hermaiKey,
        startDate,
        endDate,
        role,
        offset: currentOffset,
        limit,
      });

    lastMeta =
      page?.meta || null;

    const filings =
      Array.isArray(
        page?.data?.filings
      )
        ? page.data.filings
        : [];

    const pagination =
      page?.data?.pagination ||
      {};

    lastPagination =
      pagination;

    allFilings.push(
      ...filings
    );

    hasMore = Boolean(
      pagination?.has_more
    );

    currentOffset =
      typeof pagination?.next_offset ===
      "number"
        ? pagination.next_offset
        : currentOffset + limit;

    pageCount += 1;

    if (!hasMore) {
      break;
    }
  }

  /*
   * ============================================================
   * NORMALIZE AND GROUP
   * ============================================================
   */

  const normalizedRows = [];

  for (const filing of allFilings) {
    normalizedRows.push(
      ...filingToTransactionRows(
        filing,
        {
          minimumTradeValue,
          skipZeroRows,
        }
      )
    );
  }

  let groupedTrades =
    groupTransactionRows(
      normalizedRows
    );

    /*
 * Convert reported source units into checked economic units and
 * calculate all public transaction values before OpenAI is called.
 */
groupedTrades =
  applyDeterministicCalculations(
    groupedTrades
  );

  /*
   * The database requires a transaction date.
   * A malformed source row without either a transaction date or
   * filing date cannot be inserted safely.
   */
  const missingDateCount =
    groupedTrades.filter(
      (trade) =>
        !trade.transactionDate
    ).length;

  groupedTrades =
    groupedTrades.filter(
      (trade) =>
        Boolean(
          trade.transactionDate
        )
    );

  groupedTrades.sort(
    (a, b) =>
      new Date(
        b.transactionDate || 0
      ) -
      new Date(
        a.transactionDate || 0
      )
  );

  /*
   * ============================================================
   * CHECK, SUMMARIZE, AND INSERT
   * ============================================================
   */

  let insertedCount = 0;
  let existingCount = 0;
  let conflictCount = 0;

  let aiSummaryCount = 0;
  let fallbackSummaryCount = 0;

  const insertedIds = [];
  const errors = [];

  for (const trade of groupedTrades) {
    try {
      const existing =
        await findExistingTrade(
          trade
        );

      if (existing) {
        existingCount += 1;
        continue;
      }

      let content;

      if (
        aiSummaryCount <
          maxAiSummaries &&
        openaiKey
      ) {
        content =
          await generateAiSummary({
            openaiKey,
            model,
            input:
              buildAiInput(
                trade
              ),
          });

        aiSummaryCount += 1;
      } else {
        content = {
          title:
            fallbackTitle(
              trade
            ),

          summary:
            fallbackSummary(
              trade
            ),

          tags:
            fallbackTags(
              trade
            ),
        };

        fallbackSummaryCount += 1;
      }

      const inserted =
        await insertTrade({
          trade,
          title:
            content.title,
          summary:
            content.summary,
          tags:
            content.tags,
        });

      if (inserted) {
        insertedCount += 1;

        insertedIds.push(
          inserted.id
        );
      } else {
        /*
         * A conflict can happen if another importer inserted the
         * trade after our existence check.
         */
        conflictCount += 1;
      }
    } catch (error) {
      console.error(
        `Failed importing trade ${trade.id}:`,
        error
      );

      errors.push({
        id: trade.id,
        message: String(
          error?.message ||
            error
        ),
      });
    }
  }

  const adsConvertedTradeCount =
  groupedTrades.filter(
    (trade) =>
      trade.adsConversionApplied
  ).length;

const calculationWarningCount =
  groupedTrades.reduce(
    (total, trade) =>
      total +
      (
        Array.isArray(
          trade.calculationWarnings
        )
          ? trade
              .calculationWarnings
              .length
          : 0
      ),
    0
  );

  /*
   * ============================================================
   * IMPORT RESULT
   * ============================================================
   */

  return {
    success:
      errors.length === 0,

    dateRange: {
      startDate,
      endDate,
      windowDays,
    },

    options: {
      role,
      limit,
      initialOffset,
      maxPages,
      maxAiSummaries,
      minimumTradeValue,
      skipZeroRows,
    },

    fetched: {
      pages:
        pageCount,

      filings:
        allFilings.length,

      normalizedRows:
        normalizedRows.length,

      groupedTrades:
        groupedTrades.length,

      adsConvertedTrades:
        adsConvertedTradeCount,

      calculationWarnings:
        calculationWarningCount,

      skippedMissingDate:
        missingDateCount,
    },

    database: {
      inserted:
        insertedCount,

      alreadyExisting:
        existingCount,

      conflicts:
        conflictCount,

      failed:
        errors.length,

      insertedIds,
    },

    summaries: {
      ai:
        aiSummaryCount,

      fallback:
        fallbackSummaryCount,
    },

    hermai: {
      creditsUsed:
        lastMeta
          ?.credits_used ??
        null,

      creditsRemaining:
        lastMeta
          ?.credits_remaining ??
        null,

      cached:
        lastMeta?.cached ??
        null,

      pagination:
        lastPagination,
    },

    errors,
  };
}