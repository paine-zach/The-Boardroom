import {
  getTradeVoteState,
  setTradeVote,
} from "../lib/votes.js";

function readRequestBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error(
        "Request body must contain valid JSON."
      );
    }
  }

  return {};
}

function parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

  try {
    if (req.method === "GET") {
      const tradeId =
        req.query?.trade_id ??
        req.query?.tradeId;

      const voterId =
        req.query?.voter_id ??
        req.query?.voterId;

      const result = await getTradeVoteState({
        tradeId,
        voterId,
      });

      if (!result.tradeExists) {
        return res.status(404).json({
          error: "Trade not found.",
        });
      }

      return res.status(200).json(result);
    }

    if (req.method === "POST") {
      const body = readRequestBody(req);

      const tradeId =
        body.tradeId ??
        body.trade_id;

      const voterId =
        body.voterId ??
        body.voter_id;

      const voted = parseBoolean(body.voted);

      if (voted === null) {
        return res.status(400).json({
          error: "voted must be true or false.",
        });
      }

      const result = await setTradeVote({
        tradeId,
        voterId,
        voted,
      });

      if (!result.tradeExists) {
        return res.status(404).json({
          error: "Trade not found.",
        });
      }

      return res.status(200).json(result);
    }

    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      error: "Method not allowed.",
    });
  } catch (error) {
    console.error("Vote API error:", error);

    const message = String(
      error?.message || error
    );

    const validationError =
      message.includes("required") ||
      message.includes("invalid format") ||
      message.includes("too long") ||
      message.includes("between 8 and 128") ||
      message.includes("true or false") ||
      message.includes("valid JSON");

    return res
      .status(validationError ? 400 : 500)
      .json({
        error: validationError
          ? message
          : "Could not update the vote.",
      });
  }
}