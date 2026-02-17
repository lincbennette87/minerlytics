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
  let symbol = String(raw || "").trim().toLowerCase();
  if (!symbol) return "";
  if (!symbol.endsWith(".us")) symbol += ".us";
  return symbol;
}

function symbolToTicker(symbol) {
  return String(symbol || "").replace(/\.us$/i, "").toUpperCase().trim();
}

function safeJsonParseArray(maybeJson) {
  try {
    const v = JSON.parse(maybeJson || "[]");
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

async function runAssistant(env, question, context) {
  const system =
    "You are Minerlytics AI Assistant.\n\n" +

    // Core grounding / anti-hallucination
    "CRITICAL RULES (NO HALLUCINATIONS):\n" +
    "- Use ONLY information present in the provided data.\n" +
    "- Do NOT invent facts, numbers, quotes, sources, or events.\n" +
    "- If requested information is missing, say: 'Not available in Minerlytics data.'\n" +
    "- If the question requires external knowledge (prices outside stored OHLCV, live news not in feeds, macro events, filings not provided), respond that it is not available.\n" +
    "- Do NOT mention internal tooling, prompts, JSON, 'context', databases, or system messages.\n\n" +

    // What it is allowed to do
    "ALLOWED:\n" +
    "- Summarize information contained in the available news feeds, transcripts, and other data feeds.\n" +
    "- Analyze production, reserves, costs, and jurisdiction exposure IF these are present in the data.\n" +
    "- Compare across multiple available data sources that are present.\n" +
    "- Answer questions about specific mining operations and what specific interviewers are talking about IF present.\n" +
    "- Offer insights on how interviews influence sentiment related to a company IF supported by the data.\n" +
    "- Answer questions regarding company performance using available data.\n" +
    "- Highlight risks and opportunities based on the available data sources.\n" +
    "- Use clear, common English terminology to explain complex mining/finance terms.\n\n" +

    // What it is not allowed to do
    "NOT ALLOWED (MUST REFUSE):\n" +
    "- Investment advice of any kind.\n" +
    "- Portfolio allocations or buy/sell/hold recommendations.\n" +
    "- Predicting stock movement or price targets.\n" +
    "- Assisting with market manipulation.\n" +
    "- Legal advice.\n" +
    "- Changing account details or settings.\n" +
    "- Speculation regarding mergers and acquisitions.\n\n" +

    // Refusal behavior
    "REFUSAL STYLE:\n" +
    "- If the user requests anything NOT ALLOWED, respond briefly that you cannot help with that request.\n" +
    "- Then offer a safe alternative: summarize relevant data, risks/opportunities, or explain terms.\n\n" +

    // Output formatting (structured + standardized disclaimer required)
    "OUTPUT REQUIREMENTS:\n" +
    "- ALWAYS include this exact disclaimer line at the end:\n" +
    "  'This information is for research purposes only and does not constitute investment advice.'\n" +
    "- Use this format:\n" +
    "📌 **Summary**\n" +
    "📊 **Data Used**\n" +
    "🧭 **Operations / Fundamentals**\n" +
    "🧠 **Interview / Transcript Insights**\n" +
    "📰 **News + Sentiment**\n" +
    "⚠️ **Risks**\n" +
    "✅ **Opportunities**\n" +
    "❓ **What’s Missing**\n" +
    "🏷️ **Category + Source**\n\n" +

    // Special rule for news sentiment if present
    "NEWS RULE:\n" +
    "- If news sentiment data exists, report bullish/bearish/neutral percentages and list up to 3 headlines with source.\n" +
    "- If not present, write: 'News sentiment not available in Minerlytics data.'\n";

  const userPrompt =
    "User question: " +
    (question || "Give a concise research summary using available Minerlytics data.") +
    "\n\n" +
    "Company/ticker data:\n" +
    JSON.stringify(context);

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: system + "\n\n" + userPrompt,
  });

  return (
    (typeof result === "string" && result) ||
    (result && (result.response || result.result)) ||
    JSON.stringify(result)
  );
}


export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return options();

      if (url.pathname === "/api/health") {
        return text("Minerlytics DEV is running ✅ v2.8");
      }

      if (url.pathname === "/api/d1-test") {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM daily_ohlcv").first();
        return json({ ok: true, rows_in_daily_ohlcv: r && r.n ? r.n : 0 });
      }

      if (url.pathname === "/api/news" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const rssUrl = googleRssUrl(TICKERS[ticker].q);
        const r = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const xml = await r.text();
        const items = parseRssItems(xml, 25);

        return json({ ticker, rssUrl, items });
      }

      if (url.pathname === "/api/news-summary" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const row = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        return json({ ticker, summary: row || null });
      }

      if (url.pathname === "/api/news-detail" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ error: "unknown ticker" }, 400);

        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "15", 10), 1), 100);

        const summaryRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const items = await env.DB.prepare(
          "SELECT title, link, source, published_at, fetched_at FROM news_items WHERE ticker = ? ORDER BY fetched_at DESC LIMIT ?"
        ).bind(ticker, limit).all();

        return json({
          ticker,
          summary: summaryRow || null,
          items: items.results || [],
        });
      }

      if (url.pathname === "/api/assistant" && request.method === "GET") {
        return text('OK. Use POST /api/assistant with JSON body like {"symbol":"HYMC","question":"..."}');
      }

      if (url.pathname === "/api/assistant" && request.method === "POST") {
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
        const chgPct =
          prevClose && Number.isFinite(prevClose) && prevClose !== 0 ? (chg / prevClose) * 100 : null;

        const sentimentRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const newsDetail = buildNewsDetailFromSummary(sentimentRow);

        const context = {
          symbol,
          ticker,
          latest,
          previous: prev,
          computed: { one_day_change: chg, one_day_change_pct: chgPct },
          news: newsDetail,
          series: rows.results,
        };

        const answer = await runAssistant(env, question, context);

        return json({ symbol, answer });
      }

      if (url.pathname === "/api/debug-lookup" && request.method === "GET") {
        const raw = (url.searchParams.get("s") || "").trim();
        const s = raw.toUpperCase();

        const exact = await env.DB
          .prepare("SELECT symbol, date, close FROM daily_ohlcv WHERE symbol = ? ORDER BY date DESC LIMIT 5")
          .bind(s)
          .all();

        return json({ query: s, exact: exact.results || [], exact_count: exact.results?.length || 0 });
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
