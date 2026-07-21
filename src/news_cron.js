import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";

function newsItemId(ticker, link, title) {
  const source = `${ticker}:${link || title || ""}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return `${ticker}-${Math.abs(hash)}`;
}

async function ensureNewsTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS news_items (
      id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      source TEXT,
      published_at TEXT,
      fetched_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_news_items_ticker_fetched
    ON news_items(ticker, fetched_at DESC)
  `).run();
}

async function refreshNewsForTicker(env, ticker) {
  const symbol = String(ticker || "").toUpperCase().trim();
  const config = TICKERS[symbol];
  if (!symbol || !config) {
    return { ticker: symbol, ok: false, count: 0, error: "unknown ticker" };
  }

  const fetchedAt = new Date().toISOString();
  const rssUrl = googleRssUrl(config.q || `${symbol} mining`);
  const response = await fetch(rssUrl, {
    headers: {
      "User-Agent": "Minerlytics/1.0 RSS refresh",
      accept: "application/rss+xml, application/xml, text/xml"
    }
  });

  if (!response.ok) {
    return { ticker: symbol, ok: false, count: 0, error: `rss fetch failed ${response.status}` };
  }

  const xml = await response.text();
  const items = parseRssItems(xml, 25);
  if (!items.length) return { ticker: symbol, ok: true, count: 0, rssUrl };

  const statements = items
    .filter((item) => item.title && item.link)
    .map((item) => env.DB.prepare(`
      INSERT OR IGNORE INTO news_items (
        id,
        ticker,
        title,
        link,
        source,
        published_at,
        fetched_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newsItemId(symbol, item.link, item.title),
      symbol,
      item.title,
      item.link,
      item.source || item.publisher || "Google News",
      item.published_at || item.pubDate || "",
      fetchedAt
    ));

  if (statements.length) await env.DB.batch(statements);
  return { ticker: symbol, ok: true, count: statements.length, rssUrl };
}

export async function refreshNewsForAll(env, tickers = Object.keys(TICKERS)) {
  if (!env?.DB) return [];
  await ensureNewsTables(env);

  const symbols = (Array.isArray(tickers) && tickers.length ? tickers : Object.keys(TICKERS))
    .map((ticker) => String(ticker || "").toUpperCase().trim())
    .filter((ticker, index, all) => ticker && TICKERS[ticker] && all.indexOf(ticker) === index);

  const results = [];
  for (const ticker of symbols) {
    try {
      results.push(await refreshNewsForTicker(env, ticker));
    } catch (error) {
      results.push({ ticker, ok: false, count: 0, error: String(error?.message || error) });
    }
  }
  return results;
}
