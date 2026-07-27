export default async function handler(req, res) {
  try {
    const hermaiKey = process.env.HERMAI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    if (!hermaiKey) {
      return res.status(500).json({ error: "Missing HERMAI_API_KEY" });
    }

    // 1) Pull filings from HermAI (replace URL with exact HermAI endpoint if needed)
    const hermRes = await fetch("https://api.hermai.ai/form4?role=CEO", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${hermaiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!hermRes.ok) {
      const detail = await hermRes.text();
      return res.status(502).json({
        error: `HermAI request failed (${hermRes.status})`,
        detail,
      });
    }

    const raw = await hermRes.json();
    const items = Array.isArray(raw?.items) ? raw.items : [];

    // Limit AI calls per request to control cost/latency
    const MAX_AI_SUMMARIES = 12;

    async function generateAiSummary(input) {
      // Fallback if no OpenAI key
      if (!openaiKey) {
        return {
          title: `${input.ceo} — ${input.tradeTypeLabel}`,
          summary: fallbackSummary(input),
          tags: fallbackTags(input),
        };
      }

      const prompt = `
You are writing plain-English summaries for SEC Form 4 insider filings.
Return ONLY valid JSON with keys: title, summary, tags.
Rules:
- Neutral, factual, concise.
- No investment advice.
- 1 sentence title, 1-2 sentence summary.
- tags: array of 2-4 short lowercase tags (kebab-case).
- Do not invent facts not in input.

Input JSON:
${JSON.stringify(input)}
`;

      try {
        const oaRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
              { role: "system", content: "You produce strict JSON outputs only." },
              { role: "user", content: prompt },
            ],
          }),
        });

        if (!oaRes.ok) {
          // quota/rate/billing/etc => fallback
          return {
            title: `${input.ceo} — ${input.tradeTypeLabel}`,
            summary: fallbackSummary(input),
            tags: fallbackTags(input),
          };
        }

        const oaJson = await oaRes.json();
        const content = oaJson?.choices?.[0]?.message?.content || "{}";
        let parsed = {};
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = {};
        }

        return {
          title:
            typeof parsed.title === "string" && parsed.title.trim()
              ? parsed.title.trim()
              : `${input.ceo} — ${input.tradeTypeLabel}`,
          summary:
            typeof parsed.summary === "string" && parsed.summary.trim()
              ? parsed.summary.trim()
              : fallbackSummary(input),
          tags:
            Array.isArray(parsed.tags) && parsed.tags.length
              ? parsed.tags.slice(0, 4).map(String)
              : fallbackTags(input),
        };
      } catch {
        return {
          title: `${input.ceo} — ${input.tradeTypeLabel}`,
          summary: fallbackSummary(input),
          tags: fallbackTags(input),
        };
      }
    }

    function fallbackTags(t) {
      const tags = [];
      if (t.tenB51) tags.push("10b5-1");
      else tags.push("discretionary");
      tags.push((t.sector || "unknown").toLowerCase().replace(/\s+/g, "-"));
      tags.push((t.tradeType || "trade").toLowerCase());
      return [...new Set(tags)].slice(0, 4);
    }

    function fallbackSummary(t) {
      const value = Number(t.value || 0);
      const shares = Number(t.shares || 0).toLocaleString();
      const v =
        value >= 1_000_000
          ? `$${(value / 1_000_000).toFixed(1)}M`
          : value >= 1_000
          ? `$${Math.round(value / 1_000)}K`
          : `$${value}`;
      const planText = t.tenB51
        ? "The filing indicates this transaction was executed under a 10b5-1 plan."
        : "This appears to be a discretionary transaction rather than a pre-scheduled 10b5-1 plan.";
      return `${t.ceo} reported a ${String(t.tradeTypeLabel || "Form 4 transaction").toLowerCase()} involving ${shares} shares (about ${v}). ${planText}`;
    }

    // 2) Map base data first
    const baseTrades = items.map((x, i) => {
      const tradeTypeRaw = (x.trade_type || "sell").toLowerCase();
      const tradeType =
        tradeTypeRaw === "buy" || tradeTypeRaw === "sell" || tradeTypeRaw === "award" || tradeTypeRaw === "option"
          ? tradeTypeRaw
          : "sell";

      const tradeTypeLabelMap = {
        buy: "Open Market Buy",
        sell: "Open Market Sell",
        award: "Award / Grant",
        option: "Option Exercise",
      };

      const tradeTypeLabel = x.trade_type_label || tradeTypeLabelMap[tradeType];

      return {
        id: x.id ?? `${x.accession_number ?? "filing"}-${i}`,
        ceo: x.ceo_name ?? x.ceo ?? "Unknown CEO",
        company: x.company_name ?? x.company ?? "Unknown Company",
        ticker: x.ticker ?? "N/A",
        sector: x.sector ?? "Unknown",
        tradeType,
        tradeTypeLabel,
        transactionDate: x.transaction_date ?? "2026-01-01",
        filedDate: x.filed_date ?? x.transaction_date ?? "2026-01-01",
        shares: Number(x.shares ?? 0),
        price: Number(x.price ?? 0),
        value: Number(x.value ?? 0),
        pctHoldingsChange: Number(x.pct_holdings_change ?? 0),
        tenB51: Boolean(x.tenb51),
        perf: x.perf ?? { sinceTrade: { changePct: 0 } },
        upvotes: 0,
        sharesOwnedAfter: Number(x.shares_owned_after ?? 0),
        lines: Array.isArray(x.lines)
          ? x.lines
          : [{ shares: Number(x.shares ?? 0), price: Number(x.price ?? 0), value: Number(x.value ?? 0) }],
        title: x.title || "",
        summary: x.summary || "",
        tags: Array.isArray(x.tags) ? x.tags : [],
        sourceUrl: x.source_url ?? "#",
      };
    });

    // 3) AI-enrich first N trades (cost control)
    const enriched = await Promise.all(
      baseTrades.map(async (t, idx) => {
        if (t.title && t.summary) return t; // keep provided summary
        if (idx >= MAX_AI_SUMMARIES) {
          // fallback for remainder to save tokens
          return {
            ...t,
            title: t.title || `${t.ceo} — ${t.tradeTypeLabel}`,
            summary: t.summary || fallbackSummary(t),
            tags: t.tags.length ? t.tags : fallbackTags(t),
          };
        }

        const ai = await generateAiSummary({
          ceo: t.ceo,
          company: t.company,
          ticker: t.ticker,
          sector: t.sector,
          tradeType: t.tradeType,
          tradeTypeLabel: t.tradeTypeLabel,
          transactionDate: t.transactionDate,
          filedDate: t.filedDate,
          shares: t.shares,
          price: t.price,
          value: t.value,
          pctHoldingsChange: t.pctHoldingsChange,
          tenB51: t.tenB51,
          sharesOwnedAfter: t.sharesOwnedAfter,
        });

        return {
          ...t,
          title: t.title || ai.title,
          summary: t.summary || ai.summary,
          tags: t.tags.length ? t.tags : ai.tags,
        };
      })
    );

    // newest first
    enriched.sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));

    return res.status(200).json({
      trades: enriched,
      count: enriched.length,
      fetchedAt: new Date().toISOString(),
      aiEnabled: Boolean(openaiKey),
      modelUsed: openaiKey ? model : null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: String(err),
    });
  }
}
