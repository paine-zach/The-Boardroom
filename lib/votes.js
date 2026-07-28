import { sql } from "./db.js";

/*
 * ============================================================
 * THE BOARDROOM — PERSISTENT VOTE HELPERS
 * ============================================================
 *
 * Votes are identified by:
 *
 * trade_id + voter_id
 *
 * The database primary key prevents the same browser identifier
 * from voting more than once for the same trade.
 */

function normalizeTradeId(value) {
  const tradeId = String(value ?? "").trim();

  if (!tradeId) {
    throw new Error("tradeId is required.");
  }

  if (tradeId.length > 300) {
    throw new Error("tradeId is too long.");
  }

  /*
   * Current stable trade IDs contain lowercase letters,
   * numbers, and hyphens.
   */
  if (!/^[a-zA-Z0-9-]+$/.test(tradeId)) {
    throw new Error("tradeId has an invalid format.");
  }

  return tradeId;
}

function normalizeVoterId(value) {
  const voterId = String(value ?? "").trim();

  if (!voterId) {
    throw new Error("voterId is required.");
  }

  if (voterId.length < 8 || voterId.length > 128) {
    throw new Error(
      "voterId must be between 8 and 128 characters."
    );
  }

  /*
   * Supports UUIDs and similar anonymous browser identifiers.
   */
  if (!/^[a-zA-Z0-9_-]+$/.test(voterId)) {
    throw new Error("voterId has an invalid format.");
  }

  return voterId;
}

/*
 * Get the authoritative database state for one voter and trade.
 */
export async function getTradeVoteState({
  tradeId: rawTradeId,
  voterId: rawVoterId,
}) {
  const tradeId = normalizeTradeId(rawTradeId);
  const voterId = normalizeVoterId(rawVoterId);

  const rows = await sql`
    SELECT
      EXISTS (
        SELECT 1
        FROM trades
        WHERE id = ${tradeId}
      ) AS trade_exists,

      EXISTS (
        SELECT 1
        FROM trade_votes
        WHERE
          trade_id = ${tradeId}
          AND voter_id = ${voterId}
      ) AS voted,

      (
        SELECT COUNT(*)::integer
        FROM trade_votes
        WHERE trade_id = ${tradeId}
      ) AS upvotes
  `;

  const row = rows[0] || {};

  return {
    tradeExists: Boolean(
      row.trade_exists
    ),

    tradeId,

    voted: Boolean(
      row.voted
    ),

    upvotes: Number(
      row.upvotes || 0
    ),
  };
}

/*
 * Set the desired vote state rather than blindly toggling it.
 *
 * This makes requests idempotent:
 *
 * voted: true  → ensure the vote exists
 * voted: false → ensure the vote does not exist
 *
 * Repeated network requests therefore do not accidentally reverse
 * the user's vote.
 */
export async function setTradeVote({
  tradeId: rawTradeId,
  voterId: rawVoterId,
  voted,
}) {
  const tradeId = normalizeTradeId(rawTradeId);
  const voterId = normalizeVoterId(rawVoterId);

  if (typeof voted !== "boolean") {
    throw new Error(
      "voted must be true or false."
    );
  }

  const tradeRows = await sql`
    SELECT id
    FROM trades
    WHERE id = ${tradeId}
    LIMIT 1
  `;

  if (!tradeRows.length) {
    return {
      tradeExists: false,
      tradeId,
      voted: false,
      upvotes: 0,
    };
  }

  if (voted) {
    await sql`
      INSERT INTO trade_votes (
        trade_id,
        voter_id
      )
      VALUES (
        ${tradeId},
        ${voterId}
      )
      ON CONFLICT (
        trade_id,
        voter_id
      )
      DO NOTHING
    `;
  } else {
    await sql`
      DELETE FROM trade_votes
      WHERE
        trade_id = ${tradeId}
        AND voter_id = ${voterId}
    `;
  }

  /*
   * Read the authoritative state after the write rather than
   * assuming the requested operation succeeded.
   */
  return getTradeVoteState({
    tradeId,
    voterId,
  });
}