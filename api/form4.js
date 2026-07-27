export default async function handler(req, res) {
  try {
    /*
     * ============================================================
     * 1. ENVIRONMENT AND REQUEST CONFIGURATION
     * ============================================================
     */

    const hermaiKey = process.env.HERMAI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    if (!hermaiKey) {
      return res.status(500).json({
        error: "Missing HERMAI_API_KEY",
      });
    }

    const q = req.query || {};

    const role =
      String(q.role || "ceo").toLowerCase() === "all"
        ? "all"
        : "ceo";

    const limit = clampInteger(q.limit, 10, 1, 25);
    const initialOffset = clampInteger(q.offset, 0, 0, 100000);

    /*
     * Pagination and AI controls.
     *
     * max_pages:
     * Maximum number of HermAI result pages to request.
     *
     * max_ai:
     * Maximum number of grouped cards that receive an OpenAI summary.
     * Remaining cards use the deterministic fallback summary.
     *
     * min_trades:
     * Desired number of grouped feed cards before pagination stops.
     *
     * min_value:
     * Filters out small/noise transaction rows. Defaults to $1,000.
     * Set ?min_value=0 to disable the micro-trade filter.
     */

    const MAX_PAGES = clampInteger(q.max_pages, 3, 1, 8);
    const MAX_AI_SUMMARIES = clampInteger(q.max_ai, 12, 0, 30);
    const MIN_TRADES_TARGET = clampInteger(q.min_trades, 10, 1, 100);
    const MIN_TRADE_VALUE = clampNumber(q.min_value, 1000, 0, 1_000_000_000);

    const SKIP_ZERO_ROWS =
      String(q.skip_zero_rows ?? "true").toLowerCase() !== "false";

    /*
     * ============================================================
     * 2. GENERAL-PURPOSE HELPERS
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
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    /*
     * Round monetary and share values before they are stored or returned.
     * Number.EPSILON helps avoid common binary floating-point artifacts.
     */
    function roundTo(value, decimalPlaces = 2) {
      const number = toFiniteNumber(value, 0);
      const factor = 10 ** decimalPlaces;

      return Math.round((number + Number.EPSILON) * factor) / factor;
    }

    function roundMoney(value) {
      return roundTo(value, 2);
    }

    function roundShares(value) {
      /*
       * Form 4 filings can contain fractional shares.
       * Six decimal places preserves legitimate fractional transactions
       * while removing excessive floating-point noise.
       */
      return roundTo(value, 6);
    }

    function normalizeString(value, fallback = "") {
      const output = String(value ?? "").trim();
      return output || fallback;
    }

    function normalizeName(value, fallback = "Unknown CEO") {
      return normalizeString(value, fallback)
        .replace(/\s+/g, " ")
        .trim();
    }

    function normalizeDate(value, fallback = null) {
      if (!value) {
        return fallback;
      }

      const raw = String(value).trim();

      /*
       * HermAI normally returns YYYY-MM-DD. Preserve that form so the
       * existing frontend date utilities continue to work.
       */
      const directMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);

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
      const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(date.getUTCDate()).padStart(2, "0");

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
     * 3. DATE WINDOW
     * ============================================================
     */

    const now = new Date();

    const end = q.end_date
      ? new Date(String(q.end_date))
      : now;

    const start = q.start_date
      ? new Date(String(q.start_date))
      : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return res.status(400).json({
        error: "Invalid date. Use YYYY-MM-DD for start_date and end_date.",
      });
    }

    const start_date = formatDateForQuery(start);
    const end_date = formatDateForQuery(end);

    const dayMs = 24 * 60 * 60 * 1000;

    /*
     * Use UTC timestamps for the date-window calculation so daylight-saving
     * transitions do not accidentally add or remove a day.
     */
    const startUtc = Date.parse(`${start_date}T00:00:00Z`);
    const endUtc = Date.parse(`${end_date}T00:00:00Z`);
    const windowDays = Math.floor((endUtc - startUtc) / dayMs) + 1;

    if (windowDays < 1 || windowDays > 31) {
      return res.status(400).json({
        error:
          "Invalid date window. start_date/end_date must be 1-31 days apart.",
      });
    }

    /*
     * ============================================================
     * 4. HERMAI REQUEST
     * ============================================================
     */

    async function fetchHermPage(offset) {
      const response = await fetch("https://api.hermai.ai/v1/fetch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hermaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          site: "data.sec.gov",
          endpoint: "list_form4_transactions",
          params: {
            start_date,
            end_date,
            role,
            include_amendments: false,
            offset,
            limit,
          },
        }),
      });

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
     * 5. TRANSACTION-TYPE NORMALIZATION
     * ============================================================
     */

    function toTradeTypeLabel(value) {
      const normalized = normalizeString(value).toLowerCase();

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
      const normalized = normalizeString(value).toLowerCase();

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
       * Preserve the frontend's existing category contract.
       * Unknown transaction codes currently fall back to "sell".
       */
      return "sell";
    }

    /*
     * ============================================================
     * 6. FALLBACK CONTENT
     * ============================================================
     */

    function formatCompactMoney(value) {
      const amount = roundMoney(value);
      const absoluteAmount = Math.abs(amount);
      const sign = amount < 0 ? "-" : "";

      if (absoluteAmount >= 1_000_000_000) {
        return `${sign}$${(absoluteAmount / 1_000_000_000).toFixed(1)}B`;
      }

      if (absoluteAmount >= 1_000_000) {
        return `${sign}$${(absoluteAmount / 1_000_000).toFixed(1)}M`;
      }

      if (absoluteAmount >= 1_000) {
        return `${sign}$${Math.round(absoluteAmount / 1_000)}K`;
      }

      return `${sign}$${absoluteAmount.toFixed(2)}`;
    }

    function fallbackTitle(trade) {
      const shares = roundShares(trade.shares || 0).toLocaleString("en-US", {
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
      const shares = roundShares(trade.shares || 0).toLocaleString("en-US", {
        maximumFractionDigits: 6,
      });

      const value = formatCompactMoney(trade.value || 0);
      const rowCount = Array.isArray(trade.lines)
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

      const sectorTag = normalizeString(trade.sector, "unknown")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      if (sectorTag) {
        tags.push(sectorTag);
      }

      if (trade.tenB51) {
        tags.push("10b5-1");
      }

      if (Array.isArray(trade.lines) && trade.lines.length > 1) {
        tags.push("multi-line-filing");
      }

      return [...new Set(tags)].slice(0, 4);
    }

        /*
     * ============================================================
     * 7. OPENAI SUMMARY GENERATION
     * ============================================================
     */

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

    async function generateAiSummary(input) {
      const fallback = {
        title: fallbackTitle(input),
        summary: fallbackSummary(input),
        tags: fallbackTags(input),
      };

      if (!openaiKey) {
        return fallback;
      }

      /*
       * The AI receives an already-grouped transaction.
       * This means it summarizes the complete filing group rather than
       * producing a separate summary for every transaction line.
       */
      const prompt = `
Return ONLY one strict JSON object with these keys:

{
  "title": "string",
  "summary": "string",
  "tags": ["string"]
}

Rules:
- Use only the facts provided in the input.
- Be neutral, factual, concise, and easy for a general reader to understand.
- Do not provide financial, legal, or investment advice.
- Do not suggest that a sale is bearish or that a purchase guarantees confidence.
- Do not infer motives that are not explicitly provided.
- Clearly distinguish open-market trades from awards and option exercises.
- Mention a 10b5-1 plan only when tenB51 is true.
- Treat all transaction lines as parts of one grouped filing event.
- Use the aggregated totals, not the value of one individual line.
- title: one concise sentence, preferably 8-18 words.
- summary: one or two concise sentences.
- tags: two to four lowercase kebab-case tags.
- Do not include markdown.
- Do not include text outside the JSON object.

Input:
${JSON.stringify(input)}
`;

      /*
       * Prevent an unusually slow OpenAI request from holding the entire
       * Vercel function open indefinitely.
       */
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);

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
          result?.choices?.[0]?.message?.content || "{}";

        let parsed;

        try {
          parsed = JSON.parse(content);
        } catch (error) {
          console.error("Could not parse OpenAI JSON response:", error);
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

        const tags = sanitizeTags(
          parsed?.tags,
          fallback.tags
        );

        return {
          title,
          summary,
          tags,
        };
      } catch (error) {
        /*
         * A summary failure should never prevent real SEC filing data from
         * appearing. The deterministic fallback content is used instead.
         */
        if (error?.name === "AbortError") {
          console.error("OpenAI summary request timed out.");
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
     * 8. FILING → NORMALIZED TRANSACTION ROWS
     * ============================================================
     */

    function filingToTransactionRows(filing) {
      const issuer = filing?.issuer || {};

      const owners = Array.isArray(filing?.reporting_owners)
        ? filing.reporting_owners
        : [];

      /*
       * Prefer the reporting owner that HermAI identified as the CEO.
       * Fall back to the first reporting owner if no CEO match exists.
       */
      const owner =
        owners.find((candidate) => candidate?.ceo_match) ||
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
        normalizeString(filing?.source_document_url) ||
        "#";

      const filingDate = normalizeDate(
        filing?.filed_date,
        null
      );

      /*
       * A 10b5-1 reference can appear in filing-level footnotes.
       */
      const filingFootnotes = Array.isArray(filing?.footnotes)
        ? filing.footnotes
        : [];

      const filingFootnoteText = filingFootnotes
        .map((footnote) => String(footnote ?? ""))
        .join(" ")
        .toLowerCase();

      const filingTenB51 =
        filingFootnoteText.includes("10b5-1") ||
        filingFootnoteText.includes("10b5–1");

      const transactions = Array.isArray(filing?.transactions)
        ? filing.transactions
        : [];

      const rows = [];

      for (
        let transactionIndex = 0;
        transactionIndex < transactions.length;
        transactionIndex += 1
      ) {
        const transaction =
          transactions[transactionIndex] || {};

        const shares = roundShares(
          toFiniteNumber(transaction?.shares, 0)
        );

        const reportedPrice = roundMoney(
          toFiniteNumber(
            transaction?.price_per_share,
            0
          )
        );

        /*
         * Prefer transaction_value when HermAI provides it.
         * If it is absent, calculate shares × price.
         *
         * Nullish coalescing is used instead of || so an explicitly
         * reported value of zero remains zero.
         */
        const rawValue =
          transaction?.transaction_value ??
          shares * reportedPrice;

        const value = roundMoney(
          toFiniteNumber(rawValue, shares * reportedPrice)
        );

        const tradeType = toTradeType(
          transaction?.transaction_type
        );

        const tradeTypeLabel = toTradeTypeLabel(
          transaction?.transaction_type
        );

        const transactionDate = normalizeDate(
          transaction?.transaction_date,
          filingDate
        );

        /*
         * Some providers may expose transaction-specific footnotes.
         * Combine them with filing-level footnotes when identifying a plan.
         */
        const transactionFootnotes = Array.isArray(
          transaction?.footnotes
        )
          ? transaction.footnotes
          : [];

        const transactionFootnoteText = transactionFootnotes
          .map((footnote) => String(footnote ?? ""))
          .join(" ")
          .toLowerCase();

        const tenB51 =
          filingTenB51 ||
          transactionFootnoteText.includes("10b5-1") ||
          transactionFootnoteText.includes("10b5–1");

        /*
         * Remove truly empty transaction rows.
         *
         * A compensation award may legitimately have shares but no reported
         * transaction value, so it is not removed merely because value is 0.
         */
        if (
          SKIP_ZERO_ROWS &&
          shares === 0 &&
          value === 0
        ) {
          continue;
        }

        /*
         * Remove positive-value micro transactions below the configured
         * threshold. Zero-value awards and similar compensation events are
         * preserved because Form 4 filings may not report a cash value for
         * those events.
         *
         * Use ?min_value=0 to disable this filter.
         */
        if (
          MIN_TRADE_VALUE > 0 &&
          value > 0 &&
          value < MIN_TRADE_VALUE
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
          company,
          ticker,
          sector: "Unknown",

          tradeType,
          tradeTypeLabel,

          transactionDate,
          filedDate: filingDate || transactionDate,

          shares,
          price: reportedPrice,
          value,

          pctHoldingsChange: 0,
          tenB51,

          perf: {
            sinceTrade: {
              changePct: 0,
            },
          },

          upvotes: 0,
          sharesOwnedAfter: 0,

          sourceUrl,

          officerTitle,
          ceoMatch: Boolean(owner?.ceo_match),
          ceoMatchConfidence:
            owner?.ceo_match_confidence ?? null,

          /*
           * Preserve the original SEC transaction code where possible.
           * It is useful for debugging and future UI improvements.
           */
          transactionCode: normalizeString(
            transaction?.transaction_type,
            ""
          ),
        });
      }

      return rows;
    }

    /*
     * ============================================================
     * 9. GROUP AND AGGREGATE TRANSACTION ROWS
     * ============================================================
     */

    function buildTradeGroupKey(row) {
      /*
       * Required grouping dimensions:
       *
       * accessionNumber + CEO + tradeType + transactionDate
       *
       * Lowercasing the CEO name prevents harmless capitalization
       * differences from creating duplicate cards.
       */
      return [
        row.accessionNumber,
        normalizeName(row.ceo).toLowerCase(),
        row.tradeType,
        row.transactionDate,
      ].join("|");
    }

    function groupTransactionRows(rows) {
      const groups = new Map();

      for (const row of rows) {
        const groupKey = buildTradeGroupKey(row);

        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            id: createStableId([
              row.accessionNumber,
              row.ceo,
              row.tradeType,
              row.transactionDate,
            ]),

            accessionNumber: row.accessionNumber,

            ceo: row.ceo,
            company: row.company,
            ticker: row.ticker,
            sector: row.sector,

            tradeType: row.tradeType,
            tradeTypeLabel: row.tradeTypeLabel,

            transactionDate: row.transactionDate,
            filedDate: row.filedDate,

            shares: 0,
            price: 0,
            value: 0,

            pctHoldingsChange: 0,
            tenB51: false,

            perf: row.perf || {
              sinceTrade: {
                changePct: 0,
              },
            },

            upvotes: 0,
            sharesOwnedAfter: 0,

            lines: [],

            title: "",
            summary: "",
            tags: [],

            sourceUrl: row.sourceUrl,

            officerTitle: row.officerTitle,
            ceoMatch: row.ceoMatch,
            ceoMatchConfidence:
              row.ceoMatchConfidence ?? null,
          });
        }

        const group = groups.get(groupKey);

        group.shares = roundShares(
          group.shares + row.shares
        );

        group.value = roundMoney(
          group.value + row.value
        );

        group.tenB51 = group.tenB51 || row.tenB51;

        /*
         * Keep the most recent filing date if inconsistent source records
         * somehow exist within the same group.
         */
        if (
          row.filedDate &&
          (!group.filedDate ||
            new Date(row.filedDate) >
              new Date(group.filedDate))
        ) {
          group.filedDate = row.filedDate;
        }

        /*
         * Preserve every underlying transaction line for the filing modal.
         * The existing frontend already expects shares, price, and value.
         */
        group.lines.push({
          shares: roundShares(row.shares),
          price: roundMoney(row.price),
          value: roundMoney(row.value),
          transactionCode: row.transactionCode,
        });
      }

      const groupedTrades = [];

      for (const group of groups.values()) {
        /*
         * Use a value-weighted aggregate price when possible:
         *
         * total value ÷ total shares
         *
         * If no value was reported, use the weighted share-based average of
         * non-zero line prices. If neither is available, return 0.
         */
        if (
          group.shares !== 0 &&
          group.value !== 0
        ) {
          group.price = roundMoney(
            group.value / group.shares
          );
        } else {
          const pricedLines = group.lines.filter(
            (line) =>
              Number(line.price) > 0 &&
              Number(line.shares) > 0
          );

          const pricedShares = pricedLines.reduce(
            (sum, line) =>
              sum + toFiniteNumber(line.shares, 0),
            0
          );

          const weightedPriceTotal = pricedLines.reduce(
            (sum, line) =>
              sum +
              toFiniteNumber(line.price, 0) *
                toFiniteNumber(line.shares, 0),
            0
          );

          group.price =
            pricedShares > 0
              ? roundMoney(
                  weightedPriceTotal / pricedShares
                )
              : 0;
        }

        /*
         * Sort modal lines consistently by price and then value.
         * This does not affect the aggregate totals.
         */
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
     * Converts a grouped trade into the factual input sent to OpenAI.
     * Limiting the input to relevant fields reduces tokens and prevents
     * unrelated response metadata from influencing the summary.
     */
    function buildAiInput(trade) {
      return {
        accessionNumber: trade.accessionNumber,

        ceo: trade.ceo,
        officerTitle: trade.officerTitle,
        ceoMatch: trade.ceoMatch,
        ceoMatchConfidence:
          trade.ceoMatchConfidence,

        company: trade.company,
        ticker: trade.ticker,
        sector: trade.sector,

        tradeType: trade.tradeType,
        tradeTypeLabel: trade.tradeTypeLabel,

        transactionDate: trade.transactionDate,
        filedDate: trade.filedDate,

       /*
         * Keep both the frontend-style field names and the clearer
         * AI-facing aggregate names. The aliases ensure fallbackTitle(),
         * fallbackSummary(), and fallbackTags() work when OpenAI is
         * disabled, times out, or returns invalid output.
         */
        shares: roundShares(trade.shares),
        price: roundMoney(trade.price),
        value: roundMoney(trade.value),

        totalShares: roundShares(trade.shares),
        averagePrice: roundMoney(trade.price),
        totalValue: roundMoney(trade.value),

        tenB51: Boolean(trade.tenB51),
        
        lineCount: Array.isArray(trade.lines)
          ? trade.lines.length
          : 0,

        lines: Array.isArray(trade.lines)
          ? trade.lines.map((line) => ({
              shares: roundShares(line.shares),
              price: roundMoney(line.price),
              value: roundMoney(line.value),
              transactionCode:
                line.transactionCode || "",
            }))
          : [],
      };
    }

        /*
     * ============================================================
     * 10. FETCH, NORMALIZE, FILTER, AND GROUP
     * ============================================================
     */

    const allFilings = [];

    let pageCount = 0;
    let currentOffset = initialOffset;
    let hasMore = true;

    let lastMeta = null;
    let lastPagination = null;

    /*
     * Track the number of grouped cards, not raw transaction rows.
     * This avoids stopping pagination early merely because one filing
     * contains many lines.
     */
    let groupedTradeCount = 0;

    while (
      hasMore &&
      pageCount < MAX_PAGES
    ) {
      const page = await fetchHermPage(currentOffset);

      lastMeta = page?.meta || null;

      const filings = Array.isArray(
        page?.data?.filings
      )
        ? page.data.filings
        : [];

      const pagination =
        page?.data?.pagination || {};

      lastPagination = pagination;

      allFilings.push(...filings);

      /*
       * Rebuild the normalized grouped set after each page so the
       * stopping condition reflects actual feed cards.
       *
       * The result sets are intentionally small:
       * max 8 pages × 25 filings per page.
       */
      const rowsSoFar = [];

      for (const filing of allFilings) {
        rowsSoFar.push(
          ...filingToTransactionRows(filing)
        );
      }

      groupedTradeCount =
        groupTransactionRows(rowsSoFar).length;

      hasMore = Boolean(
        pagination?.has_more
      );

      currentOffset =
        typeof pagination?.next_offset === "number"
          ? pagination.next_offset
          : currentOffset + limit;

      pageCount += 1;

      /*
       * Stop once enough grouped feed cards have been collected.
       */
      if (
        groupedTradeCount >=
        MIN_TRADES_TARGET
      ) {
        break;
      }

      if (!hasMore) {
        break;
      }
    }

    /*
     * ============================================================
     * 11. FINAL NORMALIZATION AND GROUPING
     * ============================================================
     */

    const normalizedRows = [];

    for (const filing of allFilings) {
      normalizedRows.push(
        ...filingToTransactionRows(filing)
      );
    }

    /*
     * Pipeline order:
     *
     * HermAI filings
     *   → normalized transaction rows
     *   → zero/noise filtering
     *   → grouping
     *   → aggregate totals
     *   → AI summary
     *   → sorting
     *   → JSON response
     */
    const groupedTrades =
      groupTransactionRows(normalizedRows);

    /*
     * Sort before assigning the limited number of AI summaries.
     * This ensures the newest grouped trades receive AI treatment first.
     */
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
     * 12. GENERATE ONE SUMMARY PER GROUPED TRADE
     * ============================================================
     */

    const trades = await Promise.all(
      groupedTrades.map(
        async (trade, index) => {
          if (
            index >= MAX_AI_SUMMARIES
          ) {
            return {
              ...trade,
              title:
                fallbackTitle(trade),
              summary:
                fallbackSummary(trade),
              tags:
                fallbackTags(trade),
            };
          }

          const ai =
            await generateAiSummary(
              buildAiInput(trade)
            );

          return {
            ...trade,
            title: ai.title,
            summary: ai.summary,
            tags: ai.tags,
          };
        }
      )
    );

    /*
     * Re-sort after asynchronous summary generation.
     * Promise.all preserves order, but an explicit final sort makes
     * the response contract clear and robust to future refactoring.
     */
    trades.sort(
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
     * 13. RESPONSE
     * ============================================================
     */

    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=600"
    );

    return res.status(200).json({
      trades,

      /*
       * Count now represents grouped cards rather than transaction rows.
       */
      count: trades.length,

      fetchedAt:
        new Date().toISOString(),

      aiEnabled:
        Boolean(openaiKey),

      modelUsed:
        openaiKey ? model : null,

      /*
       * Debugging and feed-cleanliness metadata.
       * These additional fields should not affect the frontend.
       */
      processing: {
        filingsFetched:
          allFilings.length,

        normalizedRows:
          normalizedRows.length,

        groupedTrades:
          groupedTrades.length,

        rowsRemoved:
          Math.max(
            0,
            allFilings.reduce(
              (sum, filing) =>
                sum +
                (
                  Array.isArray(
                    filing?.transactions
                  )
                    ? filing.transactions
                        .length
                    : 0
                ),
              0
            ) -
              normalizedRows.length
          ),

        minimumTradeValue:
          MIN_TRADE_VALUE,

        groupingKey: [
          "accessionNumber",
          "ceo",
          "tradeType",
          "transactionDate",
        ],
      },

      hermai: {
        credits_used:
          lastMeta?.credits_used ??
          null,

        credits_remaining:
          lastMeta
            ?.credits_remaining ??
          null,

        cached:
          lastMeta?.cached ??
          null,

        pagination:
          lastPagination,

        pages_fetched:
          pageCount,
      },

      query: {
        start_date,
        end_date,
        role,
        limit,

        initial_offset:
          initialOffset,

        max_pages:
          MAX_PAGES,

        max_ai:
          MAX_AI_SUMMARIES,

        min_trades:
          MIN_TRADES_TARGET,

        min_value:
          MIN_TRADE_VALUE,

        skip_zero_rows:
          SKIP_ZERO_ROWS,
      },
    });
  } catch (error) {
    /*
     * Avoid exposing secrets or full upstream responses in production.
     * The detailed error remains visible in the Vercel function logs.
     */
    console.error("Form 4 API error:", error);

    const isProduction =
      process.env.NODE_ENV === "production";

    return res.status(500).json({
      error: "Server error",

      /*
       * Detailed messages are useful during local development but may
       * contain upstream API response information, so production clients
       * receive a generic message.
       */
      detail: isProduction
        ? "The Form 4 feed could not be generated."
        : String(
            error?.message ||
              error ||
              "Unknown error"
          ),
    });
  }
}
