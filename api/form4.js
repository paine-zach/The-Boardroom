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