export default async function handler(req, res) {
  try {
    const apiKey = process.env.HERMAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing HERMAI_API_KEY" });
    }

    // Replace with real HermAI endpoint + params
    const r = await fetch("https://api.hermai.ai/form4?role=CEO", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: `HermAI error ${r.status}`, detail: txt });
    }

    const raw = await r.json();
    const items = Array.isArray(raw?.items) ? raw.items : [];

    const trades = items.map((x, i) => ({
      id: x.id ?? `${x.accession_number ?? "filing"}-${i}`,
      ceo: x.ceo_name ?? x.ceo ?? "Unknown CEO",
      company: x.company_name ?? x.company ?? "Unknown Company",
      ticker: x.ticker ?? "N/A",
      sector: x.sector ?? "Unknown",
      tradeType: x.trade_type ?? "sell",
      tradeTypeLabel: x.trade_type_label ?? "Open Market Sell",
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
      lines: Array.isArray(x.lines) ? x.lines : [{ shares: Number(x.shares ?? 0), price: Number(x.price ?? 0), value: Number(x.value ?? 0) }],
      title: x.title ?? "New Form 4 filing",
      summary: x.summary ?? "",
      tags: Array.isArray(x.tags) ? x.tags : [],
      sourceUrl: x.source_url ?? "#",
    }));

    return res.status(200).json({ trades });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
