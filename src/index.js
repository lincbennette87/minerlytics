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
   + (NEW) header override support
============================= */

async function fetchText(url, extraHeaders = {}) {
  const maxAttempts = 5;

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "*/*",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        // Helps avoid odd compression issues in some runtimes
        "Accept-Encoding": "identity",
        ...extraHeaders,
      },
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
    throw new Error(
      `Fetch failed ${res.status} for ${url}. BodyHead=${body.slice(0, 160)}`
    );
  }

  throw new Error(`Fetch failed 429 after ${maxAttempts} attempts for ${url}`);
}

/* =============================
   YOUTUBE TRANSCRIPT EXTRACTION
============================= */

/**
 * SAFELY extract caption tracks.
 * Never throws, returns [] when missing or blocked.
 */
function extractCaptionTracksSafe(html) {
  if (!html || html.length < 2000) return [];

  // Preferred: ytInitialPlayerResponse
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

  // Fallback: captionTracks regex (guarded)
  const m = html.match(/"captionTracks":(\[.*?\])/s);
  if (!m || !m[1]) return [];
  try {
    const tracks = JSON.parse(m[1]);
    return Array.isArray(tracks) ? tracks : [];
  } catch {
    return [];
  }
}

/**
 * Decode common HTML/XML entities found in captions.
 */
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Parse transcript from JSON3 captions body.
 */
function parseJson3ToLines(body) {
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

/**
 * Parse transcript from XML captions body.
 * Example:
 * <transcript><text start="0.0" dur="2.0">Hello</text>...</transcript>
 */
function parseXmlToLines(xml) {
  const s = (xml || "").trim();
  if (!s) return [];

  // Quick guard: should look like XML
  if (!s.startsWith("<")) return [];

  const matches = [...s.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)];
  if (!matches.length) return [];

  const lines = [];
  for (const m of matches) {
    const attrs = m[1] || "";
    const raw = m[2] || "";

    const startMatch = attrs.match(/\bstart="([^"]+)"/);
    const durMatch = attrs.match(/\bdur="([^"]+)"/);

    const start = startMatch ? parseFloat(startMatch[1]) : 0;
    const dur = durMatch ? parseFloat(durMatch[1]) : 0;
    const end = start + (Number.isFinite(dur) ? dur : 0);

    const txt = decodeEntities(raw)
      .replace(/\s+/g, " ")
      .trim();

    if (!txt) continue;
    lines.push({ start, end, text: txt });
  }

  return lines;
}

/**
 * Fetch transcript lines from a public YouTube video.
 * Strategy:
 * 1) Try fmt=json3 first
 * 2) If that fails or returns non-JSON, fall back to XML baseUrl
 */
async function fetchTranscriptLines(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl);

  const tracks = extractCaptionTracksSafe(html);
  if (!tracks.length) return [];

  const track =
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) || tracks[0];

  if (!track?.baseUrl) return [];

  // 1) Try JSON3
  const json3Url = track.baseUrl.includes("fmt=")
    ? track.baseUrl.replace(/fmt=[^&]+/i, "fmt=json3")
    : `${track.baseUrl}&fmt=json3`;

  const json3Body = await fetchText(json3Url, {
    Accept: "application/json,text/plain,*/*",
  });

  const json3Lines = parseJson3ToLines(json3Body);
  if (json3Lines.length) return json3Lines;

  // 2) Fallback to XML (no fmt or explicit fmt=srv3 works too)
  // Keep it simple: call the original baseUrl as-is
  const xmlBody = await fetchText(track.baseUrl, {
    Accept: "text/xml,application/xml;q=0.9,*/*;q=0.8",
  });

  const xmlLines = parseXmlToLines(xmlBody);
  return xmlLines;
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
            "No captionTracks or empty transcript (blocked, unavailable, or empty JSON/XML caption response)"
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
   - Shows if captionTracks exist
   - Fetches BOTH json3 + xml and reports status + body heads
============================= */

async function debugVideo(env, videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl);
  const tracks = extractCaptionTracksSafe(html);

  const track =
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) || tracks[0];

  const baseUrl = track?.baseUrl || null;

  const json3Url =
    baseUrl
      ? (baseUrl.includes("fmt=")
          ? baseUrl.replace(/fmt=[^&]+/i, "fmt=json3")
          : `${baseUrl}&fmt=json3`)
      : null;

  let json3Status = null;
  let json3Head = null;
  let xmlStatus = null;
  let xmlHead = null;

  if (json3Url) {
    try {
      const res = await fetch(json3Url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "application/json,text/plain,*/*",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Accept-Encoding": "identity",
        },
        redirect: "follow",
      });
      json3Status = res.status;
      const body = await res.text();
      json3Head = (body || "").slice(0, 260);
    } catch (e) {
      json3Status = "FETCH_ERROR";
      json3Head = String(e?.message || e);
    }
  }

  if (baseUrl) {
    try {
      const res = await fetch(baseUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/xml,application/xml;q=0.9,*/*;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Accept-Encoding": "identity",
        },
        redirect: "follow",
      });
      xmlStatus = res.status;
      const body = await res.text();
      xmlHead = (body || "").slice(0, 260);
    } catch (e) {
      xmlStatus = "FETCH_ERROR";
      xmlHead = String(e?.message || e);
    }
  }

  return {
    videoId,
    html_len: html?.length || 0,
    tracks_found: tracks.length,
    languages: tracks.map((t) => t.languageCode).slice(0, 12),
    has_baseUrl: tracks.some((t) => !!t.baseUrl),

    base_url_present: !!baseUrl,
    json3_url_present: !!json3Url,

    json3_status: json3Status,
    json3_body_head: json3Head,

    xml_status: xmlStatus,
    xml_body_head: xmlHead,

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
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") || "1", 10), 1),
          25
        );
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
    // Daily cron (your existing job)
    if (event.cron === DAILY_CRON) {
      ctx.waitUntil(refreshNewsForAll(env));
      return;
    }

    // Monthly cron (YouTube transcripts)
    if (event.cron === MONTHLY_YT_CRON) {
      ctx.waitUntil(runYoutubeMonthlyJob(env, 1));
      return;
    }

    console.log(`[CRON] Unknown cron '${event.cron}' — no job executed.`);
  },
};
