import {
  importForm4Trades,
} from "../lib/importer.js";

/*
 * ============================================================
 * MANUAL FORM 4 IMPORT ENDPOINT
 * ============================================================
 *
 * This endpoint is separate from the public feed endpoint.
 *
 * It currently accepts GET or POST so it is easy to test
 * manually in a browser. We will secure it before connecting
 * it to a scheduled Vercel Cron Job.
 */

function queryValue(
  req,
  key,
  fallback = undefined
) {
  if (
    req.body &&
    req.body[key] !== undefined
  ) {
    return req.body[key];
  }

  if (
    req.query &&
    req.query[key] !== undefined
  ) {
    return req.query[key];
  }

  return fallback;
}

function toBoolean(
  value,
  fallback = true
) {
  if (value === undefined) {
    return fallback;
  }

  return (
    String(value).toLowerCase() !==
    "false"
  );
}

export default async function handler(
  req,
  res
) {
  try {
    if (
      req.method !== "GET" &&
      req.method !== "POST"
    ) {
      res.setHeader(
        "Allow",
        "GET, POST"
      );

      return res.status(405).json({
        error:
          "Method not allowed",
      });
    }

    const result =
      await importForm4Trades({
        role:
          queryValue(
            req,
            "role",
            "ceo"
          ),

        limit:
          queryValue(
            req,
            "limit",
            10
          ),

        offset:
          queryValue(
            req,
            "offset",
            0
          ),

        maxPages:
          queryValue(
            req,
            "max_pages",
            3
          ),

        maxAiSummaries:
          queryValue(
            req,
            "max_ai",
            12
          ),

        minimumTradeValue:
          queryValue(
            req,
            "min_value",
            1000
          ),

        skipZeroRows:
          toBoolean(
            queryValue(
              req,
              "skip_zero_rows",
              true
            ),
            true
          ),

        startDate:
          queryValue(
            req,
            "start_date"
          ),

        endDate:
          queryValue(
            req,
            "end_date"
          ),
      });

    return res.status(200).json(
      result
    );
  } catch (error) {
    console.error(
      "Form 4 import failed:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        "Form 4 import failed.",

      detail:
        process.env.NODE_ENV ===
        "production"
          ? undefined
          : String(
              error?.message ||
                error
            ),
    });
  }
}