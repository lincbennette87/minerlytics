import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
  });
}

function options() {
  return new Response(null, { status: 204, headers: { ...CORS } });
}

function normalizeSymbolToStooqUS(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith(".us") ? s : s + ".us";
}

function symbolToTicker(symbol) {
  return String(symbol || "").replace(/\.us$/i, "").toUpperCase().trim();
}

function safeJsonParseArray(s) {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function buildNewsDetailFromSummary(row) {
  if (!row) return null;

  const total = Number(row.mentions || 0);
  const bullish = Number(row.bullish || 0);
  const bearish = Number(row.bearish || 0);
  const neutral = Number(row.neutral || 0);
  const pct = (x) => (total ? Math.round((x / total) * 100) : 0);

  return {
    window_hours: Number(row.window_hours || 0),
    total,
    bullish,
    bearish,
    neutral,
    bullish_pct: pct(bullish),
    bearish_pct: pct(bearish),
    neutral_pct: pct(neutral),
    top_titles: safeJsonParseArray(row.top_titles_json),
    last_updated: row.last_updated || null,
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") return options();

      if (path === "/api/health") {
        return text("Minerlytics DEV is running ✅ v2");
      }

      if (path === "/api/d1-test") {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM daily_ohlcv").first();
        return json({ ok: true, rows_in_daily_ohlcv: r && r.n ? r.n : 0 });
      }

      if (path === "/api/assistant" && request.method === "GET") {
        return text('OK. Use POST /api/assistant with JSON body like {"symbol":"HYMC","question":"..."}');
      }

      if (path === "/api/news" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const rssUrl = googleRssUrl(TICKERS[ticker].q);
        const r = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const xml = await r.text();
        const items = parseRssItems(xml, 25);

        return json({ ticker, rssUrl, items });
      }

      if (path === "/api/news-summary" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const row = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        return json({ ticker, summary: row || null });
      }

      if (path === "/api/news-detail" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "15", 10), 1), 100);

        const row = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const items = await env.DB.prepare(
          "SELECT title, link, source, published_at, fetched_at FROM news_items WHERE ticker = ? ORDER BY fetched_at DESC LIMIT ?"
        ).bind(ticker, limit).all();

        return json({ ticker, summary: row || null, items: items.results || [] });
      }

      if (path === "/api/assistant" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));

        const symbol = normalizeSymbolToStooqUS(body.symbol);
        const ticker = symbolToTicker(symbol);
        const question = String(body.question || "").trim();

        if (!symbol) return json({ error: "Missing symbol" }, 400);

        const rows = await env.DB.prepare(
          "SELECT symbol, category, date, open, high, low, close, volume, source " +
            "FROM daily_ohlcv WHERE symbol = ? ORDER BY date DESC LIMIT 60"
        ).bind(symbol).all();

        if (!rows.results || rows.results.length === 0) {
          return json({ symbol, answer: "No OHLCV found for " + symbol + " in D1." });
        }

        const latest = rows.results[0];
        const prev = rows.results.length > 1 ? rows.results[1] : null;

        const close = Number(latest.close);
        const prevClose = prev ? Number(prev.close) : null;
        const chg = prevClose && Number.isFinite(prevClose) ? close - prevClose : null;
        const chgPct = prevClose && Number.isFinite(prevClose) && prevClose !== 0 ? (chg / prevClose) * 100 : null;

        const summaryRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const newsDetail = buildNewsDetailFromSummary(summaryRow);

        const context = {
          symbol,
          ticker,
          latest,
          previous: prev,
          computed: { one_day_change: chg, one_day_change_pct: chgPct },
          news: newsDetail,
          series: rows.results,
        };

        const system =
          "You are Minerlytics AI.\n" +
          "Use ONLY the provided data.\n" +
          "Do NOT mention 'JSON', 'context', 'provided data', or internal tooling.\n" +
          "If news data exists, you MUST:\n" +
          "1) compute bullish/bearish/neutral percentages\n" +
          "2) list 3 most recent headlines with source\n" +
          "3) explain what the headlines suggest in 2-4 lines\n" +
          "If news is missing, say: 'News sentiment not available yet.'\n\n" +
          "Return format:\n" +
          "📌 **Summary**\n" +
          "📊 **Latest OHLCV**\n" +
          "📈 **1D Change**\n" +
          "📉 **Trend Analysis**\n" +
          "📰 **News Sentiment**\n" +
          "🏷️ **Category + Source**";

        const user =
          "Question: " +
          (question || "Give a quick summary using stored OHLCV only.") +
          "\n\nDATA:\n" +
          JSON.stringify(context);

        const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          prompt: system + "\n\n" + user,
        });

        const answer =
          (typeof result === "string" && result) ||
          (result && (result.response || result.result)) ||
          JSON.stringify(result);

        return json({ symbol, answer });
      }

      if (path === "/api/debug-lookup" && request.method === "GET") {
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
          like: like.results || [],
        });
      }

      return new Response("Not found", { status: 404, headers: CORS });
    } catch (err) {
      return new Response(
        "Worker error:\n" + (err && (err.stack || err.message)) + "\n" + String(err),
        { status: 500, headers: { "content-type": "text/plain; charset=utf-8", ...CORS } }
      );
    }
  },

  async scheduled(event, env) {
    await refreshNewsForAll(env);
  },
};
