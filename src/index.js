if (url.pathname === "/api/assistant" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));
  const symbol = (body.symbol || "").trim().toUpperCase();
  const question = (body.question || "").trim();

  if (!symbol) return json({ error: "Missing symbol" }, 400);

  const rows = await env.DB.prepare(`
    SELECT symbol, category, date, open, high, low, close, volume, source
    FROM daily_ohlcv
    WHERE symbol = ?
    ORDER BY date DESC
    LIMIT 60
  `).bind(symbol).all();

  if (!rows.results || rows.results.length === 0) {
    return json({ symbol, answer: `No OHLCV found for ${symbol} in D1.` });
  }

  const latest = rows.results[0];
  const prev = rows.results[1] || null;

  const close = Number(latest.close);
  const prevClose = prev ? Number(prev.close) : null;
  const chg = (prevClose && isFinite(prevClose)) ? close - prevClose : null;
  const chgPct = (prevClose && isFinite(prevClose) && prevClose !== 0) ? (chg / prevClose) * 100 : null;

  const context = {
    symbol,
    latest,
    previous: prev,
    computed: { one_day_change: chg, one_day_change_pct: chgPct },
    series: rows.results
  };

  const system =
`You are Minerlytics AI. Use ONLY the JSON context provided.
Do NOT invent prices, dates, news, interviews, or sentiment.
If asked for something not in JSON, say you don't have it.
Return:
- Summary (2-4 lines)
- Latest OHLCV
- 1D change
- Category + source`;

  const user =
`Question: ${question || "Give a quick summary using stored OHLCV only."}

JSON context:
${JSON.stringify(context)}`;

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: `${system}\n\n${user}`
  });

  const answer =
    (typeof result === "string" && result) ||
    result?.response ||
    result?.result ||
    JSON.stringify(result);

  return json({ symbol, answer });
}
