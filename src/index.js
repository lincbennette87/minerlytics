const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extraHeaders },
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response("", { headers: CORS });
      }

      if (url.pathname === "/api/health") {
        return new Response("Minerlytics DEV is running ✅ v2", {
          headers: { "content-type": "text/plain", ...CORS },
        });
      }

      if (url.pathname === "/api/d1-test") {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM daily_ohlcv").first();
        return json({ ok: true, rows_in_daily_ohlcv: (r && r.n) ? r.n : 0 });
      }

      if (url.pathname === "/api/assistant" && request.method === "GET") {
        return new Response(
          'OK. Use POST /api/assistant with JSON body like {"symbol":"HYMC","question":"..."}',
          { headers: { "content-type": "text/plain", ...CORS } }
        );
      }

      if (url.pathname === "/api/assistant" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const symbol = String(body.symbol || "").trim().toUpperCase();
        const question = String(body.question || "").trim();

        if (!symbol) return json({ error: "Missing symbol" }, 400);

        const rows = await env.DB
          .prepare(
            "SELECT symbol, category, date, open, high, low, close, volume, source " +
              "FROM daily_ohlcv " +
              "WHERE symbol = ? " +
              "ORDER BY date DESC " +
              "LIMIT 60"
          )
          .bind(symbol)
          .all();

        if (!rows.results || rows.results.length === 0) {
          return json({ symbol: symbol, answer: "No OHLCV found for " + symbol + " in D1." });
        }

        const latest = rows.results[0];
        const prev = rows.results.length > 1 ? rows.results[1] : null;

        const close = Number(latest.close);
        const prevClose = prev ? Number(prev.close) : null;
        const chg = prevClose && isFinite(prevClose) ? close - prevClose : null;
        const chgPct =
          prevClose && isFinite(prevClose) && prevClose !== 0 ? (chg / prevClose) * 100 : null;

        const context = {
          symbol: symbol,
          latest: latest,
          previous: prev,
          computed: { one_day_change: chg, one_day_change_pct: chgPct },
          series: rows.results,
        };

        const system =
          "You are Minerlytics AI. Use ONLY the JSON context provided.\n" +
          "Do NOT invent prices, dates, news, interviews, or sentiment.\n" +
          "If asked for something not in JSON, say you don't have it.\n" +
          "Return:\n" +
          "- Summary (2-4 lines)\n" +
          "- Latest OHLCV (date/open/high/low/close/volume)\n" +
          "- 1D change (abs and % if available)\n" +
          "- Category + source";

        const user =
          "Question: " +
          (question || "Give a quick summary using stored OHLCV only.") +
          "\n\nJSON context:\n" +
          JSON.stringify(context);

        const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          prompt: system + "\n\n" + user,
        });

        const answer =
          (typeof result === "string" && result) ||
          (result && (result.response || result.result)) ||
          JSON.stringify(result);

        return json({ symbol: symbol, answer: answer });
      }
if (url.pathname === "/api/debug-lookup" && request.method === "GET") {
  const raw = (url.searchParams.get("s") || "").trim();
  const s = raw.toUpperCase();

  const exact = await env.DB
    .prepare("SELECT symbol, date, close FROM daily_ohlcv WHERE symbol = ? ORDER BY date DESC LIMIT 5")
    .bind(s)
    .all();

  const norm = await env.DB
    .prepare("SELECT symbol, date, close FROM daily_ohlcv WHERE UPPER(TRIM(symbol)) = ? ORDER BY date DESC LIMIT 5")
    .bind(s)
    .all();

  const like = await env.DB
    .prepare("SELECT symbol, date, close FROM daily_ohlcv WHERE UPPER(symbol) LIKE ? ORDER BY date DESC LIMIT 10")
    .bind("%" + s + "%")
    .all();

  return json({
    query: s,
    exact_count: exact.results?.length || 0,
    normalized_count: norm.results?.length || 0,
    like_count: like.results?.length || 0,
    exact: exact.results || [],
    normalized: norm.results || [],
    like: like.results || []
  });
}

      return new Response("Not found", { status: 404, headers: CORS });
    } catch (err) {
      return new Response(
        "Worker error:\n" + (err && (err.stack || err.message)) + "\n" + String(err),
        { status: 500, headers: { "content-type": "text/plain", ...CORS } }
      );
    }
  },
};
