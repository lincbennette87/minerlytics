// src/index.js
import { refreshNewsForAll } from "./news_cron.js";

/* =============================
   CRON SETTINGS
============================= */

const DAILY_CRON = "30 3 * * *";
const MONTHLY_YT_CRON = "0 4 1 * *";

/* =============================
   RESPONSE HELPERS
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
  return new Promise((r) => setTimeout(r, ms));
}

/* =============================
   SAFE FETCH WITH 429 BACKOFF
============================= */

function baseHeaders(extra = {}) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "*/*",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    ...extra,
  };
}

async function fetchText(url, extraHeaders = {}) {
  const maxAttempts = 5;

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(url, {
      headers: baseHeaders(extraHeaders),
      cf: { cacheTtl: 300, cacheEverything: false },
      redirect: "follow",
    });

    if (res.ok) return await res.text();

    if (res.status === 429) {
      const delay = 1000 * Math.pow(2, i - 1) + Math.random() * 800;
      await sleep(delay);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} for ${url}. BodyHead=${body.slice(0, 160)}`);
  }

  throw new Error(`Fetch failed 429 after ${maxAttempts} attempts for ${url}`);
}

// For captions: do NOT use cf caching; use stricter browser-ish headers
async function fetchTextNoCache(url, extraHeaders = {}) {
  const maxAttempts = 5;

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(url, {
      headers: baseHeaders(extraHeaders),
      redirect: "follow",
      // Intentionally omit cf caching here
    });

    if (res.ok) return await res.text();

    if (res.status === 429) {
      const delay = 1000 * Math.pow(2, i - 1) + Math.random() * 800;
      await sleep(delay);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Fetch failed ${res.status} for ${url}. BodyHead=${body.slice(0, 160)}`);
  }

  throw new Error(`Fetch failed 429 after ${maxAttempts} attempts for ${url}`);
}

/* =============================
   YOUTUBE TRANSCRIPT EXTRACTION
============================= */

function extractCaptionTracksSafe(html) {
  if (!html || html.length < 2000) return [];

  const pr = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (pr && pr[1]) {
    try {
      const player = JSON.parse(pr[1]);
      const tracks =
        player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      return Array.isArray(tracks) ? tracks : [];
    } catch {
      // fall through
    }
  }

  const m = html.match(/"captionTracks":(\[.*?\])/s);
  if (!m || !m[1]) return [];
  try {
    const tracks = JSON.parse(m[1]);
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

async function fetchTranscriptLines(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  const html = await fetchText(watchUrl, {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });

  const tracks = extractCaptionTracksSafe(html);
  if (!tracks.length) return [];

  const track =
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) || tracks[0];

  if (!track?.baseUrl) return [];

  const captionUrl = track.baseUrl.includes("fmt=")
    ? track.baseUrl
    : `${track.baseUrl}&fmt=json3`;

  // IMPORTANT: captions fetch with Referer/Origin/etc.
  const captionBody = await fetchTextNoCache(captionUrl, {
    "Referer": watchUrl,
    "Origin": "https://www.youtube.com",
    "Accept": "application/json,text/plain,*/*",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  });

  const trimmed = (captionBody || "").trim();

  // If YouTube returns empty 200, this will be empty
  if (!trimmed) return [];

  if (!trimmed.startsWith("{")) return [];

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const events = data?.events || [];
  const lines = [];

  for (const ev of events) {
    if (!ev?.segs?.length) continue;

    const txt = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (!txt) continue;

    const start = (ev.tStartMs || 0) / 1000;
    const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;

    lines.push({ start, end, text: txt });
  }

  return lines;
}

function chunkLines(lines, maxChars = 1100, overlap = 200) {
  const chunks = [];
  let buf = "";
  let start = null;
  let end = null;

  for (const ln of lines) {
    if (start === null) start = ln.start;
    end = ln.end;

    const piece = (buf ? " " : "") + ln.text;

    if ((buf + piece).length < maxChars) {
      buf += piece;
      continue;
    }

    chunks.push({ start, end, text: buf.trim() });

    const overlapText = buf.slice(-overlap);
    buf = (overlapText + " " + ln.text).trim();
    start = ln.start;
    end = ln.end;
  }

  if (buf.trim()) chunks.push({ start, end, text: buf.trim() });
  return chunks;
}

/* =============================
   YOUTUBE MONTHLY JOB
============================= */

async function markVideo(db, videoId, status, errorMsg) {
  await db
    .prepare(
      `UPDATE yt_videos
       SET transcript_status = ?,
           transcript_fetched_at = datetime('now'),
           error = ?
       WHERE video_id = ?`
    )
    .bind(status, errorMsg || null, videoId)
    .run();
}

async function runYoutubeMonthlyJob(env, limit = 1) {
  const db = env.DB;

  const { results: channels } = await db
    .prepare(`SELECT channel_id FROM yt_channels WHERE is_enabled = 1`)
    .all();

  if (!channels?.length) return { ok: true, channels: 0, processed: 0 };

  let processed = 0;

  for (const ch of channels) {
    const { results: vids } = await db
      .prepare(
        `SELECT video_id
         FROM yt_videos
         WHERE channel_id = ?
           AND (transcript_status IS NULL OR transcript_status='PENDING')
         ORDER BY published_at DESC
         LIMIT ?`
      )
      .bind(ch.channel_id, limit)
      .all();

    for (const v of vids) {
      try {
        await markVideo(db, v.video_id, "PENDING", null);

        const lines = await fetchTranscriptLines(v.video_id);

        if (!lines.length) {
          await markVideo(
            db,
            v.video_id,
            "NONE",
            "Caption fetch returned empty/non-JSON (common with YouTube + Cloudflare IPs) or no captions."
          );
          continue;
        }

        const chunks = chunkLines(lines);

        await db.prepare(`DELETE FROM yt_chunks WHERE video_id=?`).bind(v.video_id).run();

        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          await db
            .prepare(
              `INSERT INTO yt_chunks
               (video_id, chunk_index, start_sec, end_sec, text, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`
            )
            .bind(v.video_id, i, c.start, c.end, c.text)
            .run();
        }

        await markVideo(db, v.video_id, "OK", null);
        processed++;

        await sleep(1500 + Math.floor(Math.random() * 1000));
      } catch (e) {
        await markVideo(db, v.video_id, "ERROR", String(e?.message || e));
        await sleep(1500 + Math.floor(Math.random() * 1000));
      }
    }
  }

  return { ok: true, channels: channels.length, processed };
}

/* =============================
   DEBUG ENDPOINT
============================= */

async function debugVideo(env, videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl, {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });

  const tracks = extractCaptionTracksSafe(html);

  const track =
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) || tracks[0];

  const captionUrl =
    track?.baseUrl
      ? (track.baseUrl.includes("fmt=") ? track.baseUrl : `${track.baseUrl}&fmt=json3`)
      : null;

  let captionStatus = null;
  let captionHead = null;
  let captionLen = null;

  if (captionUrl) {
    try {
      const res = await fetch(captionUrl, {
        headers: baseHeaders({
          "Referer": watchUrl,
          "Origin": "https://www.youtube.com",
          "Accept": "application/json,text/plain,*/*",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        }),
        redirect: "follow",
      });

      captionStatus = res.status;
      const body = await res.text();
      captionLen = (body || "").length;
      captionHead = (body || "").slice(0, 260);
    } catch (e) {
      captionStatus = "FETCH_ERROR";
      captionHead = String(e?.message || e);
      captionLen = null;
    }
  }

  return {
    videoId,
    html_len: html?.length || 0,
    tracks_found: tracks.length,
    languages: tracks.map((t) => t.languageCode).slice(0, 12),
    has_baseUrl: tracks.some((t) => !!t.baseUrl),
    caption_url_present: !!captionUrl,
    caption_status: captionStatus,
    caption_len: captionLen,
    caption_body_head: captionHead,
    html_head: (html || "").slice(0, 200),
  };
}

/* =============================
   WORKER ENTRYPOINT
============================= */

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") return options();

      if (url.pathname === "/api/health") {
        return text("Minerlytics Worker running ✅");
      }

      // Browser trigger for YouTube job
      // Example: /api/yt/run-monthly?limit=1
      if (url.pathname === "/api/yt/run-monthly") {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "1", 10), 1), 25);
        const result = await runYoutubeMonthlyJob(env, limit);
        return json(result);
      }

      // Debug a specific video
      // Example: /api/yt/debug?video_id=2yr-KAO3XWw
      if (url.pathname === "/api/yt/debug") {
        const videoId = String(url.searchParams.get("video_id") || "").trim();
        if (!videoId) return json({ error: "missing video_id" }, 400);
        const out = await debugVideo(env, videoId);
        return json(out);
      }

      return new Response("Not found", { status: 404, headers: CORS });
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
      return;
    }

    if (event.cron === MONTHLY_YT_CRON) {
      ctx.waitUntil(runYoutubeMonthlyJob(env, 1));
      return;
    }

    console.log(`[CRON] Unknown cron '${event.cron}' — no job executed.`);
  },
};
