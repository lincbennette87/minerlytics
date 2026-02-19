// src/index.js
import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";

/**
 * CRON ROUTING
 * - Daily cron (your OHLCV/news): "30 3 * * *"
 * - Monthly cron (YouTube transcripts): "0 4 1 * *"
 *
 * Wrangler: "triggers": { "crons": ["30 3 * * *", "0 4 1 * *"] }
 */

const DAILY_CRON = "30 3 * * *";
const MONTHLY_YT_CRON = "0 4 1 * *";

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
    "You are Minerlytics AI.\n" +
    "You are a mining-sector research assistant.\n\n" +
    "WHAT YOU ARE ALLOWED TO DO:\n" +
    "- Summarize information contained in news feeds, transcripts, and other data feeds.\n" +
    "- Analyze production, reserves, operating costs, and jurisdiction exposure.\n" +
    "- Compare across multiple available data sources.\n" +
    "- Answer questions about specific mining operations.\n" +
    "- Explain what interviewers are discussing.\n" +
    "- Offer insights on how interviews may influence sentiment.\n" +
    "- Answer questions regarding company performance.\n" +
    "- Highlight risks and opportunities supported by the data.\n" +
    "- Use clear, simple English to explain complex mining or financial terms.\n\n" +
    "WHAT YOU ARE NOT ALLOWED TO DO:\n" +
    "- Provide investment advice.\n" +
    "- Recommend portfolio allocations.\n" +
    "- Predict stock movements.\n" +
    "- Assist with market manipulation.\n" +
    "- Provide legal advice.\n" +
    "- Change account details or settings.\n" +
    "- Provide price targets.\n" +
    "- Speculate about mergers and acquisitions.\n\n" +
    "IMPORTANT RULES:\n" +
    "- Only reference information contained in the provided DATA.\n" +
    "- Do NOT mention 'JSON', 'context', 'provided data', or internal tools.\n" +
    "- If the user asks for something disallowed, briefly refuse and redirect to research insights.\n" +
    "- Always include the exact standardized disclaimer at the end.\n\n" +
    "Return format exactly as:\n" +
    "📌 **Summary**\n" +
    "📰 **News & Transcript Insights**\n" +
    "⛏️ **Operations / Fundamentals**\n" +
    "⚠️ **Risks & Opportunities**\n" +
    "🏷️ **Sources Used**\n" +
    "🧾 **Disclaimer**\n\n" +
    "The disclaimer must be exactly:\n" +
    "\"this information is for research purposes only and does not constitute investment advice.\"";

  const userPrompt =
    "User question:\n" +
    (question || "Provide a concise research summary based on available data.") +
    "\n\nDATA:\n" +
    JSON.stringify(context);

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt: system + "\n\n" + userPrompt,
  });

  const rawAnswer =
    (typeof result === "string" && result) ||
    (result && (result.response || result.result)) ||
    JSON.stringify(result);

  const DISCLAIMER =
    "this information is for research purposes only and does not constitute investment advice.";

  if (!rawAnswer.toLowerCase().includes(DISCLAIMER)) {
    return rawAnswer.trim() + "\n\n🧾 **Disclaimer**\n" + DISCLAIMER;
  }

  return rawAnswer;
}

/* =========================
   YOUTUBE (MONTHLY) PIPELINE
   ========================= */

async function runYoutubeMonthlyJob(env, limitPerRun = 20) {
  const db = env.DB;

  const { results: channels } = await db
    .prepare(`SELECT channel_id, channel_name FROM yt_channels WHERE is_enabled = 1`)
    .all();

  if (!channels?.length) {
    console.log("[YT] No enabled channels in yt_channels.");
    return { ok: true, channels: 0, processed: 0 };
  }

  let processed = 0;

  for (const ch of channels) {
    // If you later add an ingest step to populate yt_videos for a channel, call it here:
    // await ingestChannelVideos(env, ch.channel_id);

    const n = await processPendingTranscripts(env, ch.channel_id, Math.max(1, limitPerRun));
    processed += n;

    await db
      .prepare(`UPDATE yt_channels SET last_run_at = datetime('now') WHERE channel_id = ?`)
      .bind(ch.channel_id)
      .run();
  }

  return { ok: true, channels: channels.length, processed };
}

async function processPendingTranscripts(env, channelId, limit) {
  const db = env.DB;

  const { results: vids } = await db
    .prepare(
      `SELECT video_id, url, title
       FROM yt_videos
       WHERE channel_id = ?
         AND (transcript_status IS NULL OR transcript_status = 'PENDING')
       ORDER BY published_at DESC
       LIMIT ?`
    )
    .bind(channelId, limit)
    .all();

  if (!vids?.length) {
    console.log(`[YT] No pending videos for channel ${channelId}`);
    return 0;
  }

  let okCount = 0;

  for (const v of vids) {
    try {
      await setTranscriptStatus(db, v.video_id, "PENDING", null, null);

      const lines = await fetchTranscriptLines(v.video_id);

      if (!lines.length) {
        await setTranscriptStatus(db, v.video_id, "NONE", "No captions found", null);
        continue;
      }

      const chunks = chunkLines(lines, 1100, 200);

      await db.prepare(`DELETE FROM yt_chunks WHERE video_id = ?`).bind(v.video_id).run();

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await db
          .prepare(
            `INSERT INTO yt_chunks (video_id, chunk_index, start_sec, end_sec, text, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(v.video_id, i, c.start, c.end, c.text)
          .run();
      }

      await setTranscriptStatus(db, v.video_id, "OK", null, "en");
      okCount++;

      await sleep(250);
    } catch (e) {
      await setTranscriptStatus(db, v.video_id, "ERROR", String(e?.message || e), null);
      await sleep(250);
    }
  }

  return okCount;
}

async function setTranscriptStatus(db, videoId, status, error, lang) {
  await db
    .prepare(
      `UPDATE yt_videos
       SET transcript_status = ?,
           transcript_fetched_at = datetime('now'),
           transcript_lang = COALESCE(?, transcript_lang),
           error = ?
       WHERE video_id = ?`
    )
    .bind(status, lang, error, videoId)
    .run();
}

/**
 * Public transcript extraction (no OAuth):
 * 1) fetch watch HTML
 * 2) extract captionTracks
 * 3) download captions as JSON3 (fmt=srv3)
 * 4) convert to timestamped lines
 */
async function fetchTranscriptLines(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  const html = await fetchText(watchUrl, {
    "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
    "Accept-Language": "en-US,en;q=0.9",
  });

  const tracks = extractCaptionTracks(html);
  if (!tracks?.length) return [];

  const track =
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) || tracks[0];

  const base = track.baseUrl;
  const captionUrl = base.includes("fmt=") ? base : `${base}&fmt=srv3`;

  const captionBody = await fetchText(captionUrl, {
    "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
    "Accept-Language": "en-US,en;q=0.9",
  });

  try {
    const data = JSON.parse(captionBody);
    return json3ToLines(data);
  } catch {
    return [];
  }
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

function extractCaptionTracks(html) {
  const m = html.match(/"captionTracks":(\[.*?\])/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function json3ToLines(data) {
  const events = data?.events || [];
  const lines = [];

  for (const ev of events) {
    if (!ev?.segs?.length) continue;
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const start = (ev.tStartMs || 0) / 1000;
    const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;

    lines.push({ start, end, text });
  }

  return lines;
}

function chunkLines(lines, targetChars = 1100, overlapChars = 200) {
  const chunks = [];
  let buf = "";
  let start = null;
  let end = null;

  for (const ln of lines) {
    const piece = (buf ? " " : "") + ln.text;

    if (start === null) start = ln.start;
    end = ln.end;

    if (buf.length + piece.length < targetChars) {
      buf += piece;
      continue;
    }

    chunks.push({ start, end, text: buf.trim() });

    const overlap = buf.slice(Math.max(0, buf.length - overlapChars));
    buf = (overlap + " " + ln.text).trim();
    start = ln.start;
    end = ln.end;
  }

  if (buf.trim()) chunks.push({ start, end, text: buf.trim() });
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* =========================
   WORKER HANDLERS
   ========================= */

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

      // ✅ Browser-friendly manual trigger (GET)
      // Example: /api/yt/run-monthly?limit=5
      if (url.pathname === "/api/yt/run-monthly" && request.method === "GET") {
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") || "5", 10), 1),
          100
        );
        const result = await runYoutubeMonthlyJob(env, limit);
        return json(result);
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

        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") || "15", 10), 1),
          100
        );

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
          prevClose && Number.isFinite(prevClose) && prevClose !== 0
            ? (chg / prevClose) * 100
            : null;

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

  async scheduled(event, env, ctx) {
    const cron = event.cron || "";

    // DAILY (OHLCV/news)
    if (cron === DAILY_CRON) {
      console.log(`[CRON] Daily job: ${cron}`);
      ctx.waitUntil(refreshNewsForAll(env));
      return;
    }

    // MONTHLY (YouTube transcripts)
    if (cron === MONTHLY_YT_CRON) {
      console.log(`[CRON] Monthly YouTube job: ${cron}`);
      ctx.waitUntil(runYoutubeMonthlyJob(env, 20));
      return;
    }

    console.log(`[CRON] Unknown cron '${cron}' — no job executed.`);
  },
};
