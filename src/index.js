import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";

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

function text(data, status = 200, extraHeaders = {}) {
  return new Response(data, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS, ...extraHeaders },
  });
}

function options() {
  return new Response(null, { status: 204, headers: { ...CORS } });
}

function normalizeTickerFromSymbol(symbolWithSuffix) {
  const s = String(symbolWithSuffix || "").trim();
  if (!s) return "";
  return s.replace(/\.us$/i, "").toUpperCase();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return options();

      if (url.pathname === "/api/health") {
        return text("Minerlytics DEV is running ✅ v2");
      }

      if (url.pathname === "/api/d1-test") {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM daily_ohlcv").first();
        return json({ ok: true, rows_in_daily_ohlcv: r && r.n ? r.n : 0 });
      }

      if (url.pathname === "/api/news" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "")
          .toUpperCase()
          .trim();

        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const rssUrl = googleRssUrl(TICKERS[ticker].q);
        const r = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const xml = await r.text();
        const items = parseRssItems(xml, 25);

        return json({ ticker, rssUrl, items });
      }

      if (url.pathname === "/api/news-summary" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "")
          .toUpperCase()
          .trim();

        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const summary = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        return json({ ticker, summary: summary || null });
      }

      if (url.pathname === "/api/assistant" && request.method === "GET") {
        return text('OK. Use POST /api/assistant with JSON body like {"symbol":"HYMC","question":"..."}');
      }

      if (url.pathname === "/api/assistant" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));

        let symbol = String(body.symbol || "").trim().toLowerCase();
        if (!symbol) return json({ error: "Missing symbol" }, 400);

        if (!symbol.endsWith(".us")) symbol = symbol + ".us";

        const ticker = normalizeTickerFromSymbol(symbol);

        const question = String(body.question || "").trim();

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

        const newsSummary = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const context = {
          symbol: symbol,
          ticker: ticker,
          latest: latest,
          previous: prev,
          computed: { one_day_change: chg, one_day_change_pct: chgPct },
          news: newsSummary || null,
          series: rows.results,
        };

        const system =
          "You are Minerlytics AI.\n" +
          "You must ONLY use the provided JSON context.\n" +
          "You MAY compute derived metrics such as trend, momentum, volatility, and percentage changes.\n" +
          "Do NOT invent external data such as news or fundamentals beyond what is in the JSON.\n" +
          "If external info is requested, clearly state it is unavailable.\n\n" +
          "Return your response formatted exactly like this:\n" +
          "📌 **Summary**\n" +
          "📊 **Latest OHLCV**\n" +
          "📈 **1D Change**\n" +
          "📉 **Trend Analysis**\n" +
          "📰 **News Sentiment (if provided)**\n" +
          "🏷️ **Category + Source**";

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
          .prepare(
            "SELECT symbol, date, close FROM daily_ohlcv WHERE symbol = ? ORDER BY date DESC LIMIT 5"
          )
          .bind(s)
          .all();

        const norm = await env.DB
          .prepare(
            "SELECT symbol, date, close FROM daily_ohlcv WHERE UPPER(TRIM(symbol)) = ? ORDER BY date DESC LIMIT 5"
          )
          .bind(s)
          .all();

        const like = await env.DB
          .prepare(
            "SELECT symbol, date, close FROM daily_ohlcv WHERE UPPER(symbol) LIKE ? ORDER BY date DESC LIMIT 10"
          )
          .bind("%" + s + "%")
          .all();

        return json({
          query: s,
          exact_count: exact.results?.length || 0,
          normalized_count: norm.results?.length || 0,
          like_count: like.results?.length || 0,
          exact: exact.results || [],
          normalized: norm.results || [],
          like: like.results || [],
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

  async scheduled(event, env) {
    await refreshNewsForAll(env);
  },
};
