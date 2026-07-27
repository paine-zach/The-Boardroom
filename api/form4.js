export default async function handler(req, res) {
  try {
    const hermaiKey = process.env.HERMAI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    if (!hermaiKey) {
      return res.status(500).json({ error: "Missing HERMAI_API_KEY" });
    }

    const q = req.query || {};
    const role = (q.role || "ceo").toString().toLowerCase() === "all" ? "all" : "ceo";
    const limit = Math.max(1, Math.min(25, Number(q.limit || 10)));
    const initialOffset = Math.max(0, Number(q.offset || 0));

    // Controls
    const MAX_PAGES = Math.max(1, Math.min(8, Number(q.max_pages || 3)));
    const MAX_AI_SUMMARIES = Math.max(1, Math.min(30, Number(q.max_ai || 12)));
    const MIN_TRADES_TARGET = Math.max(1, Math.min(100, Number(q.min_trades || 10))); // small patch
    const SKIP_ZERO_ROWS = String(q.skip_zero_rows ?? "true") !== "false";

    const now = new Date();
    const end = q.end_date ? new Date(String(q.end_date)) : now;
    const start = q.start_date
      ? new Date(String(q.start_date))
      : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);

    const fmt = (d) => {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const start_date = fmt(start);
    const end_date = fmt(end);

    const dayMs = 24 * 60 * 60 * 1000;
    const windowDays = Math.floor((new Date(end_date) - new Date(start_date)) / dayMs) + 1;
    if (windowDays < 1 || windowDays > 31) {
      return res.status(400).json({
        error: "Invalid date window. start_date/end_date must be 1-31 days apart.",
      });
    }

    async function fetchHermPage(offset) {
      const r = await fetch("https://api.hermai.ai/v1/fetch", {
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

      if (!r.ok) {
        const detail = await r.text();
        throw new Error(`HermAI request failed (${r.status}): ${detail}`);
      }
      return r.json();
    }

    // ---- label mapping fix (SEC code + text) ----
    function toTradeTypeLabel(t) {
      const s = String(t || "").toLowerCase().trim();
      if (s === "p" || s.includes("purchase") || s.includes("buy")) return "Open Market Buy";
      if (s === "s" || s.includes("sale") || s.includes("sell")) return "Open Market Sell";
      if (s === "m" || s.includes("option")) return "Option Exercise";
      if (s === "a" || s.includes("award") || s.includes("grant")) return "Award / Grant";
      return "Insider Transaction";
    }

    function toTradeType(t) {
      const s = String(t || "").toLowerCase().trim();
      if (s === "p" || s.includes("purchase") || s.includes("buy")) return "buy";
      if (s === "s" || s.includes("sale") || s.includes("sell")) return "sell";
      if (s === "m" || s.includes("option")) return "option";
      if (s === "a" || s.includes("award") || s.includes("grant")) return "award";
      return "sell";
    }

    function fallbackSummary(t) {
      const shares = Number(t.shares || 0).toLocaleString();
      const value = Number(t.value || 0);
      const v =
        value >= 1_000_000
          ? `$${(value / 1_000_000).toFixed(1)}M`
          : value >= 1_000
          ? `$${Math.round(value / 1_000)}K`
          : `$${value}`;
      return `${t.ceo} reported a ${String(t.tradeTypeLabel).toLowerCase()} involving ${shares} shares (about ${v}) for ${t.company} (${t.ticker}).`;
    }

    function fallbackTags(t) {
      const out = [];
      out.push(t.tradeType === "buy" ? "open-market-buy" : "open-market-sell");
      out.push((t.sector || "unknown").toLowerCase().replace(/\s+/g, "-"));
      if (t.tenB51) out.push("10b5-1");
      return [...new Set(out)].slice(0, 4);
    }

    async function generateAiSummary(input) {
      if (!openaiKey) {
        return {
          title: `${input.ceo} — ${input.tradeTypeLabel}`,
          summary: fallbackSummary(input),
          tags: fallbackTags(input),
        };
      }

      const prompt = `
Return ONLY strict JSON with keys: title, summary, tags.
Rules:
- Neutral, factual, concise.
- No financial advice.
- title: 1 sentence.
- summary: 1-2 sentences.
- tags: 2-4 lowercase kebab-case tags.
- Use only provided facts.

Input:
${JSON.stringify(input)}
`;

      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You output strict JSON only." },
              { role: "user", content: prompt },
            ],
          }),
        });

        if (!r.ok) {
          return {
            title: `${input.ceo} — ${input.tradeTypeLabel}`,
            summary: fallbackSummary(input),
            tags: fallbackTags(input),
          };
        }

        const j = await r.json();
        const content = j?.choices?.[0]?.message?.content || "{}";
        let parsed = {};
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = {};
        }

        return {
          title: parsed?.title || `${input.ceo} — ${input.tradeTypeLabel}`,
          summary: parsed?.summary || fallbackSummary(input),
          tags: Array.isArray(parsed?.tags) && parsed.tags.length ? parsed.tags : fallbackTags(input),
        };
      } catch {
        return {
          title: `${input.ceo} — ${input.tradeTypeLabel}`,
          summary: fallbackSummary(input),
          tags: fallbackTags(input),
        };
      }
    }

    function filingToTrades(filing) {
      const issuer = filing?.issuer || {};
      const owners = Array.isArray(filing?.reporting_owners) ? filing.reporting_owners : [];
      const owner = owners.find((o) => o?.ceo_match) || owners[0] || {};
      const ceoName = owner?.name || "Unknown CEO";
      const officerTitle = owner?.officer_title || "";

      const foot = (Array.isArray(filing?.footnotes) ? filing.footnotes : []).join(" ").toLowerCase();
      const tenB51 = foot.includes("10b5-1");

      const txs = Array.isArray(filing?.transactions) ? filing.transactions : [];
      const out = [];

      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i] || {};
        const shares = Number(tx.shares || 0);
        const price = Number(tx.price_per_share || 0);
        const value = Number(tx.transaction_value || 0);

        if (SKIP_ZERO_ROWS && shares === 0 && value === 0) continue; // small patch

        const tradeType = toTradeType(tx.transaction_type);
        const tradeTypeLabel = toTradeTypeLabel(tx.transaction_type);

        out.push({
          id: `${filing.accession_number || "acc"}-${i}`,
          accessionNumber: filing.accession_number || null,
          ceo: ceoName,
          company: issuer?.name || "Unknown Company",
          ticker: issuer?.ticker || "N/A",
          sector: "Unknown",
          tradeType,
          tradeTypeLabel,
          transactionDate: tx.transaction_date || filing.filed_date || null,
          filedDate: filing.filed_date || tx.transaction_date || null,
          shares,
          price,
          value,
          pctHoldingsChange: 0,
          tenB51,
          perf: { sinceTrade: { changePct: 0 } },
          upvotes: 0,
          sharesOwnedAfter: 0,
          lines: [{ shares, price, value }],
          title: "",
          summary: "",
          tags: [],
          sourceUrl: filing?.source_url || filing?.source_document_url || "#",
          officerTitle,
          ceoMatch: Boolean(owner?.ceo_match),
          ceoMatchConfidence: owner?.ceo_match_confidence || null,
        });
      }

      return out;
    }

    // ---- pagination with min-trades target patch ----
    const allFilings = [];
    let pageCount = 0;
    let currentOffset = initialOffset;
    let hasMore = true;
    let lastMeta = null;
    let lastPagination = null;
    let collectedTradesCount = 0;

    while (hasMore && pageCount < MAX_PAGES) {
      const page = await fetchHermPage(currentOffset);
      lastMeta = page?.meta || null;

      const filings = Array.isArray(page?.data?.filings) ? page.data.filings : [];
      const pagination = page?.data?.pagination || {};
      lastPagination = pagination;

      allFilings.push(...filings);

      // Estimate collected real trades so far
      for (const f of filings) {
        collectedTradesCount += filingToTrades(f).length;
      }

      hasMore = Boolean(pagination?.has_more);
      currentOffset =
        typeof pagination?.next_offset === "number"
          ? pagination.next_offset
          : currentOffset + limit;

      pageCount += 1;

      // stop early if we already reached minimum useful feed size
      if (collectedTradesCount >= MIN_TRADES_TARGET) break;
      if (!hasMore) break;
    }

    // Flatten once for output
    const rawTrades = [];
    for (const filing of allFilings) {
      rawTrades.push(...filingToTrades(filing));
    }

    const trades = await Promise.all(
      rawTrades.map(async (t, idx) => {
        if (idx >= MAX_AI_SUMMARIES) {
          return {
            ...t,
            title: `${t.ceo} — ${t.tradeTypeLabel}`,
            summary: fallbackSummary(t),
            tags: fallbackTags(t),
          };
        }

        const ai = await generateAiSummary({
          ceo: t.ceo,
          company: t.company,
          ticker: t.ticker,
          tradeType: t.tradeType,
          tradeTypeLabel: t.tradeTypeLabel,
          transactionDate: t.transactionDate,
          filedDate: t.filedDate,
          shares: t.shares,
          price: t.price,
          value: t.value,
          tenB51: t.tenB51,
          officerTitle: t.officerTitle,
          ceoMatch: t.ceoMatch,
          ceoMatchConfidence: t.ceoMatchConfidence,
        });

        return { ...t, title: ai.title, summary: ai.summary, tags: ai.tags };
      })
    );

    trades.sort((a, b) => new Date(b.transactionDate || 0) - new Date(a.transactionDate || 0));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    return res.status(200).json({
      trades,
      count: trades.length,
      fetchedAt: new Date().toISOString(),
      aiEnabled: Boolean(openaiKey),
      modelUsed: openaiKey ? model : null,
      hermai: {
        credits_used: lastMeta?.credits_used ?? null,
        credits_remaining: lastMeta?.credits_remaining ?? null,
        cached: lastMeta?.cached ?? null,
        pagination: lastPagination,
        pages_fetched: pageCount,
      },
      query: {
        start_date,
        end_date,
        role,
        limit,
        initial_offset: initialOffset,
        max_pages: MAX_PAGES,
        max_ai: MAX_AI_SUMMARIES,
        min_trades: MIN_TRADES_TARGET,
        skip_zero_rows: SKIP_ZERO_ROWS,
      },
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: String(err?.message || err),
    });
  }
}
