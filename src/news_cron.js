import { TICKERS } from "./tickers.js";
import { fetchGoogleRssItems } from "./rss.js";
import { headlineSentiment } from "./sentiment.js";

function nowIso() {
  return new Date().toISOString();
}

function makeId(ticker, link) {
  return `${ticker}:${link}`;
}

async function getWebsiteInvestorNewsFallback(env, ticker, limit = 12) {
  const rows = await env.DB.prepare(
    `
    SELECT symbol, article_title, article_url, published_date, retrieved_at
    FROM website_investor_news
    WHERE symbol = ?
      AND status_code = 'found'
      AND article_url IS NOT NULL
      AND article_url != ''
      AND article_title IS NOT NULL
      AND article_title != ''
    ORDER BY
      CASE
        WHEN published_date IS NOT NULL AND published_date != '' THEN published_date
        ELSE retrieved_at
      END DESC
    LIMIT ?
    `
  ).bind(ticker, Math.max(1, Math.min(25, Number(limit || 12)))).all();

  return (rows?.results || []).map((row) => ({
    title: row.article_title,
    link: row.article_url,
    source: "Company website",
    published_at_iso: row.published_date || row.retrieved_at || null,
  }));
}

async function refreshSentimentSummaryForTicker(env, ticker, fetchedAt) {
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

  return mentions;
}

export async function refreshNewsForAll(env, tickers = Object.keys(TICKERS)) {
  const fetchedAt = nowIso();
  const results = [];

  for (const rawTicker of Array.isArray(tickers) ? tickers : []) {
    const ticker = String(rawTicker || "").toUpperCase().trim();
    if (!ticker || !TICKERS[ticker]) continue;

    try {
      let items = [];
      let rssUrl = null;
      let queryUsed = null;
      let attempts = 0;
      let fallbackSource = null;

      try {
        const googleResult = await fetchGoogleRssItems(fetch, TICKERS[ticker].q, { limit: 25 });
        items = googleResult.items;
        rssUrl = googleResult.rssUrl;
        queryUsed = googleResult.queryUsed;
        attempts = googleResult.attempts;
      } catch (googleErr) {
        const websiteItems = await getWebsiteInvestorNewsFallback(env, ticker, 12);
        if (!websiteItems.length) throw googleErr;
        items = websiteItems;
        fallbackSource = "website_investor_news";
      }

      let inserted = 0;

      for (const it of items) {
        const id = makeId(ticker, it.link);
        const write = await env.DB.prepare(
          "INSERT OR IGNORE INTO news_items (id, ticker, title, link, source, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, ticker, it.title, it.link, it.source, it.published_at_iso || it.pubDate || null, fetchedAt).run();
        inserted += Number(write?.meta?.changes || 0);
      }

      const mentions = await refreshSentimentSummaryForTicker(env, ticker, fetchedAt);
      results.push({ ticker, ok: true, fetched: items.length, inserted, mentions, rssUrl, queryUsed, attempts, fallbackSource });
    } catch (err) {
      results.push({ ticker, ok: false, fetched: 0, inserted: 0, error: String(err?.message || err) });
    }
  }

  return results;
}
