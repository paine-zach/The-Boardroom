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

function toNullableNumber(value) {
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

function roundNullableMoney(value) {
  const number = toNullableNumber(value);

  return number === null
    ? null
    : roundMoney(number);
}

function roundNullableShares(value) {
  const number = toNullableNumber(value);

  return number === null
    ? null
    : roundShares(number);
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

function withoutTerminalPeriod(value) {
  return normalizeString(value, "")
    .replace(/[.]+$/g, "")
    .trim();
}

function normalizeName(
  value,
  fallback = "Unknown CEO"
) {
  return normalizeString(value, fallback)
    .replace(/\s+/g, " ")
    .trim();
}


const NAME_SUFFIXES = new Map([
  ["JR", "Jr."],
  ["SR", "Sr."],
  ["II", "II"],
  ["III", "III"],
  ["IV", "IV"],
  ["V", "V"],
]);

function titleCaseNameToken(value) {
  const token = normalizeString(value, "");

  if (!token) {
    return "";
  }

  const upper = token
    .replace(/\./g, "")
    .toUpperCase();

  if (NAME_SUFFIXES.has(upper)) {
    return NAME_SUFFIXES.get(upper);
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

function buildDisplayCeoName(
  owner,
  rawName
) {
  const firstName = normalizeString(
    firstDefined(
      owner,
      [
        "first_name",
        "firstName",
        "given_name",
        "givenName",
      ],
      ""
    ),
    ""
  );

  const middleName = normalizeString(
    firstDefined(
      owner,
      [
        "middle_name",
        "middleName",
        "middle_initial",
        "middleInitial",
      ],
      ""
    ),
    ""
  );

  const lastName = normalizeString(
    firstDefined(
      owner,
      [
        "last_name",
        "lastName",
        "family_name",
        "familyName",
        "surname",
      ],
      ""
    ),
    ""
  );

  const suffix = normalizeString(
    firstDefined(
      owner,
      ["suffix", "name_suffix", "nameSuffix"],
      ""
    ),
    ""
  );

  if (firstName && lastName) {
    return [
      titleCaseNameToken(firstName),
      ...middleName
        .split(/\s+/)
        .filter(Boolean)
        .map(titleCaseNameToken),
      titleCaseNameToken(lastName),
      titleCaseNameToken(suffix),
    ]
      .filter(Boolean)
      .join(" ");
  }

  const normalizedRaw = normalizeName(
    rawName,
    "Unknown CEO"
  );

  if (normalizedRaw === "Unknown CEO") {
    return normalizedRaw;
  }

  if (normalizedRaw.includes(",")) {
    const [lastPart, ...remainingParts] =
      normalizedRaw.split(",");

    return [
      ...remainingParts
        .join(" ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(titleCaseNameToken),
      titleCaseNameToken(lastPart),
    ]
      .filter(Boolean)
      .join(" ");
  }

  const tokens = normalizedRaw
    .split(/\s+/)
    .filter(Boolean);

  /*
   * HermAI may preserve SEC last-name-first order even when the
   * source uses mixed capitalization.
   */
  const looksSecReversed =
    tokens.length >= 2;

  if (looksSecReversed) {
    const last = tokens[0];
    const remaining = tokens.slice(1);
    const suffixTokens = [];

    while (
      remaining.length &&
      NAME_SUFFIXES.has(
        remaining[
          remaining.length - 1
        ]
          .replace(/\./g, "")
          .toUpperCase()
      )
    ) {
      suffixTokens.unshift(
        remaining.pop()
      );
    }

    return [
      ...remaining.map(titleCaseNameToken),
      titleCaseNameToken(last),
      ...suffixTokens.map(titleCaseNameToken),
    ]
      .filter(Boolean)
      .join(" ");
  }

  return tokens
    .map(titleCaseNameToken)
    .join(" ");
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

    row.reportedPrice == null
      ? "missing-price"
      : numericIdentityPart(
          row.reportedPrice,
          6
        ),

    row.exercisePrice == null
      ? "missing-exercise-price"
      : numericIdentityPart(
          row.exercisePrice,
          6
        ),

    normalizeIdentityPart(
      row.acquiredDisposedCode
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

function parseRatioAmount(
  value
) {
  const normalized = String(
    value ?? ""
  )
    .trim()
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[()]/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ");

  const numericValue =
    Number(normalized);

  if (
    Number.isFinite(numericValue) &&
    numericValue > 0
  ) {
    return numericValue;
  }

  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  const tokens =
    normalized.split(" ");

  let total = 0;
  let current = 0;

  for (const token of tokens) {
    if (token === "hundred") {
      current =
        (current || 1) * 100;

      continue;
    }

    if (
      numberWords[token] ===
      undefined
    ) {
      return null;
    }

    current +=
      numberWords[token];
  }

  total += current;

  return total > 0
    ? total
    : null;
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
    /*
     * Each ADS represents sixty Class A ordinary shares.
     * Each ADS represents 60 ordinary shares.
     */
    /\b(?:each|one)\s+(?:american\s+depositary\s+share|ads)\s+represents?\s+(.{1,40}?)\s+(?:class\s+[a-z0-9-]+\s+)?(?:ordinary|common)\s+shares?\b/i,

    /*
     * Sixty ordinary shares are represented by each ADS.
     */
    /\b(.{1,40}?)\s+(?:class\s+[a-z0-9-]+\s+)?(?:ordinary|common)\s+shares?\s+(?:are|is)\s+represented\s+by\s+(?:each|one)\s+(?:american\s+depositary\s+share|ads)\b/i,

    /*
     * Ratio of one ADS to sixty ordinary shares.
     */
    /\bratio\s+of\s+(?:one|1)\s+(?:american\s+depositary\s+share|ads)\s+to\s+(.{1,40}?)\s+(?:class\s+[a-z0-9-]+\s+)?(?:ordinary|common)\s+shares?\b/i,
  ];

  for (const pattern of patterns) {
    const match =
      text.match(pattern);

    if (!match) {
      continue;
    }

    const parsed =
      parseRatioAmount(
        match[1]
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
    /*
     * Price per ADS.
     * Weighted average price of ADS.
     * Price reported in Column 4 is a weighted average price of ADS.
     */
    /\b(?:price|prices|purchase\s+price|sale\s+price|transaction\s+price|average\s+price|weighted\s+average\s+price)[^.;]{0,180}\b(?:per|of)\s+(?:an?\s+|the\s+)?(?:american\s+depositary\s+share|ads)\b/i,

    /\b(?:price|prices)\s+(?:shown|reported|stated|quoted)[^.;]{0,100}\b(?:american\s+depositary\s+share|ads)\s+basis\b/i,

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

function normalizeCode(value) {
  return normalizeString(value, "")
    .toUpperCase();
}

function normalizeAcquiredDisposedCode(value) {
  const normalized = normalizeCode(value);

  if (normalized === "A") {
    return "A";
  }

  if (normalized === "D") {
    return "D";
  }

  return null;
}

function classifySecurityKind(
  securityTitle,
  sourceTable = ""
) {
  const title = normalizeString(
    securityTitle,
    ""
  );

  const source = normalizeString(
    sourceTable,
    ""
  ).toLowerCase();

  if (
    source === "derivative" ||
    /\b(?:option|warrant|right to buy|stock appreciation right|sar)\b/i.test(
      title
    )
  ) {
    return "option";
  }

  if (securityTitleIsAds(title)) {
    return "ads";
  }

  if (
    securityTitleIsUnderlyingShares(
      title
    ) ||
    /\b(?:common stock|ordinary stock|class [a-z0-9-]+ stock)\b/i.test(
      title
    )
  ) {
    return "common_share";
  }

  return source === "derivative"
    ? "other_derivative"
    : "other_security";
}

function classifyTransactionNature({
  transactionCode,
  securityKind,
  acquiredDisposedCode,
}) {
  const code = normalizeCode(
    transactionCode
  );

  if (
    code === "P" ||
    code.includes("PURCHASE") ||
    code.includes("BUY")
  ) {
    return "open_market_purchase";
  }

  if (
    code === "S" ||
    code.includes("SALE") ||
    code.includes("SELL")
  ) {
    return "open_market_sale";
  }

  if (
    code === "F" ||
    code.includes("WITHHOLD") ||
    code.includes("TAX")
  ) {
    return "tax_withholding";
  }

  if (
    code === "M" ||
    code.includes("EXERCISE")
  ) {
    return "option_exercise";
  }

  if (
    code === "A" ||
    code.includes("AWARD") ||
    code.includes("GRANT")
  ) {
    return securityKind === "option" ||
      securityKind === "other_derivative"
      ? "option_grant"
      : "award_or_grant";
  }

  if (
    code === "G" ||
    code.includes("GIFT")
  ) {
    return "gift";
  }

  if (
    securityKind === "option" &&
    acquiredDisposedCode === "A"
  ) {
    return "option_grant";
  }

  return "other";
}

function categoryForTransactionNature(
  transactionNature
) {
  if (
    transactionNature ===
      "open_market_purchase" ||
    transactionNature ===
      "open_market_sale"
  ) {
    return "market";
  }

  if (
    [
      "award_or_grant",
      "option_grant",
      "option_exercise",
      "tax_withholding",
    ].includes(transactionNature)
  ) {
    return "compensation";
  }

  return "other";
}

function compensationSubtypeForNature(
  transactionNature
) {
  const map = {
    award_or_grant: "award",
    option_grant: "option-grant",
    option_exercise: "option-exercise",
    tax_withholding: "withholding",
  };

  return map[transactionNature] || null;
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
    roundNullableMoney(
      line.reportedPrice ??
        line.price
    );

  const exercisePrice =
    roundNullableMoney(
      line.exercisePrice
    );

  const acquiredDisposedCode =
    normalizeAcquiredDisposedCode(
      line.acquiredDisposedCode
    );

  const securityKind =
    line.securityKind ||
    classifySecurityKind(
      line.securityTitle,
      line.sourceTable
    );

  const transactionNature =
    line.transactionNature ||
    classifyTransactionNature({
      transactionCode:
        line.transactionCode,
      securityKind,
      acquiredDisposedCode,
    });

  const cardCategory =
    categoryForTransactionNature(
      transactionNature
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
    securityKind === "ads";

  const securityIsUnderlying =
    securityKind === "common_share";

  const priceIsPerAds =
    textStatesPricePerAds(
      calculationText
    );

  const adsRatioLanguagePresent =
    /\b(?:american\s+depositary\s+share|ads)\b/i.test(
      calculationText
    ) &&
    /\brepresents?\b/i.test(
      calculationText
    );

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
    securityKind === "option" ||
    securityKind === "other_derivative"
      ? "options"
      : adsConversionApplied ||
        securityIsAds
      ? "ADS"
      : securityKind === "common_share"
      ? "shares"
      : "securities";

  const calculationWarnings = [];

  if (
    adsRatioLanguagePresent &&
    !adsRatio
  ) {
    calculationWarnings.push(
      "The filing contains ADS conversion language, but the numeric conversion ratio could not be parsed. The transaction value is not trusted."
    );
  }

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

  const isMarketTransaction =
    cardCategory === "market";

  if (
    isMarketTransaction &&
    (
      reportedPrice === null ||
      reportedPrice <= 0
    )
  ) {
    calculationWarnings.push(
      "An open-market transaction did not include a usable positive transaction price."
    );
  }

  const valuePrice =
    transactionNature ===
      "option_grant" ||
    transactionNature ===
      "option_exercise"
      ? null
      : reportedPrice;

  const calculatedValue =
    valuePrice !== null &&
    valuePrice > 0 &&
    economicUnits > 0
      ? roundMoney(
          economicUnits *
            valuePrice
        )
      : null;

  const reportedTransactionValue =
    line.reportedTransactionValue !==
      null &&
    line.reportedTransactionValue !==
      undefined &&
    line.reportedTransactionValue !==
      ""
      ? roundNullableMoney(
          line.reportedTransactionValue
        )
      : calculatedValue;

  const calculationTrusted =
    calculationWarnings.length === 0;

  const ownershipEntity =
    normalizeOwnershipEntity(
      line.natureOfOwnership
    );

  const displayPrice =
    securityKind === "option" ||
    securityKind ===
      "other_derivative"
      ? exercisePrice
      : reportedPrice;

  const valueRole =
    transactionNature ===
      "open_market_purchase"
      ? "purchase_cost"
      : transactionNature ===
        "open_market_sale"
      ? "sale_proceeds"
      : transactionNature ===
        "tax_withholding"
      ? "withholding_reference_value"
      : "not_applicable";

  return {
    ...line,

    transactionCode:
      normalizeCode(
        line.transactionCode
      ),

    acquiredDisposedCode,
    securityKind,
    transactionNature,
    cardCategory,

    compensationSubtype:
      compensationSubtypeForNature(
        transactionNature
      ),

    sourceTable:
      line.sourceTable || null,

    reportedShares,
    reportedPrice,
    exercisePrice,
    reportedTransactionValue,

    adsRatio:
      adsRatio || null,

    priceIsPerAds,
    adsConversionApplied,

    economicUnits,
    economicUnitLabel,

    calculatedValue,
    valueRole,

    calculationTrusted,
    calculationWarnings,
    ownershipEntity,

    isMarketTransaction,
    isCompensationEvent:
      cardCategory ===
      "compensation",

    isWithholding:
      transactionNature ===
      "tax_withholding",

    shares:
      economicUnits,

    price:
      displayPrice,

    value:
      calculatedValue,
  };
}

function sumLineUnits(
  lines,
  predicate
) {
  return roundShares(
    lines
      .filter(predicate)
      .reduce(
        (sum, line) =>
          sum +
          toFiniteNumber(
            line.economicUnits,
            0
          ),
        0
      )
  );
}

function weightedAverage(
  lines,
  valueSelector
) {
  const eligible = lines.filter(
    (line) => {
      const value = valueSelector(line);

      return (
        value !== null &&
        Number.isFinite(
          Number(value)
        ) &&
        Number(value) > 0 &&
        Number(line.economicUnits) > 0
      );
    }
  );

  const units = eligible.reduce(
    (sum, line) =>
      sum +
      toFiniteNumber(
        line.economicUnits,
        0
      ),
    0
  );

  if (units <= 0) {
    return null;
  }

  const total = eligible.reduce(
    (sum, line) =>
      sum +
      Number(valueSelector(line)) *
        Number(line.economicUnits),
    0
  );

  return roundMoney(total / units);
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

    const marketLines =
      calculatedLines.filter(
        (line) =>
          line.isMarketTransaction
      );

    const commonShareLines =
      calculatedLines.filter(
        (line) =>
          line.securityKind ===
            "common_share" ||
          line.securityKind === "ads"
      );

    const optionLines =
      calculatedLines.filter(
        (line) =>
          line.securityKind === "option" ||
          line.securityKind ===
            "other_derivative"
      );

    const commonSharesAcquired =
      sumLineUnits(
        commonShareLines,
        (line) =>
          line.acquiredDisposedCode ===
          "A"
      );

    const commonSharesDisposed =
      sumLineUnits(
        commonShareLines,
        (line) =>
          line.acquiredDisposedCode ===
          "D"
      );

    const sharesWithheld =
      sumLineUnits(
        commonShareLines,
        (line) =>
          line.transactionNature ===
          "tax_withholding"
      );

    const netCommonShares =
      roundShares(
        commonSharesAcquired -
          commonSharesDisposed
      );

    const optionsAcquired =
      sumLineUnits(
        optionLines,
        (line) =>
          line.acquiredDisposedCode ===
          "A"
      );

    const optionsDisposed =
      sumLineUnits(
        optionLines,
        (line) =>
          line.acquiredDisposedCode ===
          "D"
      );

    const averageExercisePrice =
      weightedAverage(
        optionLines,
        (line) =>
          line.exercisePrice
      );

    const marketUnits =
      roundShares(
        marketLines.reduce(
          (sum, line) =>
            sum +
            toFiniteNumber(
              line.economicUnits,
              0
            ),
          0
        )
      );

    const marketPrice =
      weightedAverage(
        marketLines,
        (line) =>
          line.reportedPrice
      );

    const marketValue =
      marketLines.length &&
      marketLines.every(
        (line) =>
          line.calculatedValue !==
          null
      )
        ? roundMoney(
            marketLines.reduce(
              (sum, line) =>
                sum +
                Number(
                  line.calculatedValue
                ),
              0
            )
          )
        : null;

    const cardCategory =
      trade.cardCategory ||
      (
        marketLines.length ===
        calculatedLines.length
          ? "market"
          : calculatedLines.some(
              (line) =>
                line.cardCategory ===
                "compensation"
            )
          ? "compensation"
          : "other"
      );

    const marketAction =
      cardCategory === "market"
        ? trade.marketAction ||
          (
            calculatedLines.every(
              (line) =>
                line.transactionNature ===
                "open_market_purchase"
            )
              ? "buy"
              : calculatedLines.every(
                  (line) =>
                    line.transactionNature ===
                    "open_market_sale"
                )
              ? "sell"
              : null
          )
        : null;

    const compensationSubtypes = [
      ...new Set(
        calculatedLines
          .map(
            (line) =>
              line.compensationSubtype
          )
          .filter(Boolean)
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

    const calculationTrusted =
      calculatedLines.length > 0 &&
      calculatedLines.every(
        (line) =>
          line.calculationTrusted
      );

    const shares =
      cardCategory === "market"
        ? marketUnits
        : netCommonShares;

    const price =
      cardCategory === "market"
        ? marketPrice
        : null;

    const value =
      cardCategory === "market"
        ? marketValue
        : null;

    const economicUnitLabel =
      cardCategory === "market"
        ? (
            calculatedLines.every(
              (line) =>
                line.economicUnitLabel ===
                "ADS"
            )
              ? "ADS"
              : "shares"
          )
        : "securities";

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

    const rankingEligible =
      cardCategory === "market" &&
      ["buy", "sell"].includes(
        marketAction
      ) &&
      calculationTrusted &&
      price !== null &&
      price > 0 &&
      value !== null &&
      shares > 0;

    const performanceEligible =
      rankingEligible;

    const securityTotals = {
      commonSharesAcquired,
      commonSharesDisposed,
      sharesWithheld,
      netCommonShares,
      optionsAcquired,
      optionsDisposed,
      averageExercisePrice,
    };

    return {
      ...trade,

      lines:
        calculatedLines,

      cardCategory,
      marketAction,
      compensationSubtypes,

      commonSharesAcquired,
      commonSharesDisposed,
      sharesWithheld,
      netCommonShares,
      optionsAcquired,
      optionsDisposed,
      averageExercisePrice,
      securityTotals,

      shares,
      price,
      value,
      economicUnitLabel,

      priceBasis:
        cardCategory === "market"
          ? "weighted_average_transaction_price"
          : null,

      valueBasis:
        marketAction === "buy"
          ? "estimated_purchase_cost"
          : marketAction === "sell"
          ? "estimated_sale_proceeds"
          : null,

      rankingEligible,
      performanceEligible,

      permanentSlug:
        trade.permanentSlug ||
        trade.id,

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

      calculationTrusted,
      calculationWarnings,

      pctHoldingsChange: null,
      sharesOwnedAfter: null,

      planStatus:
        trade.tenB51
          ? "10b5-1"
          : "not-indicated",

      perf: {
        eligible:
          performanceEligible,
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
  const normalized = normalizeCode(value);

  if (
    normalized === "P" ||
    normalized.includes("PURCHASE") ||
    normalized.includes("BUY")
  ) {
    return "Open Market Buy";
  }

  if (
    normalized === "S" ||
    normalized.includes("SALE") ||
    normalized.includes("SELL")
  ) {
    return "Open Market Sell";
  }

  if (
    normalized === "F" ||
    normalized.includes("WITHHOLD") ||
    normalized.includes("TAX")
  ) {
    return "Tax Withholding";
  }

  if (
    normalized === "M" ||
    normalized.includes("EXERCISE")
  ) {
    return "Option Exercise";
  }

  if (
    normalized === "A" ||
    normalized.includes("AWARD") ||
    normalized.includes("GRANT")
  ) {
    return "Award / Grant";
  }

  if (
    normalized === "G" ||
    normalized.includes("GIFT")
  ) {
    return "Gift";
  }

  return "Insider Transaction";
}

function toTradeType(value) {
  const label =
    toTradeTypeLabel(value);

  const map = {
    "Open Market Buy": "buy",
    "Open Market Sell": "sell",
    "Award / Grant": "award",
    "Option Exercise": "option",
    "Tax Withholding": "withholding",
    Gift: "gift",
  };

  return map[label] || "other";
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

  if (
    normalized === "option" ||
    normalized === "options"
  ) {
    return Number(count) === 1
      ? "option"
      : "options";
  }

  return "securities";
}

function describeCompensationTotals(
  trade
) {
  const totals =
    trade.securityTotals || {};

  const parts = [];

  if (
    Number(
      totals.commonSharesAcquired
    ) > 0
  ) {
    parts.push(
      `${formatWholeUnits(
        totals.commonSharesAcquired
      )} common shares acquired or awarded`
    );
  }

  if (
    Number(totals.sharesWithheld) > 0
  ) {
    parts.push(
      `${formatWholeUnits(
        totals.sharesWithheld
      )} common shares withheld or disposed for a tax or exercise-price obligation`
    );
  }

  if (
    Number(totals.optionsAcquired) > 0
  ) {
    parts.push(
      `${formatWholeUnits(
        totals.optionsAcquired
      )} employee stock options acquired or granted`
    );
  }

  if (!parts.length) {
    return "a compensation-related Form 4 event";
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts
    .slice(0, -1)
    .join(", ")}, and ${
      parts[parts.length - 1]
    }`;
}

function fallbackTitle(
  trade
) {
  const ceoName =
    trade.displayCeoName ||
    trade.ceo;

  const companyName =
    withoutTerminalPeriod(
      trade.company
    ) || trade.company;

  if (
    trade.cardCategory ===
    "compensation"
  ) {
    return `${ceoName} — Compensation Event`;
  }

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
    trade.marketAction === "buy" ||
    trade.tradeType === "buy"
      ? "purchased"
      : trade.marketAction ===
          "sell" ||
        trade.tradeType === "sell"
      ? "sold"
      : "reported a transaction involving";

  return `${ceoName} ${action} ${units} ${unitLabel} of ${companyName}.`;
}

function fallbackSummary(
  trade
) {
  const ceoName =
    trade.displayCeoName ||
    trade.ceo;

  const companyName =
    withoutTerminalPeriod(
      trade.company
    ) || trade.company;

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

  if (
    trade.cardCategory ===
    "compensation"
  ) {
    const detail =
      describeCompensationTotals(
        trade
      );

    const exercisePriceText =
      trade.averageExercisePrice !==
        null &&
      trade.averageExercisePrice !==
        undefined
        ? ` The weighted average exercise price for the option lines was ${formatPrice(
            trade.averageExercisePrice
          )}.`
        : "";

    return (
      `${ceoName} reported ${detail} at ${companyName}${ownershipText}.` +
      exercisePriceText
    );
  }

  const units =
    formatWholeUnits(
      trade.shares
    );

  const unitLabel =
    unitLabelForDisplay(
      trade.economicUnitLabel,
      trade.shares
    );

  const firstSentence =
    `${ceoName} reported a ${String(
      trade.tradeTypeLabel
    ).toLowerCase()} involving ` +
    `${units} ${unitLabel} of ${companyName} (${trade.ticker})` +
    `${ownershipText}${planText}.`;

  if (
    trade.calculationTrusted ===
      false ||
    trade.value === null ||
    trade.value === undefined
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

  if (
    trade.cardCategory ===
    "compensation"
  ) {
    tags.push(
      "compensation-event"
    );

    tags.push(
      ...(Array.isArray(
        trade.compensationSubtypes
      )
        ? trade.compensationSubtypes
        : [])
    );
  } else if (
    trade.marketAction === "buy" ||
    trade.tradeType === "buy"
  ) {
    tags.push("open-market-buy");
  } else if (
    trade.marketAction === "sell" ||
    trade.tradeType === "sell"
  ) {
    tags.push("open-market-sell");
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

  return [...new Set(tags)]
    .filter(Boolean)
    .slice(0, 4);
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
- For public wording, use securityTotals, checkedTotals, and each line's checked display fields.
- Copy displayUnitCount, displayUnitLabel, displayTransactionPrice, displayExercisePrice, and displayCalculatedValue exactly as supplied.
- Copy checkedTotals.displayWeightedAveragePrice and checkedTotals.displayTotalValue exactly as supplied.
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
- Clearly distinguish open-market purchases and sales from compensation events.
- Never combine common shares, ADSs, options, or other derivatives under one unit label.
- For compensation cards, use securityTotals and describe shares acquired, shares withheld, net common shares, and options separately.
- Transaction code F means shares were withheld or disposed to satisfy a tax or exercise-price obligation. It is not an open-market sale and must not be described as sale proceeds.
- Option exercise or grant prices are exercise prices, not aggregate transaction prices.
- If a price or value is N/A, do not replace it with $0.00.
- A reported zero does not mean the securities are worthless.
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

  const rawCeoName =
    ownerIdentity.reportingOwnerName;

  const displayCeoName =
    buildDisplayCeoName(
      owner,
      rawCeoName
    );

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

  const filingTenB51 =
    [
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
    ].some((value) =>
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

  let transactions;

  if (
    Array.isArray(
      filing?.transactions
    )
  ) {
    transactions =
      filing.transactions.map(
        (transaction) => ({
          ...transaction,
          __sourceTable:
            firstDefined(
              transaction,
              [
                "source_table",
                "sourceTable",
                "table_type",
                "tableType",
              ],
              ""
            ),
        })
      );
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
      ...nonDerivative.map(
        (transaction) => ({
          ...transaction,
          __sourceTable:
            "non_derivative",
        })
      ),
      ...derivative.map(
        (transaction) => ({
          ...transaction,
          __sourceTable:
            "derivative",
        })
      ),
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
              "number_of_derivative_securities",
              "numberOfDerivativeSecurities",
              "derivative_securities_acquired",
              "derivativeSecuritiesAcquired",
            ],
            0
          ),
          0
        )
      );

    const reportedPrice =
      roundNullableMoney(
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
            "price_of_derivative_security",
            "priceOfDerivativeSecurity",
          ],
          null
        )
      );

    const exercisePrice =
      roundNullableMoney(
        firstDefined(
          transaction,
          [
            "conversion_or_exercise_price",
            "conversionOrExercisePrice",
            "conversion_or_exercise_price_of_derivative_security",
            "conversionOrExercisePriceOfDerivativeSecurity",
            "exercise_price",
            "exercisePrice",
            "strike_price",
            "strikePrice",
          ],
          null
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

    const reportedTransactionValue =
      suppliedTransactionValue !== null &&
      suppliedTransactionValue !==
        undefined &&
      suppliedTransactionValue !== ""
        ? roundNullableMoney(
            suppliedTransactionValue
          )
        : reportedPrice !== null
        ? roundMoney(
            reportedShares *
              reportedPrice
          )
        : null;

    const transactionCode =
      normalizeCode(
        firstDefined(
          transaction,
          [
            "transaction_code",
            "transactionCode",
            "code",
            "transaction_type_code",
            "transactionTypeCode",
          ],
          ""
        )
      );

    const rawTransactionType =
      normalizeString(
        firstDefined(
          transaction,
          [
            "transaction_type",
            "transactionType",
          ],
          ""
        ),
        ""
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

    const explicitSourceTable =
      normalizeString(
        transaction.__sourceTable,
        ""
      ).toLowerCase();

    const sourceTable =
      explicitSourceTable ||
      (
        normalizeBoolean(
          firstDefined(
            transaction,
            [
              "is_derivative",
              "isDerivative",
              "derivative",
            ],
            false
          ),
          false
        )
          ? "derivative"
          : ""
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
      normalizeAcquiredDisposedCode(
        firstDefined(
          transaction,
          [
            "acquired_disposed_code",
            "acquiredDisposedCode",
            "acquired_or_disposed",
            "acquiredOrDisposed",
          ],
          null
        )
      );

    const securityKind =
      classifySecurityKind(
        securityTitle,
        sourceTable
      );

    const transactionNature =
      classifyTransactionNature({
        transactionCode:
          transactionCode ||
          rawTransactionType,
        securityKind,
        acquiredDisposedCode,
      });

    const cardCategory =
      categoryForTransactionNature(
        transactionNature
      );

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

    const allFootnotes =
      mergeUniqueStrings(
        filingFootnotes,
        ownerFootnotes,
        transactionFootnotes
      );

    const tenB51 =
      filingTenB51 ||
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
      ) ||
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
      roundNullableShares(
        reportedSharesOwnedAfterRaw
      );

    if (
      skipZeroRows &&
      reportedShares === 0 &&
      (
        reportedTransactionValue ===
          null ||
        reportedTransactionValue === 0
      )
    ) {
      continue;
    }

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

    const row = {
      accessionNumber,
      transactionIndex,
      issuerCik,

      reportingOwnerName:
        rawCeoName,
      reportingOwnerId:
        ownerIdentity.reportingOwnerId,
      reportingOwnerKey:
        ownerIdentity.reportingOwnerKey,

      rawCeoName,
      displayCeoName,
      ceo: displayCeoName,
      officerTitle,

      company,
      ticker,
      sector: "Unknown",

      tradeType,
      tradeTypeLabel,
      cardCategory,
      marketAction:
        tradeType === "buy" ||
        tradeType === "sell"
          ? tradeType
          : null,

      compensationSubtype:
        compensationSubtypeForNature(
          transactionNature
        ),

      transactionDate,
      filedDate:
        filingDate ||
        transactionDate,

      transactionCode,
      rawTransactionType,
      transactionNature,
      acquiredDisposedCode,
      securityKind,
      sourceTable,

      securityTitle,
      ownershipForm,
      natureOfOwnership,

      reportedShares,
      reportedPrice,
      exercisePrice,
      reportedTransactionValue,
      reportedSharesOwnedAfter,

      shares:
        reportedShares,
      price:
        securityKind === "option"
          ? exercisePrice
          : reportedPrice,
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
      row.reportedPrice === null
        ? "na"
        : numericIdentityPart(
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

function groupTradeType(row) {
  if (row.cardCategory === "market") {
    return row.marketAction ||
      row.tradeType;
  }

  if (
    row.cardCategory ===
    "compensation"
  ) {
    return "compensation";
  }

  return row.tradeType || "other";
}

function buildTradeGroupKey(row) {
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
      groupTradeType(row)
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

      const groupedTradeType =
        groupTradeType(row);

      const groupedTradeLabel =
        groupedTradeType ===
          "compensation"
          ? "Compensation Event"
          : row.tradeTypeLabel;

      const id = createStableId([
        row.accessionNumber,
        reportingOwnerKey,
        groupedTradeType,
      ]);

      groups.set(groupKey, {
        id,
        permanentSlug: id,

        accessionNumber:
          row.accessionNumber,
        issuerCik:
          row.issuerCik || null,

        reportingOwnerName:
          row.reportingOwnerName ||
          row.rawCeoName ||
          row.ceo,
        reportingOwnerId:
          row.reportingOwnerId || null,
        reportingOwnerKey,

        rawCeoName:
          row.rawCeoName ||
          row.reportingOwnerName ||
          row.ceo,
        displayCeoName:
          row.displayCeoName ||
          row.ceo,
        ceo:
          row.displayCeoName ||
          row.ceo,

        officerTitle:
          row.officerTitle,
        company: row.company,
        ticker: row.ticker,
        sector: row.sector,

        tradeType:
          groupedTradeType,
        tradeTypeLabel:
          groupedTradeLabel,
        cardCategory:
          row.cardCategory,
        marketAction:
          row.cardCategory ===
          "market"
            ? row.marketAction
            : null,
        compensationSubtypes: [],

        transactionDate:
          row.transactionDate,
        transactionDates: [],
        filedDate:
          row.filedDate,

        reportedShares: 0,
        reportedPrice: null,
        reportedTransactionValue:
          null,

        shares: 0,
        price: null,
        value: null,

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

    group.tenB51 =
      Boolean(group.tenB51) ||
      Boolean(row.tenB51);

    group.compensationSubtypes = [
      ...new Set(
        [
          ...group.compensationSubtypes,
          row.compensationSubtype,
        ].filter(Boolean)
      ),
    ];

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
      id: row.id,
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
      rawTransactionType:
        row.rawTransactionType,
      transactionNature:
        row.transactionNature,
      acquiredDisposedCode:
        row.acquiredDisposedCode,
      securityKind:
        row.securityKind,
      sourceTable:
        row.sourceTable,
      cardCategory:
        row.cardCategory,
      compensationSubtype:
        row.compensationSubtype,

      securityTitle:
        row.securityTitle,
      ownershipForm:
        row.ownershipForm,
      natureOfOwnership:
        row.natureOfOwnership,

      reportedShares:
        row.reportedShares,
      reportedPrice:
        row.reportedPrice,
      exercisePrice:
        row.exercisePrice,
      reportedTransactionValue:
        row.reportedTransactionValue,
      reportedSharesOwnedAfter:
        row.reportedSharesOwnedAfter,

      shares: row.shares,
      price: row.price,
      value: row.value,
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
          line.reportedPrice !==
            null &&
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

    group.reportedPrice =
      pricedShares > 0
        ? roundMoney(
            pricedLines.reduce(
              (sum, line) =>
                sum +
                Number(
                  line.reportedPrice
                ) *
                  Number(
                    line.reportedShares
                  ),
              0
            ) / pricedShares
          )
        : null;

    const reportedValues =
      group.lines
        .map(
          (line) =>
            line.reportedTransactionValue
        )
        .filter(
          (value) =>
            value !== null &&
            value !== undefined
        );

    group.reportedTransactionValue =
      reportedValues.length
        ? roundMoney(
            reportedValues.reduce(
              (sum, value) =>
                sum + Number(value),
              0
            )
          )
        : null;

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

      return (
        Number(b.reportedShares) -
        Number(a.reportedShares)
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
      "checked-form4-summary-v2",

    accessionNumber:
      trade.accessionNumber,

    reportingOwnerName:
      trade.reportingOwnerName ||
      trade.rawCeoName ||
      trade.ceo,

    displayCeoName:
      trade.displayCeoName ||
      trade.ceo,

    reportingOwnerId:
      trade.reportingOwnerId ||
      null,

    ceo:
      trade.displayCeoName ||
      trade.ceo,

    officerTitle:
      trade.officerTitle,
    company: trade.company,
    ticker: trade.ticker,

    tradeType:
      trade.tradeType,
    tradeTypeLabel:
      trade.tradeTypeLabel,
    cardCategory:
      trade.cardCategory,
    marketAction:
      trade.marketAction,
    compensationSubtypes:
      trade.compensationSubtypes ||
      [],

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
      Boolean(trade.tenB51),
    ownershipEntities,

    adsRatio:
      trade.adsRatio || null,
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

    securityTotals:
      trade.securityTotals || {},

    checkedTotals: {
      marketUnits:
        trade.cardCategory ===
          "market"
          ? roundShares(
              trade.shares
            )
          : null,
      marketUnitLabel:
        trade.cardCategory ===
          "market"
          ? trade.economicUnitLabel
          : null,
      weightedAveragePrice:
        trade.price == null
          ? null
          : roundMoney(
              trade.price
            ),
      totalValue:
        calculationTrusted &&
        trade.value != null
          ? roundMoney(
              trade.value
            )
          : null,
      displayMarketUnits:
        trade.cardCategory ===
          "market"
          ? formatWholeUnits(
              trade.shares
            )
          : "N/A",
      displayMarketUnitLabel:
        trade.cardCategory ===
          "market"
          ? unitLabelForDisplay(
              trade.economicUnitLabel,
              trade.shares
            )
          : "N/A",
      displayWeightedAveragePrice:
        formatPrice(
          trade.price
        ),
      displayTotalValue:
        calculationTrusted &&
        trade.value != null
          ? formatCompactMoney(
              trade.value
            )
          : "N/A",
    },

    lines:
      Array.isArray(trade.lines)
        ? trade.lines.map(
            (line) => ({
              transactionDate:
                line.transactionDate,
              transactionCode:
                line.transactionCode,
              transactionNature:
                line.transactionNature,
              acquiredDisposedCode:
                line.acquiredDisposedCode,
              securityTitle:
                line.securityTitle,
              securityKind:
                line.securityKind,
              reportedShares:
                roundShares(
                  line.reportedShares
                ),
              reportedPrice:
                line.reportedPrice ==
                null
                  ? null
                  : roundMoney(
                      line.reportedPrice
                    ),
              exercisePrice:
                line.exercisePrice ==
                null
                  ? null
                  : roundMoney(
                      line.exercisePrice
                    ),
              economicUnits:
                roundShares(
                  line.economicUnits
                ),
              economicUnitLabel:
                line.economicUnitLabel,
              calculatedValue:
                line.calculatedValue ==
                null
                  ? null
                  : roundMoney(
                      line.calculatedValue
                    ),
              valueRole:
                line.valueRole,
              displayUnitCount:
                formatWholeUnits(
                  line.economicUnits
                ),
              displayUnitLabel:
                unitLabelForDisplay(
                  line.economicUnitLabel,
                  line.economicUnits
                ),
              displayTransactionPrice:
                formatPrice(
                  line.reportedPrice
                ),
              displayExercisePrice:
                formatPrice(
                  line.exercisePrice
                ),
              displayCalculatedValue:
                line.calculatedValue ==
                null
                  ? "N/A"
                  : formatCompactMoney(
                      line.calculatedValue
                    ),
              calculationTrusted:
                line.calculationTrusted,
            })
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

async function findCompensationTrades(
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

  return sql`
    SELECT
      id,
      trade_type
    FROM trades
    WHERE
      accession_number =
        ${trade.accessionNumber}

      AND reporting_owner_key =
        ${reportingOwnerKey}

      AND (
        card_category =
          'compensation'

        OR trade_type IN (
          'award',
          'option',
          'withholding',
          'gift',
          'compensation'
        )
      )
    ORDER BY
      CASE
        WHEN id = ${trade.id}
          THEN 0
        WHEN trade_type =
          'compensation'
          THEN 1
        ELSE 2
      END,
      created_at
  `;
}

async function insertTrade({
  trade,
  title,
  summary,
  tags,
}) {
  const reportingOwnerName =
    trade.reportingOwnerName ||
    trade.rawCeoName ||
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

  const perf =
    trade.perf &&
    typeof trade.perf === "object"
      ? trade.perf
      : {
          eligible: false,
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
      raw_ceo_name,
      display_ceo_name,
      ceo,
      officer_title,

      company,
      ticker,
      sector,

      trade_type,
      trade_type_label,
      card_category,
      market_action,
      compensation_subtypes,

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

      common_shares_acquired,
      common_shares_disposed,
      shares_withheld,
      net_common_shares,
      options_acquired,
      options_disposed,
      average_exercise_price,
      security_totals,

      price_basis,
      value_basis,
      ranking_eligible,
      performance_eligible,
      permanent_slug,

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
      ${trade.rawCeoName || reportingOwnerName},
      ${trade.displayCeoName || trade.ceo},
      ${trade.displayCeoName || trade.ceo},
      ${trade.officerTitle || null},

      ${trade.company},
      ${trade.ticker || null},
      ${trade.sector || "Unknown"},

      ${trade.tradeType},
      ${trade.tradeTypeLabel},
      ${trade.cardCategory || "other"},
      ${trade.marketAction || null},
      ${JSON.stringify(
        trade.compensationSubtypes || []
      )}::jsonb,

      ${trade.transactionDate},
      ${firstTransactionDate},
      ${lastTransactionDate},
      ${trade.filedDate || null},

      ${roundShares(
        trade.reportedShares || 0
      )},
      ${roundNullableMoney(
        trade.reportedPrice
      )},
      ${roundNullableMoney(
        trade.reportedTransactionValue
      )},

      ${roundShares(
        trade.shares || 0
      )},
      ${roundNullableMoney(
        trade.price
      )},
      ${roundNullableMoney(
        trade.value
      )},
      ${trade.economicUnitLabel || "securities"},

      ${roundShares(
        trade.commonSharesAcquired || 0
      )},
      ${roundShares(
        trade.commonSharesDisposed || 0
      )},
      ${roundShares(
        trade.sharesWithheld || 0
      )},
      ${roundShares(
        trade.netCommonShares || 0
      )},
      ${roundShares(
        trade.optionsAcquired || 0
      )},
      ${roundShares(
        trade.optionsDisposed || 0
      )},
      ${roundNullableMoney(
        trade.averageExercisePrice
      )},
      ${JSON.stringify(
        trade.securityTotals || {}
      )}::jsonb,

      ${trade.priceBasis || null},
      ${trade.valueBasis || null},
      ${Boolean(trade.rankingEligible)},
      ${Boolean(trade.performanceEligible)},
      ${trade.permanentSlug || trade.id},

      ${trade.adsRatio == null
        ? null
        : roundShares(
            trade.adsRatio
          )},
      ${Boolean(
        trade.adsConversionApplied
      )},
      ${trade.calculationTrusted === true},
      ${JSON.stringify(
        trade.calculationWarnings || []
      )}::jsonb,
      ${JSON.stringify(
        trade.ownershipEntities || []
      )}::jsonb,

      ${null},
      ${null},
      ${Boolean(trade.tenB51)},
      ${JSON.stringify(
        trade.lines || []
      )}::jsonb,

      ${title},
      ${summary},
      ${JSON.stringify(tags || [])}::jsonb,
      ${trade.sourceUrl || null},

      ${Boolean(trade.ceoMatch)},
      ${trade.ceoMatchConfidence == null
        ? null
        : toFiniteNumber(
            trade.ceoMatchConfidence,
            0
          )},
      ${JSON.stringify(perf)}::jsonb
    )

    ON CONFLICT DO NOTHING

    RETURNING id
  `;

  return inserted[0] || null;
}

async function refreshTrade({
  existingId,
  trade,
  title,
  summary,
  tags,
}) {
  const reportingOwnerName =
    trade.reportingOwnerName ||
    trade.rawCeoName ||
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

  const perf =
    trade.perf &&
    typeof trade.perf === "object"
      ? trade.perf
      : {
          eligible: false,
          sinceTrade: {
            changePct: null,
          },
        };

  const refreshed = await sql`
    UPDATE trades
    SET
      accession_number = ${trade.accessionNumber},
      issuer_cik = ${trade.issuerCik || null},
      reporting_owner_name = ${reportingOwnerName},
      reporting_owner_id = ${trade.reportingOwnerId || null},
      reporting_owner_key = ${reportingOwnerKey},
      raw_ceo_name = ${trade.rawCeoName || reportingOwnerName},
      display_ceo_name = ${trade.displayCeoName || trade.ceo},
      ceo = ${trade.displayCeoName || trade.ceo},
      officer_title = ${trade.officerTitle || null},
      company = ${trade.company},
      ticker = ${trade.ticker || null},
      sector = ${trade.sector || "Unknown"},
      trade_type = ${trade.tradeType},
      trade_type_label = ${trade.tradeTypeLabel},
      card_category = ${trade.cardCategory || "other"},
      market_action = ${trade.marketAction || null},
      compensation_subtypes =
        ${JSON.stringify(trade.compensationSubtypes || [])}::jsonb,
      transaction_date = ${trade.transactionDate},
      first_transaction_date = ${firstTransactionDate},
      last_transaction_date = ${lastTransactionDate},
      filed_date = ${trade.filedDate || null},
      reported_shares =
        ${roundShares(trade.reportedShares || 0)},
      reported_average_price =
        ${roundNullableMoney(trade.reportedPrice)},
      reported_total_value =
        ${roundNullableMoney(trade.reportedTransactionValue)},
      shares = ${roundShares(trade.shares || 0)},
      average_price = ${roundNullableMoney(trade.price)},
      total_value = ${roundNullableMoney(trade.value)},
      economic_unit_label =
        ${trade.economicUnitLabel || "securities"},
      common_shares_acquired =
        ${roundShares(trade.commonSharesAcquired || 0)},
      common_shares_disposed =
        ${roundShares(trade.commonSharesDisposed || 0)},
      shares_withheld =
        ${roundShares(trade.sharesWithheld || 0)},
      net_common_shares =
        ${roundShares(trade.netCommonShares || 0)},
      options_acquired =
        ${roundShares(trade.optionsAcquired || 0)},
      options_disposed =
        ${roundShares(trade.optionsDisposed || 0)},
      average_exercise_price =
        ${roundNullableMoney(trade.averageExercisePrice)},
      security_totals =
        ${JSON.stringify(trade.securityTotals || {})}::jsonb,
      price_basis = ${trade.priceBasis || null},
      value_basis = ${trade.valueBasis || null},
      ranking_eligible = ${Boolean(trade.rankingEligible)},
      performance_eligible = ${Boolean(trade.performanceEligible)},
      permanent_slug = ${existingId},
      ads_ratio =
        ${trade.adsRatio == null
          ? null
          : roundShares(trade.adsRatio)},
      ads_conversion_applied =
        ${Boolean(trade.adsConversionApplied)},
      calculation_trusted =
        ${trade.calculationTrusted === true},
      calculation_warnings =
        ${JSON.stringify(trade.calculationWarnings || [])}::jsonb,
      ownership_entities =
        ${JSON.stringify(trade.ownershipEntities || [])}::jsonb,
      pct_holdings_change = NULL,
      shares_owned_after = NULL,
      ten_b5_1 = ${Boolean(trade.tenB51)},
      lines = ${JSON.stringify(trade.lines || [])}::jsonb,
      title = ${title},
      summary = ${summary},
      tags = ${JSON.stringify(tags || [])}::jsonb,
      source_url = ${trade.sourceUrl || null},
      ceo_match = ${Boolean(trade.ceoMatch)},
      ceo_match_confidence =
        ${trade.ceoMatchConfidence == null
          ? null
          : toFiniteNumber(trade.ceoMatchConfidence, 0)},
      perf = ${JSON.stringify(perf)}::jsonb
    WHERE id = ${existingId}
    RETURNING id
  `;

  if (!refreshed[0]) {
    throw new Error(
      `Could not refresh trade ${existingId}.`
    );
  }

  return refreshed[0];
}

/*
 * Copy and verify votes before deleting legacy compensation
 * cards. A failure leaves the legacy cards and votes in place.
 */
async function consolidateCompensationTrade({
  trade,
  existingTrades,
  title,
  summary,
  tags,
}) {
  /*
   * Reuse an already-correct compensation card when one exists.
   * Otherwise create the new corrected grouped-card identity.
   */
  const canonicalExisting =
    existingTrades.find(
      (row) =>
        row.trade_type ===
          "compensation"
    );

  const targetId =
    canonicalExisting?.id ||
    trade.id;

  if (
    !existingTrades.some(
      (row) => row.id === targetId
    )
  ) {
    const inserted =
      await insertTrade({
        trade,
        title,
        summary,
        tags,
      });

    if (!inserted) {
      const targetRows = await sql`
        SELECT id
        FROM trades
        WHERE id = ${targetId}
        LIMIT 1
      `;

      if (!targetRows[0]) {
        throw new Error(
          `Could not create compensation target ${targetId}.`
        );
      }
    }
  }

  await refreshTrade({
    existingId: targetId,
    trade,
    title,
    summary,
    tags,
  });

  const reportingOwnerKey =
    trade.reportingOwnerKey ||
    normalizeIdentityPart(
      trade.reportingOwnerId ||
        trade.reportingOwnerName ||
        trade.ceo
    );

  const sourceCounts = await sql`
    SELECT
      COUNT(DISTINCT voter_id)::integer AS voter_count
    FROM trade_votes
    WHERE trade_id IN (
      SELECT id
      FROM trades
      WHERE
        accession_number = ${trade.accessionNumber}
        AND reporting_owner_key = ${reportingOwnerKey}
        AND (
          card_category = 'compensation'
          OR trade_type IN (
            'award',
            'option',
            'withholding',
            'gift',
            'compensation'
          )
        )
    )
  `;

  const expectedVoters =
    Number(sourceCounts[0]?.voter_count || 0);

  await sql`
    INSERT INTO trade_votes (
      trade_id,
      voter_id,
      created_at
    )
    SELECT
      ${targetId},
      voter_id,
      MIN(created_at)
    FROM trade_votes
    WHERE trade_id IN (
      SELECT id
      FROM trades
      WHERE
        accession_number = ${trade.accessionNumber}
        AND reporting_owner_key = ${reportingOwnerKey}
        AND (
          card_category = 'compensation'
          OR trade_type IN (
            'award',
            'option',
            'withholding',
            'gift',
            'compensation'
          )
        )
    )
    GROUP BY voter_id
    ON CONFLICT (
      trade_id,
      voter_id
    ) DO NOTHING
  `;

  const targetCounts = await sql`
    SELECT COUNT(*)::integer AS voter_count
    FROM trade_votes
    WHERE trade_id = ${targetId}
  `;

  const preservedVoters =
    Number(targetCounts[0]?.voter_count || 0);

  if (preservedVoters < expectedVoters) {
    throw new Error(
      `Vote verification failed for ${targetId}: ` +
      `expected ${expectedVoters}, found ${preservedVoters}.`
    );
  }

  const deleted = await sql`
    DELETE FROM trades
    WHERE
      id <> ${targetId}
      AND accession_number = ${trade.accessionNumber}
      AND reporting_owner_key = ${reportingOwnerKey}
      AND (
        card_category = 'compensation'
        OR trade_type IN (
          'award',
          'option',
          'withholding',
          'gift',
          'compensation'
        )
      )
    RETURNING id
  `;

  return {
    targetId,
    removedCards: deleted.length,
    preservedVoters,
  };
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
   * The protected endpoint must opt in explicitly. When false,
   * the existing skip-if-found import behaviour is unchanged.
   */
  const refreshExisting =
    options.refreshExisting === true;

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
  let refreshedCount = 0;
  let consolidatedCount = 0;
  let consolidatedLegacyCardCount = 0;
  let preservedVoteCount = 0;

  let aiSummaryCount = 0;
  let fallbackSummaryCount = 0;

  const insertedIds = [];
  const refreshedIds = [];
  const consolidatedIds = [];
  const errors = [];

  for (const trade of groupedTrades) {
    try {
      const isCompensation =
        trade.cardCategory ===
          "compensation" ||
        trade.tradeType ===
          "compensation";

      const compensationTrades =
        refreshExisting &&
        isCompensation
          ? await findCompensationTrades(
              trade
            )
          : [];

      const existing =
        compensationTrades[0] ||
        await findExistingTrade(
          trade
        );

      if (
        existing &&
        !refreshExisting
      ) {
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

      if (
        refreshExisting &&
        isCompensation &&
        compensationTrades.length
      ) {
        const consolidated =
          await consolidateCompensationTrade({
            trade,
            existingTrades:
              compensationTrades,
            title:
              content.title,
            summary:
              content.summary,
            tags:
              content.tags,
          });

        refreshedCount += 1;
        refreshedIds.push(
          consolidated.targetId
        );

        if (
          consolidated.removedCards >
          0
        ) {
          consolidatedCount += 1;
          consolidatedLegacyCardCount +=
            consolidated.removedCards;
          consolidatedIds.push(
            consolidated.targetId
          );
        }

        preservedVoteCount +=
          consolidated.preservedVoters;

        continue;
      }

      if (
        refreshExisting &&
        existing
      ) {
        const refreshed =
          await refreshTrade({
            existingId:
              existing.id,
            trade,
            title:
              content.title,
            summary:
              content.summary,
            tags:
              content.tags,
          });

        refreshedCount += 1;
        refreshedIds.push(
          refreshed.id
        );

        continue;
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
      refreshExisting,
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

      refreshed:
        refreshedCount,

      consolidated:
        consolidatedCount,

      consolidatedLegacyCards:
        consolidatedLegacyCardCount,

      preservedVotes:
        preservedVoteCount,

      failed:
        errors.length,

      insertedIds,
      refreshedIds,
      consolidatedIds,
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
