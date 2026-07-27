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

function formatCompactMoney(value) {
  const amount = roundMoney(value);
  const absoluteAmount = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";

  if (absoluteAmount >= 1_000_000_000) {
    return `${sign}$${(
      absoluteAmount / 1_000_000_000
    ).toFixed(1)}B`;
  }

  if (absoluteAmount >= 1_000_000) {
    return `${sign}$${(
      absoluteAmount / 1_000_000
    ).toFixed(1)}M`;
  }

  if (absoluteAmount >= 1_000) {
    return `${sign}$${Math.round(
      absoluteAmount / 1_000
    )}K`;
  }

  return `${sign}$${absoluteAmount.toFixed(
    2
  )}`;
}

function fallbackTitle(trade) {
  const shares = roundShares(
    trade.shares || 0
  ).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });

  const action =
    trade.tradeType === "buy"
      ? "purchased"
      : trade.tradeType === "sell"
      ? "sold"
      : trade.tradeType === "award"
      ? "received"
      : trade.tradeType === "option"
      ? "exercised options involving"
      : "reported a transaction involving";

  return `${trade.ceo} ${action} ${shares} shares of ${trade.company}.`;
}

function fallbackSummary(trade) {
  const shares = roundShares(
    trade.shares || 0
  ).toLocaleString("en-US", {
    maximumFractionDigits: 6,
  });

  const value = formatCompactMoney(
    trade.value || 0
  );

  const rowCount = Array.isArray(
    trade.lines
  )
    ? trade.lines.length
    : 1;

  const rowText =
    rowCount > 1
      ? ` across ${rowCount} transaction lines`
      : "";

  return `${trade.ceo} reported a ${String(
    trade.tradeTypeLabel
  ).toLowerCase()} involving ${shares} shares${rowText}, with a total reported value of approximately ${value}, for ${trade.company} (${trade.ticker}).`;
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

async function fetchHermPage({
  hermaiKey,
  startDate,
  endDate,
  role,
  offset,
  limit,
}) {
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

  if (!response.ok) {
    const detail = await response.text();

    throw new Error(
      `HermAI request failed (${response.status}): ${detail}`
    );
  }

  return response.json();
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
- Clearly distinguish open-market trades from awards and option exercises.
- Mention a 10b5-1 plan only when tenB51 is true.
- Treat all transaction lines as parts of one grouped filing event.
- Use the aggregated totals rather than one individual transaction line.
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
                "You return strict JSON only and never add unsupported facts.",
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

    const title =
      typeof parsed?.title === "string" &&
      parsed.title.trim()
        ? parsed.title.trim()
        : fallback.title;

    const summary =
      typeof parsed?.summary === "string" &&
      parsed.summary.trim()
        ? parsed.summary.trim()
        : fallback.summary;

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

function filingToTransactionRows(filing, options) {
  const {
    minimumTradeValue,
    skipZeroRows,
  } = options;

  const issuer = filing?.issuer || {};

  const owners = Array.isArray(
    filing?.reporting_owners
  )
    ? filing.reporting_owners
    : [];

  const owner =
    owners.find(
      (candidate) => candidate?.ceo_match
    ) ||
    owners[0] ||
    {};

  const ceoName = normalizeName(
    owner?.name,
    "Unknown CEO"
  );

  const officerTitle = normalizeString(
    owner?.officer_title,
    ""
  );

  const accessionNumber = normalizeString(
    filing?.accession_number,
    "unknown-accession"
  );

  const company = normalizeString(
    issuer?.name,
    "Unknown Company"
  );

  const ticker = normalizeString(
    issuer?.ticker,
    "N/A"
  );

  const sourceUrl =
    normalizeString(filing?.source_url) ||
    normalizeString(
      filing?.source_document_url
    ) ||
    "#";

  const filingDate = normalizeDate(
    filing?.filed_date,
    null
  );

  const filingFootnotes = Array.isArray(
    filing?.footnotes
  )
    ? filing.footnotes
    : [];

  const filingFootnoteText =
    filingFootnotes
      .map((footnote) =>
        String(footnote ?? "")
      )
      .join(" ")
      .toLowerCase();

  const filingTenB51 =
    filingFootnoteText.includes("10b5-1") ||
    filingFootnoteText.includes("10b5–1");

  const transactions = Array.isArray(
    filing?.transactions
  )
    ? filing.transactions
    : [];

  const rows = [];

  for (
    let transactionIndex = 0;
    transactionIndex <
    transactions.length;
    transactionIndex += 1
  ) {
    const transaction =
      transactions[transactionIndex] || {};

    const shares = roundShares(
      toFiniteNumber(
        transaction?.shares,
        0
      )
    );

    const price = roundMoney(
      toFiniteNumber(
        transaction?.price_per_share,
        0
      )
    );

    const rawValue =
      transaction?.transaction_value ??
      shares * price;

    const value = roundMoney(
      toFiniteNumber(
        rawValue,
        shares * price
      )
    );

    const tradeType = toTradeType(
      transaction?.transaction_type
    );

    const tradeTypeLabel =
      toTradeTypeLabel(
        transaction?.transaction_type
      );

    const transactionDate =
      normalizeDate(
        transaction?.transaction_date,
        filingDate
      );

    const transactionFootnotes =
      Array.isArray(
        transaction?.footnotes
      )
        ? transaction.footnotes
        : [];

    const transactionFootnoteText =
      transactionFootnotes
        .map((footnote) =>
          String(footnote ?? "")
        )
        .join(" ")
        .toLowerCase();

    const tenB51 =
      filingTenB51 ||
      transactionFootnoteText.includes(
        "10b5-1"
      ) ||
      transactionFootnoteText.includes(
        "10b5–1"
      );

    if (
      skipZeroRows &&
      shares === 0 &&
      value === 0
    ) {
      continue;
    }

    /*
     * This preserves zero-value awards with real shares.
     * Positive-value rows below the configured threshold
     * are treated as noise.
     */
    if (
      minimumTradeValue > 0 &&
      value > 0 &&
      value < minimumTradeValue
    ) {
      continue;
    }

    rows.push({
      id: createStableId([
        accessionNumber,
        ceoName,
        tradeType,
        transactionDate,
        transactionIndex,
      ]),

      accessionNumber,
      transactionIndex,

      ceo: ceoName,
      officerTitle,

      company,
      ticker,
      sector: "Unknown",

      tradeType,
      tradeTypeLabel,

      transactionDate,
      filedDate:
        filingDate || transactionDate,

      shares,
      price,
      value,

      pctHoldingsChange: 0,
      sharesOwnedAfter: 0,

      tenB51,

      perf: {
        sinceTrade: {
          changePct: 0,
        },
      },

      sourceUrl,

      ceoMatch: Boolean(
        owner?.ceo_match
      ),

      ceoMatchConfidence:
        owner?.ceo_match_confidence ??
        null,

      transactionCode:
        normalizeString(
          transaction?.transaction_type,
          ""
        ),
    });
  }

  return rows;
}

/*
 * ============================================================
 * GROUP TRANSACTION ROWS
 * ============================================================
 */

function buildTradeGroupKey(row) {
  return [
    row.accessionNumber,
    normalizeName(
      row.ceo
    ).toLowerCase(),
    row.tradeType,
    row.transactionDate,
  ].join("|");
}

function groupTransactionRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const groupKey =
      buildTradeGroupKey(row);

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: createStableId([
          row.accessionNumber,
          row.ceo,
          row.tradeType,
          row.transactionDate,
        ]),

        accessionNumber:
          row.accessionNumber,

        ceo: row.ceo,
        officerTitle:
          row.officerTitle,

        company: row.company,
        ticker: row.ticker,
        sector: row.sector,

        tradeType: row.tradeType,
        tradeTypeLabel:
          row.tradeTypeLabel,

        transactionDate:
          row.transactionDate,

        filedDate:
          row.filedDate,

        shares: 0,
        price: 0,
        value: 0,

        pctHoldingsChange: 0,
        sharesOwnedAfter: 0,

        tenB51: false,

        perf:
          row.perf || {
            sinceTrade: {
              changePct: 0,
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

    group.shares = roundShares(
      group.shares + row.shares
    );

    group.value = roundMoney(
      group.value + row.value
    );

    group.tenB51 =
      group.tenB51 || row.tenB51;

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
      shares: roundShares(
        row.shares
      ),

      price: roundMoney(
        row.price
      ),

      value: roundMoney(
        row.value
      ),

      transactionCode:
        row.transactionCode,
    });
  }

  const groupedTrades = [];

  for (const group of groups.values()) {
    if (
      group.shares !== 0 &&
      group.value !== 0
    ) {
      group.price = roundMoney(
        group.value / group.shares
      );
    } else {
      const pricedLines =
        group.lines.filter(
          (line) =>
            Number(line.price) > 0 &&
            Number(line.shares) > 0
        );

      const pricedShares =
        pricedLines.reduce(
          (sum, line) =>
            sum +
            toFiniteNumber(
              line.shares,
              0
            ),
          0
        );

      const weightedPriceTotal =
        pricedLines.reduce(
          (sum, line) =>
            sum +
            toFiniteNumber(
              line.price,
              0
            ) *
              toFiniteNumber(
                line.shares,
                0
              ),
          0
        );

      group.price =
        pricedShares > 0
          ? roundMoney(
              weightedPriceTotal /
                pricedShares
            )
          : 0;
    }

    group.lines.sort((a, b) => {
      if (b.price !== a.price) {
        return b.price - a.price;
      }

      return b.value - a.value;
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

function buildAiInput(trade) {
  return {
    accessionNumber:
      trade.accessionNumber,

    ceo: trade.ceo,
    officerTitle:
      trade.officerTitle,

    ceoMatch:
      trade.ceoMatch,

    ceoMatchConfidence:
      trade.ceoMatchConfidence,

    company: trade.company,
    ticker: trade.ticker,
    sector: trade.sector,

    tradeType:
      trade.tradeType,

    tradeTypeLabel:
      trade.tradeTypeLabel,

    transactionDate:
      trade.transactionDate,

    filedDate:
      trade.filedDate,

    shares: roundShares(
      trade.shares
    ),

    price: roundMoney(
      trade.price
    ),

    value: roundMoney(
      trade.value
    ),

    totalShares: roundShares(
      trade.shares
    ),

    averagePrice: roundMoney(
      trade.price
    ),

    totalValue: roundMoney(
      trade.value
    ),

    tenB51: Boolean(
      trade.tenB51
    ),

    lineCount: Array.isArray(
      trade.lines
    )
      ? trade.lines.length
      : 0,

    lines: Array.isArray(
      trade.lines
    )
      ? trade.lines.map(
          (line) => ({
            shares:
              roundShares(
                line.shares
              ),

            price:
              roundMoney(
                line.price
              ),

            value:
              roundMoney(
                line.value
              ),

            transactionCode:
              line.transactionCode ||
              "",
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
async function findExistingTrade(trade) {
  const rows = await sql`
    SELECT id
    FROM trades
    WHERE
      id = ${trade.id}
      OR (
        accession_number = ${trade.accessionNumber}
        AND ceo = ${trade.ceo}
        AND trade_type = ${trade.tradeType}
        AND transaction_date = ${trade.transactionDate}
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
  /*
   * JSON.stringify is used explicitly for JSONB fields so the
   * Neon driver receives valid JSON text.
   *
   * ON CONFLICT DO NOTHING protects against two importer runs
   * attempting to insert the same trade simultaneously.
   */
  const inserted = await sql`
    INSERT INTO trades (
      id,
      accession_number,
      ceo,
      officer_title,
      company,
      ticker,
      sector,
      trade_type,
      trade_type_label,
      transaction_date,
      filed_date,
      shares,
      average_price,
      total_value,
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
      ${trade.ceo},
      ${trade.officerTitle || null},
      ${trade.company},
      ${trade.ticker || null},
      ${trade.sector || "Unknown"},
      ${trade.tradeType},
      ${trade.tradeTypeLabel},
      ${trade.transactionDate},
      ${trade.filedDate || null},
      ${roundShares(trade.shares)},
      ${roundMoney(trade.price)},
      ${roundMoney(trade.value)},
      ${toFiniteNumber(
        trade.pctHoldingsChange,
        0
      )},
      ${roundShares(
        trade.sharesOwnedAfter || 0
      )},
      ${Boolean(trade.tenB51)},
      ${JSON.stringify(
        Array.isArray(trade.lines)
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
      ${Boolean(trade.ceoMatch)},
      ${
        trade.ceoMatchConfidence == null
          ? null
          : toFiniteNumber(
              trade.ceoMatchConfidence,
              0
            )
      },
      ${JSON.stringify(
        trade.perf || {
          sinceTrade: {
            changePct: 0,
          },
        }
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