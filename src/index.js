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

async function fetchText(url) {
  const maxAttempts = 5;

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
    });

    if (res.ok) return await res.text();

    if (res.status === 429) {
      const delay = 1000 * Math.pow(2, i - 1) + Math.random() * 800;
      await sleep(delay);
      continue;
    }

    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  throw new Error(`Fetch failed 429 after ${maxAttempts} attempts`);
}

/* =============================
   YOUTUBE TRANSCRIPT EXTRACTION
============================= */

/**
 * SAFELY extract caption tracks
 * Never throws, never crashes
 */
function extractCaptionTracksSafe(html) {
  if (!html || html.length < 2000) return [];

  // Preferred: ytInitialPlayerResponse (more stable)
  const pr = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (pr && pr[1]) {
    try {
      const player = JSON.parse(pr[1]);
      const tracks =
        player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks)) return tracks;
    } catch {
      // fallthrough
    }
  }

  // Fallback: captionTracks regex
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
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const html = await fetchText(watchUrl);

  const tracks = extractCaptionTracksSafe(html);
  if (!tracks.length) return [];

  const track =
    tracks.find((t) => t.languageCode?.startsWith("en")) || tracks[0];

  if (!track?.baseUrl) return [];

  const captionUrl = track.baseUrl.includes("fmt=")
    ? track.baseUrl
    : `${track.baseUrl}&fmt=srv3`;

  const body = await fetchText(captionUrl);
  const trimmed = (body || "").trim();

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

    const text = ev.segs.map((s) => s.utf8 || "").join("").trim();
    if (!text) continue;

    const start = (ev.tStartMs || 0) / 1000;
    const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;

    lines.push({ start, end, text });
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
    buf = buf.slice(-overlap) + " " + ln.text;
    start = ln.start;
  }

  if (buf.trim()) chunks.push({ start, end, text: buf.trim() });
  return chunks;
}

/* =============================
   YOUTUBE MONTHLY JOB
============================= */

async function runYoutubeMonthlyJob(env, limit = 1) {
  const db = env.DB;

  const { results: channels } = await db
    .prepare(`SELECT channel_id FROM yt_channels WHERE is_enabled = 1`)
    .all();

  let processed = 0;

  for (const ch of channels) {
    const { results: vids } = await db
      .prepare(
        `SELECT video_id FROM yt_videos
         WHERE channel_id = ?
           AND (transcript_status IS NULL OR transcript_status='PENDING')
         LIMIT ?`
      )
      .bind(ch.channel_id, limit)
      .all();

    for (const v of vids) {
      try {
        const lines = await fetchTranscriptLines(v.video_id);

        if (!lines.length) {
          await db.prepare(
            `UPDATE yt_videos SET transcript_status='NONE' WHERE video_id=?`
          ).bind(v.video_id).run();
          continue;
        }

        const chunks = chunkLines(lines);

        await db.prepare(`DELETE FROM yt_chunks WHERE video_id=?`)
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

        await db.prepare(
          `UPDATE yt_videos SET transcript_status='OK' WHERE video_id=?`
        ).bind(v.video_id).run();

        processed++;
        await sleep(1500 + Math.random() * 800);

      } catch (e) {
        await db.prepare(
          `UPDATE yt_videos SET transcript_status='ERROR', error=? WHERE video_id=?`
        ).bind(String(e.message), v.video_id).run();
      }
    }
  }

  return { ok: true, channels: channels.length, processed };
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

      // Browser trigger
      if (url.pathname === "/api/yt/run-monthly") {
        const limit = parseInt(url.searchParams.get("limit") || "1", 10);
        const result = await runYoutubeMonthlyJob(env, limit);
        return json(result);
      }

      return new Response("Not found", { status: 404, headers: CORS });

    } catch (err) {
      return new Response(
        err.stack || err.message,
        { status: 500, headers: { "content-type": "text/plain", ...CORS } }
      );
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_CRON) {
      ctx.waitUntil(refreshNewsForAll(env));
    }

    if (event.cron === MONTHLY_YT_CRON) {
      ctx.waitUntil(runYoutubeMonthlyJob(env, 1));
    }
  },
};
