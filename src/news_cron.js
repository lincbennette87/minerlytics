import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";
import { headlineSentiment } from "./sentiment.js";

function nowIso() {
  return new Date().toISOString();
}

function makeId(ticker, link) {
  return `${ticker}:${link}`;
}

export async function refreshNewsForAll(env) {
  const fetchedAt = nowIso();

  for (const ticker of Object.keys(TICKERS)) {
    const rssUrl = googleRssUrl(TICKERS[ticker].q);
    const r = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const xml = await r.text();
    const items = parseRssItems(xml, 25);

    for (const it of items) {
      const id = makeId(ticker, it.link);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO news_items (id, ticker, title, link, source, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, ticker, it.title, it.link, it.source, it.pubDate || null, fetchedAt).run();
    }

    const rows = await env.DB.prepare(
      "SELECT title FROM news_items WHERE ticker = ? ORDER BY fetched_at DESC LIMIT 50"
    ).bind(ticker).all();

    let bullish = 0, bearish = 0, neutral = 0;
    const titles = [];

    for (const row of (rows.results || [])) {
      titles.push(row.title);
      const s = headlineSentiment(row.title);
      if (s === "bullish") bullish++;
      else if (s === "bearish") bearish++;
      else neutral++;
    }

    const mentions = bullish + bearish + neutral;
    const topTitles = titles.slice(0, 5);

    await env.DB.prepare(
      "INSERT INTO news_sentiment_summary (ticker, window_hours, mentions, bullish, bearish, neutral, top_titles_json, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(ticker) DO UPDATE SET window_hours=excluded.window_hours, mentions=excluded.mentions, bullish=excluded.bullish, bearish=excluded.bearish, neutral=excluded.neutral, top_titles_json=excluded.top_titles_json, last_updated=excluded.last_updated"
    ).bind(
      ticker, 168, mentions, bullish, bearish, neutral, JSON.stringify(topTitles), fetchedAt
    ).run();
  }
}
