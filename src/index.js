import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";https://github.com/lincbennette87/minerlytics/blob/develop/src/index.js
import { handleEducationPortalChat, educationOptions } from "./educationPortalChat.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  // ✅ added x-api-key so browser/clients can send it
  "access-control-allow-headers": "content-type,x-api-key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS,
    },
  });
}

function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...CORS,
    },
  });
}

function options() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS },
  });
}

function normalizeSymbolToStooqUS(raw) {
  let symbol = String(raw || "").trim().toLowerCase();

  if (!symbol) return "";
  if (!symbol.endsWith(".us")) symbol += ".us";

  return symbol;
}

function symbolToTicker(symbol) {
  return String(symbol || "")
    .replace(/\.us$/i, "")
    .toUpperCase()
    .trim();
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
