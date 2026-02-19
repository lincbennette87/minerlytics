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

async function fetchText(url, extraHeaders = {}) {
  const maxAttempts = 5;

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Accept-Encoding": "identity",
        ...extraHeaders,
      },
      cf: { cacheTtl: 0, cacheEverything: false },
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

async function fetchBytes(url, extraHeaders = {}) {
  const maxAttempts = 5;

  for (let i = 1; i <= maxAttempts; i++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Accept-Encoding": "identity",
        ...extraHeaders,
      },
      cf: { cacheTtl: 0, cacheEverything: false },
      redirect: "follow",
    });

    if (res.ok) {
      const buf = await res.arrayBuffer();
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        contentLength: res.headers.get("content-length"),
        byteLen: buf.byteLength,
        text: new TextDecoder("utf-8").decode(buf),
      };
    }

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
 * NEW: pull Innertube API key + client context + transcript params
 * from the watch HTML.
 */
function extractInnertubeKey(html) {
  const m = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  return m ? m[1] : null;
}

function extractInnertubeClient(html) {
  const name =
    html.match(/"INNERTUBE_CONTEXT_CLIENT_NAME":\s*([0-9]+)/)?.[1] || "1";
  const ver =
    html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
    "2.20240201.00.00";
  return { clientName: Number(name), clientVersion: ver };
}

function extractTranscriptParams(html) {
  const m = html.match(/"getTranscriptEndpoint":\{"params":"([^"]+)"\}/);
  return m ? m[1] : null;
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
 */
function parseXmlToLines(xml) {
  const s = (xml || "").trim();
  if (!s || !s.startsWith("<")) return [];

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

    const txt = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (!txt) continue;

    lines.push({ start, end, text: txt });
  }

  return lines;
}

/**
 * Parse WebVTT captions into lines.
 */
function parseVttToLines(vtt) {
  const s = (vtt || "").replace(/\r/g, "").trim();
  if (!s.startsWith("WEBVTT")) return [];

  const lines = [];
  const blocks = s.split("\n\n");

  function toSeconds(ts) {
    const parts = ts.split(":").map((p) => p.trim());
    let h = 0,
      m = 0,
      sec = 0;

    if (parts.length === 3) {
      h = Number(parts[0]);
      m = Number(parts[1]);
      sec = Number(parts[2]);
    } else {
      m = Number(parts[0]);
      sec = Number(parts[1]);
    }

    const [sPart, msPart] = String(sec).split(".");
    const sNum = Number(sPart);
    const msNum = msPart ? Number(msPart.padEnd(3, "0")) : 0;
    return h * 3600 + m * 60 + sNum + msNum / 1000;
  }

  for (const b of blocks) {
    const rows = b.split("\n").filter(Boolean);
    if (rows.length < 2) continue;

    const timeRow = rows.find((r) => r.includes("-->"));
    if (!timeRow) continue;

    const [a, b2] = timeRow.split("-->").map((x) => x.trim());
    const start = toSeconds(a);
    const end = toSeconds(b2.split(" ")[0].trim());

    const textRows = rows
      .filter((r) => !r.includes("-->") && !/^\d+$/.test(r))
      .map((r) => r.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);

    const txt = decodeEntities(textRows.join(" ")).replace(/\s+/g, " ").trim();
    if (!txt) continue;

    lines.push({ start, end, text: txt });
  }

  return lines;
}

/**
 * NEW: Try to fetch transcript via YouTube Innertube API.
 * This can sometimes work when timedtext (json3/xml/vtt) returns 0 bytes on Workers.
 */
async function fetchTranscriptViaInnertube(videoId, html) {
  const apiKey = extractInnertubeKey(html);
  const params = extractTranscriptParams(html);
  const { clientName, clientVersion } = extractInnertubeClient(html);

  if (!apiKey || !params) return [];

  const endpoint = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(
    apiKey
  )}`;

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  const payload = {
    context: {
      client: {
        clientName,
        clientVersion,
        hl: "en",
        gl: "US",
      },
    },
    params,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (compatible; minerlytics-yt/1.0)",
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://www.youtube.com",
      referer: watchUrl,
      "accept-encoding": "identity",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok || !body) return [];

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }

  const cueGroups =
    data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer
      ?.body?.transcriptBodyRenderer?.cueGroups || [];

  const lines = [];

  for (const g of cueGroups) {
    const cues = g?.transcriptCueGroupRenderer?.cues || [];
    for (const c of cues) {
      const cue = c?.transcriptCueRenderer;
      const start = Number(cue?.startOffsetMs || 0) / 1000;
      const dur = Number(cue?.durationMs || 0) / 1000;
      const end = start + dur;

      const runs = cue?.cue?.runs || [];
      const txt = runs
        .map((r) => r?.text || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();

      if (txt) lines.push({ start, end, text: txt });
    }
  }

  return lines;
}

/**
 * Fetch transcript lines from a public YouTube video.
 * Strategy:
 * 0) NEW: Innertube transcript API
 * 1) Try fmt=json3
 * 2) Fallback to XML
 * 3) Fallback to fmt=vtt
 */
async function fetchTranscriptLines(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const html = await fetchText(watchUrl);

  // NEW: Innertube attempt first
  const innertubeLines = await fetchTranscriptViaInnertube(videoId, html);
  if (innertubeLines.length) return innertubeLines;

  const tracks = extractCaptionTracksSafe(html);
  if (!tracks.length) return [];

  const track =
    tracks.find((t) => String(t.languageCode || "").startsWith("en")) || tracks[0];

  if (!track?.baseUrl) return [];

  const commonHeaders = {
    Referer: watchUrl,
    Origin: "https://www.youtube.com",
  };

  // JSON3
  const json3Url = track.baseUrl.includes("fmt=")
    ? track.baseUrl.replace(/fmt=[^&]+/i, "fmt=json3")
    : `${track.baseUrl}&fmt=json3`;

  const json3Body = await fetchText(json3Url, {
    Accept: "application/json,text/plain,*/*",
    ...commonHeaders,
  });

  const json3Lines = parseJson3ToLines(json3Body);
  if (json3Lines.length) return json3Lines;

  // XML
  const xmlBody = await fetchText(track.baseUrl, {
    Accept: "text/xml,application/xml;q=0.9,*/*;q=0.8",
    ...commonHeaders,
  });

  const xmlLines = parseXmlToLines(xmlBody);
  if (xmlLines.length) return xmlLines;

  // VTT
  const vttUrl = track.baseUrl.includes("fmt=")
    ? track.baseUrl.replace(/fmt=[^&]+/i, "fmt=vtt")
    : `${track.baseUrl}&fmt=vtt`;

  const vttBody = await fetchText(vttUrl, {
    Accept: "text/vtt,text/plain,*/*",
    ...commonHeaders,
  });

  const vttLines = parseVttToLines(vttBody);
  return vttLines;
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
            "Empty transcript: innertube + json3/xml/vtt returned empty (YouTube gating likely)"
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

  const vttUrl =
    baseUrl
      ? (baseUrl.includes("fmt=")
          ? baseUrl.replace(/fmt=[^&]+/i, "fmt=vtt")
          : `${baseUrl}&fmt=vtt`)
      : null;

  const innertube_key_present = !!extractInnertubeKey(html);
  const innertube_params_present = !!extractTranscriptParams(html);

  let innertube_try_len = null;
  try {
    const lines = await fetchTranscriptViaInnertube(videoId, html);
    innertube_try_len = lines.length;
  } catch {
    innertube_try_len = "ERROR";
  }

  const commonHeaders = {
    Referer: watchUrl,
    Origin: "https://www.youtube.com",
  };

  let json3 = null;
  let xml = null;
  let vtt = null;

  if (json3Url) {
    try {
      json3 = await fetchBytes(json3Url, {
        Accept: "application/json,*/*",
        ...commonHeaders,
      });
    } catch (e) {
      json3 = { status: "FETCH_ERROR", byteLen: null, text: String(e?.message || e) };
    }
  }

  if (baseUrl) {
    try {
      xml = await fetchBytes(baseUrl, {
        Accept: "text/xml,*/*",
        ...commonHeaders,
      });
    } catch (e) {
      xml = { status: "FETCH_ERROR", byteLen: null, text: String(e?.message || e) };
    }
  }

  if (vttUrl) {
    try {
      vtt = await fetchBytes(vttUrl, {
        Accept: "text/vtt,text/plain,*/*",
        ...commonHeaders,
      });
    } catch (e) {
      vtt = { status: "FETCH_ERROR", byteLen: null, text: String(e?.message || e) };
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
    vtt_url_present: !!vttUrl,

    innertube_key_present,
    innertube_params_present,
    innertube_lines_found: innertube_try_len,

    json3_status: json3?.status ?? null,
    json3_len: json3?.byteLen ?? null,
    json3_body_head: (json3?.text || "").slice(0, 180),

    xml_status: xml?.status ?? null,
    xml_len: xml?.byteLen ?? null,
    xml_body_head: (xml?.text || "").slice(0, 180),

    vtt_status: vtt?.status ?? null,
    vtt_len: vtt?.byteLen ?? null,
    vtt_body_head: (vtt?.text || "").slice(0, 180),

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
      // Example: /api/yt/debug?video_id=cUXL6Yf9c6I
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
