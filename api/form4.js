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

function mapTradeRow(row) {
  return {
    id: row.id,
    accessionNumber: row.accession_number,

    ceo: row.ceo,
    officerTitle: row.officer_title || "",

    company: row.company,
    ticker: row.ticker || "N/A",
    sector: row.sector || "Unknown",

    tradeType: row.trade_type,
    tradeTypeLabel: row.trade_type_label,

    transactionDate: formatDatabaseDate(row.transaction_date),
    filedDate: formatDatabaseDate(row.filed_date),

    shares: Number(row.shares || 0),
    price: Number(row.average_price || 0),
    value: Number(row.total_value || 0),

    pctHoldingsChange: Number(
      row.pct_holdings_change || 0
    ),

    sharesOwnedAfter: Number(
      row.shares_owned_after || 0
    ),

    tenB51: Boolean(row.ten_b5_1),

    lines: Array.isArray(row.lines)
      ? row.lines
      : [],

    title: row.title || "Form 4 transaction",
    summary: row.summary || "No summary available.",

    tags: Array.isArray(row.tags)
      ? row.tags
      : [],

    sourceUrl: row.source_url || "#",

    ceoMatch: Boolean(row.ceo_match),

    ceoMatchConfidence:
      row.ceo_match_confidence == null
        ? null
        : Number(row.ceo_match_confidence),

    perf:
      row.perf && typeof row.perf === "object"
        ? row.perf
        : {
            sinceTrade: {
              changePct: 0,
            },
          },

    upvotes: Number(row.upvotes || 0),

    voted: Boolean(row.voted),

    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
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
    const tradeType = String(q.trade_type || "").trim();
    const search = String(q.search || "").trim().toLowerCase();
    const searchPattern = `%${search}%`;
    const voterId = String(
  q.voter_id ??
  q.voterId ??
  ""
).trim();

if (
  voterId &&
  !/^[a-zA-Z0-9_-]{8,128}$/.test(voterId)
) {
  return res.status(400).json({
    error: "Invalid voter ID.",
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
            ${search} = ''
            OR LOWER(t.company) LIKE ${searchPattern}
            OR LOWER(t.ceo) LIKE ${searchPattern}
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
            ${search} = ''
            OR LOWER(t.company) LIKE ${searchPattern}
            OR LOWER(t.ceo) LIKE ${searchPattern}
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
            ${search} = ''
            OR LOWER(t.company) LIKE ${searchPattern}
            OR LOWER(t.ceo) LIKE ${searchPattern}
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
          ${search} = ''
          OR LOWER(t.company) LIKE ${searchPattern}
          OR LOWER(t.ceo) LIKE ${searchPattern}
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