import {
  importForm4Trades,
} from "../lib/importer.js";

/*
 * ============================================================
 * PROTECTED FORM 4 IMPORT ENDPOINT
 * ============================================================
 *
 * Vercel Cron sends:
 *
 * Authorization: Bearer <CRON_SECRET>
 *
 * Manual requests must provide the same header.
 */

function queryValue(
  req,
  key,
  fallback = undefined
) {
  if (
    req.body &&
    typeof req.body === "object" &&
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

  if (
    value === true ||
    value === false
  ) {
    return value;
  }

  return (
    String(value).toLowerCase() !==
    "false"
  );
}

function isAuthorized(req) {
  const cronSecret =
    process.env.CRON_SECRET;

  if (!cronSecret) {
    throw new Error(
      "Missing CRON_SECRET environment variable."
    );
  }

  const authorization =
    req.headers?.authorization || "";

  return (
    authorization ===
    `Bearer ${cronSecret}`
  );
}

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Cache-Control",
    "no-store, max-age=0"
  );

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
        success: false,
        error: "Method not allowed.",
      });
    }

    if (!isAuthorized(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized.",
      });
    }

    const result =
      await importForm4Trades({
        role: queryValue(
          req,
          "role",
          "ceo"
        ),

        limit: queryValue(
          req,
          "limit",
          10
        ),

        offset: queryValue(
          req,
          "offset",
          0
        ),

        maxPages: queryValue(
          req,
          "max_pages",
          3
        ),

        maxAiSummaries: queryValue(
          req,
          "max_ai",
          12
        ),

        minimumTradeValue: queryValue(
          req,
          "min_value",
          1000
        ),

        skipZeroRows: toBoolean(
          queryValue(
            req,
            "skip_zero_rows",
            true
          ),
          true
        ),

        startDate: queryValue(
          req,
          "start_date"
        ),

        endDate: queryValue(
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

    const missingSecret =
      String(
        error?.message || ""
      ).includes("CRON_SECRET");

    return res
      .status(
        missingSecret ? 500 : 500
      )
      .json({
        success: false,
        error: missingSecret
          ? "Importer authentication is not configured."
          : "Form 4 import failed.",
      });
  }
}