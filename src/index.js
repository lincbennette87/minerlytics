import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";

/* =============================
   CRON SETTINGS
============================= */

const DAILY_CRON = "30 3 * * *";
const MONTHLY_YT_CRON = "0 4 1 * *";

/* =============================
   HELPERS
============================= */

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =============================
   429-SAFE FETCH
============================= */

async function fetchText(url, headers = {}) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        ...headers,
      },
      cf: { cacheTtl: 300, cacheEverything: false },
    });

    if (res.ok) return await res.text();

    if (res.status === 429) {
      const baseDelay = 1000 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 800);
      await sleep(baseDelay + jitter);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} for ${url}. ${body.slice(0, 120)}`);
  }

  throw new Error(`Fetch failed 429 after ${maxAttempts} attempts for ${url}`);
}

/* =============================
   YOUTUBE TRANSCRIPT PIPELINE
============================= */

async function runYoutubeMonthlyJob(env, limit = 5) {
  const db = env.DB;

  const { results: channels } = await db
    .prepare(`SELECT channel_id FROM yt_channels WHERE is_enabled = 1`)
    .all();

  if (!channels?.length) return { ok: true, channels: 0, processed: 0 };

  let processed = 0;

  for (const ch of channels) {
    const n = await processPendingTranscripts(env, ch.channel_id, limit);
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
      `SELECT video_id
       FROM yt_videos
       WHERE channel_id = ?
         AND (transcript_status IS NULL OR transcript_status = 'PENDING')
       ORDER BY published_at DESC
       LIMIT ?`
    )
    .bind(channelId, limit)
    .all();

  if (!vids?.length) return 0;

  let okCount = 0;

  for (const v of vids) {
    try {
      await setTranscriptStatus(db, v.video_id, "PENDING", null);

      const lines = await fetchTranscriptLines(v.video_id);

      if (!lines.length) {
        await setTranscriptStatus(db, v.video_id, "NONE", "No captions found");
        continue;
      }

      const chunks = chunkLines(lines);

      await db.prepare(`DELETE FROM yt_chunks WHERE video_id = ?`)
        .bind(v.video_id)
        .run();

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await db.prepare(
          `INSERT INTO yt_chunks
           (video_id, chunk_index, start_sec, end_sec, text, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(v.video_id, i, c.start, c.end, c.text)
        .run();
      }

      await setTranscriptStatus(db, v.video_id, "OK", null);
      okCount++;

      await sleep(1500 + Math.floor(Math.random() * 1000));
    } catch (e) {
      await setTranscriptStatus(db, v.video_id, "ERROR", e.message);
    }
  }

  return okCount;
}

async function setTranscriptStatus(db, videoId, status, error) {
  await db.prepare(
    `UPDATE yt_videos
     SET transcript_status = ?,
         transcript_fetched_at = datetime('now'),
         error = ?
     WHERE video_id = ?`
  )
  .bind(status, error, videoId)
  .run();
}

async function fetchTranscriptLines(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetchText(watchUrl);

  const match = html.match(/"captionTracks":(\[.*?\])/s);
  if (!match) return [];

  const tracks = JSON.parse(match[1]);
  const track = tracks.find(t => t.languageCode?.startsWith("en")) || tracks[0];
  if (!track?.baseUrl) return [];

  const captionUrl = track.baseUrl.includes("fmt=")
    ? track.baseUrl
    : `${track.baseUrl}&fmt=srv3`;

  const captionBody = await fetchText(captionUrl);
  const data = JSON.parse(captionBody);

  return (data.events || [])
    .filter(e => e.segs?.length)
    .map(e => ({
      start: (e.tStartMs || 0) / 1000,
      end: ((e.tStartMs || 0) + (e.dDurationMs || 0)) / 1000,
      text: e.segs.map(s => s.utf8).join("").trim(),
    }));
}

function chunkLines(lines, maxChars = 1100, overlap = 200) {
  const chunks = [];
  let buffer = "";
  let start = null;
  let end = null;

  for (const ln of lines) {
    if (start === null) start = ln.start;
    end = ln.end;

    const addition = (buffer ? " " : "") + ln.text;

    if ((buffer + addition).length < maxChars) {
      buffer += addition;
      continue;
    }

    chunks.push({ start, end, text: buffer });

    const overlapText = buffer.slice(-overlap);
    buffer = overlapText + " " + ln.text;
    start = ln.start;
  }

  if (buffer.trim()) chunks.push({ start, end, text: buffer.trim() });
  return chunks;
}

/* =============================
   MAIN WORKER HANDLER
============================= */

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return options();

      if (url.pathname === "/api/health") {
        return text("Minerlytics is running ✅");
      }

      // Manual browser test
      if (url.pathname === "/api/yt/run-monthly") {
        const limit = parseInt(url.searchParams.get("limit") || "3", 10);
        const result = await runYoutubeMonthlyJob(env, limit);
        return json(result);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response(err.stack || err.message, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
      });
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_CRON) {
      ctx.waitUntil(refreshNewsForAll(env));
    }

    if (event.cron === MONTHLY_YT_CRON) {
      ctx.waitUntil(runYoutubeMonthlyJob(env, 5));
    }
  },
};
