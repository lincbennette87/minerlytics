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

function normalizeSymbol(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (!s.endsWith(".us")) s += ".us";
  return s;
}

function tickerFromSymbol(symbol) {
  return symbol.replace(/\.us$/i, "").toUpperCase();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (url.pathname === "/api/health") {
        return text("Minerlytics DEV running ✅");
      }

      if (url.pathname === "/api/news-detail") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase();
        if (!ticker || !TICKERS[ticker]) {
          return json({ error: "unknown ticker" }, 400);
        }

        const summaryRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const items = await env.DB.prepare(
          "SELECT title, link, source, published_at FROM news_items WHERE ticker = ? ORDER BY fetched_at DESC LIMIT 20"
        ).bind(ticker).all();

        return json({
          ticker,
          summary: summaryRow || null,
          items: items.results || []
        });
      }

      if (url.pathname === "/api/assistant" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const symbol = normalizeSymbol(body.symbol);
        const ticker = tickerFromSymbol(symbol);
        const question = String(body.question || "").trim();

        if (!symbol) return json({ error: "Missing symbol" }, 400);

        const priceRows = await env.DB.prepare(
          "SELECT symbol, date, open, high, low, close, volume FROM daily_ohlcv WHERE symbol = ? ORDER BY date DESC LIMIT 60"
        ).bind(symbol).all();

        if (!priceRows.results?.length) {
          return json({ symbol, answer: "No OHLCV data found." });
        }

        const latest = priceRows.results[0];
        const prev = priceRows.results[1] || null;

        const close = Number(latest.close);
        const prevClose = prev ? Number(prev.close) : null;

        const change = prevClose ? close - prevClose : null;
        const changePct = prevClose ? (change / prevClose) * 100 : null;

        const sentimentRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        let newsData = null;

        if (sentimentRow) {
          const total = Number(sentimentRow.mentions || 0);
          const bullish = Number(sentimentRow.bullish || 0);
          const bearish = Number(sentimentRow.bearish || 0);
          const neutral = Number(sentimentRow.neutral || 0);

          const pct = (v) => total ? Math.round((v / total) * 100) : 0;

          newsData = {
            total,
            bullish,
            bearish,
            neutral,
            bullish_pct: pct(bullish),
            bearish_pct: pct(bearish),
            neutral_pct: pct(neutral)
          };
        }

        const context = {
          symbol,
          latest,
          change,
          changePct,
          news: newsData
        };

        const system =
          "You are Minerlytics AI.\n" +
          "Use only the provided data.\n" +
          "Never mention JSON or context.\n\n" +
          "Format exactly:\n" +
          "📌 Summary\n" +
          "📊 Latest OHLCV\n" +
          "📈 1D Change\n" +
          "📉 Trend\n" +
          "📰 News Sentiment\n";

        const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          prompt: system + "\n\n" + JSON.stringify(context)
        });

        const answer =
          typeof result === "string"
            ? result
            : result.response || JSON.stringify(result);

        return json({ symbol, answer });
      }

      return new Response("Not found", { status: 404, headers: CORS });

    } catch (err) {
      return new Response(
        "Worker error:\n" + (err.stack || err.message),
        { status: 500 }
      );
    }
  },

  async scheduled(event, env) {
    await refreshNewsForAll(env);
  }
};
