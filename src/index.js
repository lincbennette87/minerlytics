import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";
import { handleEducationPortalChat, educationOptions } from "./educationPortalChat.js";

const WORKERS_AI_CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// =========================
// 🔐 SIMPLE AUTH HELPERS
// =========================

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function formatEmailName(email = "") {
  const local = String(email || "").split("@")[0] || "";
  return local
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

function buildUserDisplayName(user = {}) {
  const firstName = String(user.first_name || "").trim();
  const lastName = String(user.last_name || "").trim();
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;
  return formatEmailName(user.email || "") || "Minerlytics User";
}

function makeSessionCookie(sessionId) {
  return `minerlytics_session=${sessionId}; Path=/; Secure; SameSite=None; HttpOnly; Max-Age=${60 * 60 * 24 * 30}`;
}

async function sendSignupNotification(env, payload) {
  const webhookUrl = String(env.SIGNUP_NOTIFICATION_WEBHOOK_URL || "").trim();
  if (!webhookUrl) return { ok: false, skipped: true, reason: "missing_webhook" };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      return { ok: false, skipped: false, status: res.status };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, skipped: false, error: String(err) };
  }
}



/* ============================
   YouTube Configuration
   ============================ */
const YOUTUBE = {
  CHANNELS: [
    {
      handleUrl: "https://www.youtube.com/@kitco",
      channelId: "UCzH5n3I2P5J8R9H0pE0hL5A",
      name: "Kitco News",
      symbols: ["GOLD", "SILVER"],
    },
    {
      name: "Kitco Mining",
      query: "Kitco Mining",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Metals Investor Forum",
      query: "Metals Investor Forum",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Commodity Culture",
      query: "Commodity Culture",
      symbols: ["GOLD", "SILVER", "MACRO"],
    },
    {
      name: "Sprott Money",
      query: "Sprott Money",
      symbols: ["GOLD", "SILVER", "MACRO"],
    },
    {
      name: "Mining Stocks Today",
      query: "Mining Stocks Today",
      symbols: ["MINERS"],
    },
    {
      name: "Sprott",
      query: "Sprott",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Rule Investment Media",
      query: "Rule Investment Media",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Don Durrett",
      query: "Don Durrett",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Mining Stock Education",
      query: "Mining Stock Education",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Mining Stock Monkey",
      query: "Mining Stock Monkey",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Crux Investor",
      query: "Crux Investor",
      symbols: ["GOLD", "SILVER", "MINERS"],
    },
    {
      name: "Jay Martin Show",
      query: "Jay Martin Show",
      symbols: ["GOLD", "SILVER", "MACRO"],
    },
    {
      name: "Liberty and Finance",
      query: "Liberty and Finance",
      symbols: ["GOLD", "SILVER", "MACRO"],
    },
    {
      name: "Wealtheon",
      query: "Wealtheon",
      symbols: ["GOLD", "SILVER", "MACRO"],
    },
  ],
  MAX_VIDEOS_PER_RUN: 200,
  TRANSCRIPT_LANGUAGE_PREFERENCE: ["en"],
};

/* ============================
   Cron constants
   ============================ */
const DAILY_CRON = "30 3 * * *";
const MONTHLY_YT_CRON = "0 4 1 * *";

const ALLOWED_ORIGINS = [
  "https://minerlytics.pages.dev",
  "https://minerlyticsai.com"
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "access-control-allow-origin": ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "https://minerlyticsai.com",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-credentials": "true"
  };
}

function json(data, status = 200, extraHeaders = {}, request) {
  const corsHeaders = request && request.headers
    ? getCorsHeaders(request)
    : {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-credentials": "true"
      };

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders,
      ...extraHeaders
    }
  });
}

function text(data, status = 200, request) {
  const corsHeaders = request && request.headers
    ? getCorsHeaders(request)
    : {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-credentials": "true"
      };

  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...corsHeaders
    },
  });
}
function options(request) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request)
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeSymbolToStooqUS(raw) {
  let symbol = String(raw || "").trim().toLowerCase();
  if (!symbol) return "";
  if (!symbol.endsWith(".us")) symbol += ".us";
  return symbol;
}

function getSymbolCandidates(raw) {
  const ticker = symbolToTicker(raw) || String(raw || "").toUpperCase().trim();
  const lowerTicker = ticker.toLowerCase();
  const normalized = normalizeSymbolToStooqUS(ticker);
  return Array.from(new Set([
    normalized,
    lowerTicker,
    ticker,
  ].filter(Boolean)));
}

function symbolToTicker(symbol) {
  return String(symbol || "").replace(/\.us$/i, "").toUpperCase().trim();
}

function parseSymbolsParam(param) {
  return String(param || "")
    .split(",")
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
}

function safeJsonParseArray(maybeJson) {
  try {
    const v = JSON.parse(maybeJson || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function relTime(isoOrDate) {
  const d = new Date(isoOrDate);
  const t = d.getTime();
  if (!Number.isFinite(t)) return "recent";
  const diffMs = Date.now() - t;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function normalizeLooseText(s = "") {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s&.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTickerAliasMap() {
  const map = {};

  for (const [tickerRaw, meta] of Object.entries(TICKERS || {})) {
    const ticker = String(tickerRaw || "").toUpperCase().trim();
    if (!ticker) continue;

    const aliases = new Set();
    aliases.add(ticker);

    if (meta && typeof meta === "object") {
      if (meta.name) aliases.add(String(meta.name));
      if (meta.company) aliases.add(String(meta.company));
      if (meta.label) aliases.add(String(meta.label));
      if (meta.q) aliases.add(String(meta.q));

      if (Array.isArray(meta.aliases)) {
        for (const a of meta.aliases) {
          if (a) aliases.add(String(a));
        }
      }
    }

    map[ticker] = Array.from(aliases)
      .map((x) => normalizeLooseText(x))
      .filter(Boolean);
  }

  return map;
}

const TICKER_ALIAS_MAP = buildTickerAliasMap();

const ANALYSIS_META_OVERRIDES = {
  AEM: { country: "Canada", stage: "producer" },
  NEM: { country: "USA", stage: "producer" },
  GOLD: { country: "Canada", stage: "producer" },
  KGC: { country: "Canada", stage: "producer" },
  GFI: { country: "South Africa", stage: "producer" },
  AU: { country: "UK", stage: "producer" },
  BTG: { country: "Canada", stage: "producer" },
  AGI: { country: "Canada", stage: "producer" },
  PZG: { country: "USA", stage: "developer" },
  GAYMF: { country: "Botswana", stage: "producer" },
  HYMC: { country: "USA", stage: "developer" },
  WPM: { country: "Canada", stage: "royalty" },
  PAAS: { country: "Canada", stage: "producer" },
  AG: { country: "Mexico", stage: "producer" },
  MAG: { country: "Mexico", stage: "developer" },
  HL: { country: "USA", stage: "producer" },
  CDE: { country: "Mexico", stage: "producer" },
  EXK: { country: "Mexico", stage: "producer" },
  SVM: { country: "China", stage: "producer" },
  SILV: { country: "Mexico", stage: "developer" },
  DSVSF: { country: "Mexico", stage: "developer" },
  FCX: { country: "USA", stage: "producer" },
  SCCO: { country: "Peru", stage: "producer" },
  HBM: { country: "Canada", stage: "producer" },
  TECK: { country: "Canada", stage: "producer" },
  TRQ: { country: "Mongolia", stage: "developer" },
  TGB: { country: "Canada", stage: "producer" },
  LUCRF: { country: "Botswana", stage: "producer" },
  MPVDF: { country: "Canada", stage: "producer" },
  NGLOY: { country: "UK", stage: "producer" },
  RIO: { country: "Australia", stage: "producer" },
  OR: { country: "Canada", stage: "royalty" },
  FNV: { country: "Canada", stage: "royalty" },
  RGLD: { country: "USA", stage: "royalty" },
  PSLV: { country: "Canada", stage: "trust" },
  SLV: { country: "USA", stage: "etf" },
  SIVR: { country: "USA", stage: "etf" },
  EGO: { country: "Canada", stage: "producer" },
  IAG: { country: "Canada", stage: "producer" },
  SSRM: { country: "Canada", stage: "producer" },
  CPG: { country: "UK", stage: "producer" },
  DRD: { country: "South Africa", stage: "producer" },
  LUG: { country: "Canada", stage: "producer" },
  EQX: { country: "Canada", stage: "producer" },
  NGD: { country: "Canada", stage: "producer" },
  CGAU: { country: "Canada", stage: "producer" },
  ORLA: { country: "Canada", stage: "developer" },
  EDVMF: { country: "UK", stage: "producer" },
  FSM: { country: "Canada", stage: "producer" },
  SAND: { country: "Canada", stage: "royalty" },
  GATO: { country: "USA", stage: "producer" },
  MUX: { country: "USA", stage: "producer" },
  AYASF: { country: "Canada", stage: "developer" },
  SKE: { country: "Canada", stage: "developer" },
  BHP: { country: "Australia", stage: "producer" },
  GLNCY: { country: "UK", stage: "producer" },
  VALE: { country: "Brazil", stage: "producer" },
  FQVLF: { country: "Canada", stage: "producer" },
  IVPAF: { country: "Canada", stage: "developer" },
  CSFFF: { country: "Canada", stage: "producer" },
  LUNMF: { country: "Canada", stage: "producer" },
  ANFGF: { country: "Chile", stage: "producer" },
  TMQ: { country: "USA", stage: "developer" },
  CCJ: { country: "Canada", stage: "producer" },
  NXE: { country: "Canada", stage: "developer" },
  UEC: { country: "USA", stage: "producer" },
  DNN: { country: "Canada", stage: "developer" },
  UUUU: { country: "USA", stage: "producer" },
  PALAF: { country: "Australia", stage: "producer" },
  SQM: { country: "Chile", stage: "producer" },
  LAC: { country: "Canada", stage: "developer" },
  LAAC: { country: "Canada", stage: "developer" },
  SGML: { country: "Canada", stage: "developer" },
  PILBF: { country: "Australia", stage: "developer" },
  ALB: { country: "USA", stage: "producer" },
  MP: { country: "USA", stage: "producer" },
  LYSCF: { country: "Australia", stage: "producer" },
  SBSW: { country: "South Africa", stage: "producer" },
  IMPUY: { country: "South Africa", stage: "producer" },
  GDX: { country: "USA", stage: "etf" },
  GDXJ: { country: "USA", stage: "etf" },
  COPX: { country: "USA", stage: "etf" },
  PICK: { country: "USA", stage: "etf" },
  URNM: { country: "USA", stage: "etf" },
};

function buildAnalysisUniverse() {
  return Object.entries(TICKERS).map(([ticker, meta]) => {
    const override = ANALYSIS_META_OVERRIDES[ticker] || {};
    const metal = String(override.metal || meta?.metal || "other").toLowerCase().trim();
    const stage = String(override.stage || meta?.type || "company").toLowerCase().trim();
    const country = String(override.country || meta?.country || "Unknown").trim();

    return {
      ticker,
      metal,
      stage,
      country,
    };
  });
}

const ANALYSIS_UNIVERSE = buildAnalysisUniverse();

function resolveTickerFromQuestion(question) {
  const raw = String(question || "").trim();
  if (!raw) return null;

  const upperRaw = raw.toUpperCase();

  for (const ticker of Object.keys(TICKER_ALIAS_MAP)) {
    const re = new RegExp(`\\b${ticker}\\b`, "i");
    if (re.test(upperRaw)) return ticker;
  }

  const normalizedQ = normalizeLooseText(raw);
  for (const [ticker, aliases] of Object.entries(TICKER_ALIAS_MAP)) {
    for (const alias of aliases) {
      if (!alias || alias.length < 2) continue;
      if (normalizedQ.includes(alias)) return ticker;
    }
  }

  return null;
}

function resolveTicker({ explicitSymbol, explicitTicker, question }) {
  const explicitTickerNormalized = String(explicitTicker || "").toUpperCase().trim();
  if (explicitTickerNormalized) return explicitTickerNormalized;

  const symbolTicker = symbolToTicker(explicitSymbol || "");
  if (symbolTicker) return symbolTicker;

  return resolveTickerFromQuestion(question);
}

function resolveTickerFromMessages(messages = []) {
  const items = Array.isArray(messages) ? messages.slice().reverse() : [];
  for (const item of items) {
    const content = String(item?.content || "").trim();
    if (!content) continue;
    const resolved = resolveTickerFromQuestion(content);
    if (resolved) return resolved;
  }
  return null;
}

function resolveAssistantTicker({ explicitSymbol, explicitTicker, question, messages, favoriteTickers }) {
  const direct = resolveTicker({ explicitSymbol, explicitTicker, question });
  if (direct) return direct;

  const fromMessages = resolveTickerFromMessages(messages);
  if (fromMessages) return fromMessages;

  const favorites = Array.isArray(favoriteTickers)
    ? favoriteTickers.map((item) => String(item || "").toUpperCase().trim()).filter(Boolean)
    : [];

  if (favorites.length === 1) return favorites[0];
  return null;
}

function requireApiKey(request, env) {
  const key = request.headers.get("x-api-key") || "";
  if (!env.WORKER_API_KEY) {
    return { ok: false, res: text("Missing WORKER_API_KEY on Worker", 500) };
  }
  if (key !== env.WORKER_API_KEY) {
    return { ok: false, res: json({ ok: false, error: "Unauthorized" }, 401) };
  }
  return { ok: true };
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

function buildSentimentExplanation(ticker, detail) {
  if (!detail || !detail.total) return "Not available.";

  const titles = Array.isArray(detail.top_titles)
    ? detail.top_titles
        .map((item) => {
          if (typeof item === "string") return item;
          return item?.title || item?.headline || "";
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];

  let stance = "mixed";
  if (detail.bullish > detail.bearish && detail.bullish >= detail.neutral) stance = "bullish";
  if (detail.bearish > detail.bullish && detail.bearish >= detail.neutral) stance = "bearish";
  if (detail.neutral >= detail.bullish && detail.neutral >= detail.bearish) stance = "neutral";

  const sentences = [
    `${ticker} news sentiment is currently ${stance}, based on ${detail.total} tracked headline${detail.total === 1 ? "" : "s"} over the last ${detail.window_hours || 24} hour${detail.window_hours === 1 ? "" : "s"}.`,
    `Distribution: ${detail.bullish_pct}% bullish, ${detail.neutral_pct}% neutral, ${detail.bearish_pct}% bearish.`,
  ];

  if (titles.length) {
    sentences.push(`Recent drivers include: ${titles.join("; ")}.`);
  }

  return sentences.join(" ");
}

function truncateText(value, max = 420) {
  const textValue = String(value || "").replace(/\s+/g, " ").trim();
  if (textValue.length <= max) return textValue;
  return textValue.slice(0, max).trimEnd() + "…";
}

function firstMeaningfulText(items = [], fallback = "Not available.") {
  for (const item of items) {
    const textValue = truncateText(item?.text || "");
    if (textValue) return textValue;
  }
  return fallback;
}

function extractJsonObject(textValue) {
  const raw = String(textValue || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  return null;
}

async function getRecentYoutubeVideosForTickers(env, tickers = [], limit = 8, days = 60) {
  const safeLimit = Math.min(Math.max(Number(limit || 8), 1), 20);
  const safeDays = clamp(Number(days || 60), 1, 365);
  const recentCutoffIso = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const cleanTickers = Array.from(
    new Set(
      (Array.isArray(tickers) ? tickers : [])
        .map((item) => String(item || "").toUpperCase().trim())
        .filter(Boolean)
    )
  );

  let rows = { results: [] };
  let transcriptRows = { results: [] };

  if (cleanTickers.length) {
    const placeholders = cleanTickers.map(() => "?").join(", ");
    rows = await env.DB.prepare(
      `
      SELECT
        v.video_id,
        v.title,
        v.channel,
        v.published_at,
        v.url,
        GROUP_CONCAT(DISTINCT ys.symbol) AS symbols,
        MIN(s.start) AS first_start,
        MIN(COALESCE(s.text, '')) AS transcript_snippet
      FROM youtube_videos v
      JOIN youtube_video_symbols ys ON ys.video_id = v.video_id
      LEFT JOIN youtube_segments s ON s.video_id = v.video_id
      WHERE ys.symbol IN (${placeholders})
        AND COALESCE(v.published_at, '') >= ?
      GROUP BY v.video_id, v.title, v.channel, v.published_at, v.url
      ORDER BY v.published_at DESC
      LIMIT ?
      `
    ).bind(...cleanTickers, recentCutoffIso, safeLimit).all().catch(() => ({ results: [] }));

    const transcriptClauses = cleanTickers.map(() => `
      UPPER(COALESCE(title, '')) LIKE '%' || ? || '%'
      OR UPPER(COALESCE(transcript_text, '')) LIKE '%' || ? || '%'
    `).join(" OR ");
    const transcriptBindings = [];
    cleanTickers.forEach((ticker) => {
      transcriptBindings.push(ticker, ticker);
    });
    transcriptBindings.push(recentCutoffIso, safeLimit);

    transcriptRows = await env.DB.prepare(
      `
      SELECT
        video_id,
        title,
        channel_title AS channel,
        published_at,
        video_url AS url,
        transcript_text
      FROM youtube_transcripts
      WHERE (${transcriptClauses})
        AND COALESCE(published_at, '') >= ?
      ORDER BY published_at DESC
      LIMIT ?
      `
    ).bind(...transcriptBindings).all().catch(() => ({ results: [] }));
  } else {
    rows = await env.DB.prepare(
      `
      SELECT
        v.video_id,
        v.title,
        v.channel,
        v.published_at,
        v.url,
        GROUP_CONCAT(DISTINCT ys.symbol) AS symbols,
        MIN(s.start) AS first_start,
        MIN(COALESCE(s.text, '')) AS transcript_snippet
      FROM youtube_videos v
      LEFT JOIN youtube_video_symbols ys ON ys.video_id = v.video_id
      LEFT JOIN youtube_segments s ON s.video_id = v.video_id
      WHERE COALESCE(v.published_at, '') >= ?
      GROUP BY v.video_id, v.title, v.channel, v.published_at, v.url
      ORDER BY v.published_at DESC
      LIMIT ?
      `
    ).bind(recentCutoffIso, safeLimit).all().catch(() => ({ results: [] }));

    transcriptRows = await env.DB.prepare(
      `
      SELECT
        video_id,
        title,
        channel_title AS channel,
        published_at,
        video_url AS url,
        transcript_text
      FROM youtube_transcripts
      WHERE COALESCE(published_at, '') >= ?
      ORDER BY published_at DESC
      LIMIT ?
      `
    ).bind(recentCutoffIso, safeLimit).all().catch(() => ({ results: [] }));
  }

  const merged = new Map();

  for (const row of ((rows && rows.results) || [])) {
    merged.set(row.video_id, {
      video_id: row.video_id,
      title: row.title || "",
      channel: row.channel || "",
      published_at: row.published_at || null,
      url: row.url || ytSourceUrl(row.video_id, row.first_start || 0),
      symbols: String(row.symbols || "")
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean),
      transcript_snippet: truncateText(row.transcript_snippet || "", 220),
    });
  }

  for (const row of ((transcriptRows && transcriptRows.results) || [])) {
    const existing = merged.get(row.video_id);
    if (existing) {
      if (!existing.transcript_snippet) {
        existing.transcript_snippet = truncateText(row.transcript_text || "", 220);
      }
      if (!existing.channel && row.channel) existing.channel = row.channel;
      if ((!existing.url || existing.url === "#") && row.url) existing.url = row.url;
      continue;
    }

    merged.set(row.video_id, {
      video_id: row.video_id,
      title: row.title || "",
      channel: row.channel || "",
      published_at: row.published_at || null,
      url: row.url || ytSourceUrl(row.video_id, 0),
      symbols: cleanTickers.slice(0, 6),
      transcript_snippet: truncateText(row.transcript_text || "", 220),
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .slice(0, safeLimit);
}

async function fetchYoutubePageHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`YouTube page fetch failed (${res.status})`);
  return await res.text();
}

function extractYoutubeVideoCardsFromHtml(html = "", fallbackChannel = "", fallbackSymbols = []) {
  const out = [];
  const seen = new Set();
  const regex = /"videoId":"([A-Za-z0-9_-]{11})".{0,800}?"title":\{"runs":\[\{"text":"([^"]+?)"/g;
  let match;

  while ((match = regex.exec(html)) && out.length < 8) {
    const videoId = match[1];
    const title = String(match[2] || "").replace(/\\u0026/g, "&").trim();
    if (!videoId || !title || seen.has(videoId)) continue;
    seen.add(videoId);
    out.push({
      video_id: videoId,
      title,
      channel: fallbackChannel,
      published_at: null,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      symbols: Array.isArray(fallbackSymbols) ? fallbackSymbols.slice(0, 6) : [],
      transcript_snippet: "",
      source_mode: "live_channel_fallback",
    });
  }

  return out;
}

async function getFallbackYoutubeCoverage(limit = 8) {
  const safeLimit = Math.min(Math.max(Number(limit || 8), 1), 20);
  const items = [];

  for (const channel of YOUTUBE.CHANNELS) {
    if (items.length >= safeLimit) break;

    const directUrl = channel.handleUrl
      ? `${channel.handleUrl.replace(/\/+$/, "")}/videos`
      : `https://www.youtube.com/results?search_query=${encodeURIComponent(channel.name || channel.query || "")}&sp=CAI%253D`;

    try {
      const html = await fetchYoutubePageHtml(directUrl);
      const extracted = extractYoutubeVideoCardsFromHtml(
        html,
        channel.name || "YouTube",
        channel.symbols || []
      );

      for (const item of extracted) {
        if (items.length >= safeLimit) break;
        if (!items.find((existing) => existing.video_id === item.video_id)) {
          items.push(item);
        }
      }
    } catch {
      // ignore per-channel failures and continue
    }
  }

  return items.slice(0, safeLimit);
}

function isBoilerplateDisclosureText(textValue) {
  const text = String(textValue || "").toLowerCase();
  if (!text) return true;

  const phrases = [
    "consent to service of process",
    "incorporation by reference",
    "exhibit index",
    "signatures",
    "recovery of erroneously awarded compensation",
    "code of ethics",
    "principal accountant fees",
    "off-balance sheet arrangements",
    "the company undertakes to make available",
    "the obligation to file this annual report on form 40-f arises",
    "cover page interactive data file",
    "certification of the chief executive officer",
    "certification of the chief financial officer",
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function excerptKindKeywords(kind) {
  switch (kind) {
    case "production":
      return ["production", "produced", "ounces", "ounce", "gold equivalent", "silver equivalent", "payable"];
    case "mine":
      return ["mine", "project", "complex", "operation", "grade", "location", "mill", "pit", "underground"];
    case "management":
      return ["management", "operations", "strategy", "capital", "guidance", "cost", "quarter", "results"];
    case "risk":
      return ["risk", "uncertaint", "inflation", "permitting", "environment", "liquidity", "cost", "adverse"];
    case "forward":
      return ["guidance", "outlook", "expect", "plan", "anticipate", "forward", "margin", "cost", "production"];
    default:
      return [];
  }
}

function scoreCompanyExcerpt(item, kind) {
  const text = [
    item?.heading || "",
    item?.text || "",
    item?.form || "",
    item?.primary_document || "",
    item?.title || "",
    item?.channel || "",
  ].join(" ").toLowerCase();

  if (!text) return -1000;
  if (kind !== "forward" && isBoilerplateDisclosureText(text)) return -1000;

  let score = 0;
  for (const keyword of excerptKindKeywords(kind)) {
    if (text.includes(keyword)) score += 2;
  }
  if (item?.heading) score += 1;
  if (/\b202[3-6]\b/.test(text)) score += 1;
  if (/\b(q1|q2|q3|q4|quarter)\b/.test(text)) score += 1;
  if ((/\boz\b|\bounces\b/.test(text)) && kind === "production") score += 2;

  return score;
}

function selectRelevantCompanyExcerpts(items = [], kind, max = 2) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({ ...item, _score: scoreCompanyExcerpt(item, kind) }))
    .filter((item) => item._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, max);
}

function cleanExcerptText(textValue, max = 420) {
  const cleaned = String(textValue || "")
    .replace(/\s+/g, " ")
    .replace(/\bPage \d+ of \d+\b/gi, "")
    .trim();

  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trimEnd() + "…";
}

function buildUserFriendlySection(items = [], kind, fallback = "Not available.") {
  const selected = selectRelevantCompanyExcerpts(items, kind, 2);
  if (!selected.length) return fallback;

  return selected.map((item) => {
    const label = kind === "forward"
      ? [item.title, item.channel].filter(Boolean).join(" — ")
      : item.heading || `${item.form || "Filing"} ${item.filing_date || ""}`.trim();
    const body = cleanExcerptText(item.text || "", kind === "forward" ? 280 : 360);
    return label ? `${label}: ${body}` : body;
  }).join("\n\n");
}

const MAP_LOCATION_CATALOG = [
  { key: "canada", label: "Canada", x: 198, y: 128, aliases: ["canada", "ontario", "quebec", "nunavut", "yukon", "british columbia", "manitoba", "saskatchewan"] },
  { key: "usa", label: "USA", x: 176, y: 180, aliases: ["united states", "usa", "nevada", "alaska", "idaho", "montana", "arizona"] },
  { key: "mexico", label: "Mexico", x: 144, y: 215, aliases: ["mexico", "sonora", "durango", "zacatecas", "chihuahua", "sinaloa"] },
  { key: "peru", label: "Peru", x: 289, y: 336, aliases: ["peru", "lima", "arequipa", "cajamarca", "andes"] },
  { key: "chile", label: "Chile", x: 300, y: 372, aliases: ["chile", "atacama", "antofagasta"] },
  { key: "argentina", label: "Argentina", x: 334, y: 382, aliases: ["argentina", "san juan", "salta", "patagonia"] },
  { key: "uk", label: "UK", x: 484, y: 110, aliases: ["united kingdom", "uk", "england", "london"] },
  { key: "south_africa", label: "South Africa", x: 540, y: 345, aliases: ["south africa", "johannesburg", "gauteng"] },
  { key: "botswana", label: "Botswana", x: 573, y: 322, aliases: ["botswana", "gaborone", "karowe"] },
  { key: "mongolia", label: "Mongolia", x: 737, y: 178, aliases: ["mongolia", "oyu tolgoi", "ulan bator", "ulaanbaatar"] },
  { key: "china", label: "China", x: 788, y: 188, aliases: ["china", "henan", "guangdong", "beijing"] },
  { key: "australia", label: "Australia", x: 835, y: 356, aliases: ["australia", "western australia", "queensland", "new south wales", "northern territory"] },
  { key: "brazil", label: "Brazil", x: 360, y: 320, aliases: ["brazil", "minas gerais", "para"] },
];

function detectMapLocationFromText(textValue = "") {
  const text = String(textValue || "").toLowerCase();
  if (!text) return null;

  let best = null;
  for (const location of MAP_LOCATION_CATALOG) {
    let score = 0;
    let matchedAlias = "";
    for (const alias of location.aliases) {
      if (text.includes(alias)) {
        score += alias.length > 6 ? 2 : 1;
        if (!matchedAlias || alias.length > matchedAlias.length) matchedAlias = alias;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { ...location, score, matchedAlias };
    }
  }

  return best;
}

function toTitleCase(value = "") {
  return String(value || "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function getMapSubLocationLabel(location = null, sourceText = "", ticker = "") {
  const alias = String(location?.matchedAlias || "").trim();
  if (alias && alias.toLowerCase() !== String(location?.label || "").toLowerCase()) {
    return toTitleCase(alias);
  }

  const overrideCountry = String(ANALYSIS_META_OVERRIDES[String(ticker || "").toUpperCase().trim()]?.country || "").trim();
  if (overrideCountry) return overrideCountry;

  const meta = TICKERS[String(ticker || "").toUpperCase().trim()] || {};
  const fallbackAlias = Array.isArray(meta.aliases) ? meta.aliases.find(Boolean) : "";
  return String(fallbackAlias || meta.company || meta.name || sourceText || location?.label || "").trim();
}

function markerOffsetForTicker(ticker = "") {
  const source = String(ticker || "").toUpperCase();
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) % 9973;
  }

  const offsets = [
    [0, 0],
    [14, -10],
    [-16, 10],
    [18, 12],
    [-18, -12],
    [24, -4],
    [-24, 4],
    [8, 18],
    [-10, -18],
  ];
  return offsets[hash % offsets.length];
}

function resolveMapLocationForTicker(ticker = "", sourceText = "") {
  const fromSource = detectMapLocationFromText(sourceText);
  if (fromSource) return fromSource;

  const override = ANALYSIS_META_OVERRIDES[String(ticker || "").toUpperCase().trim()] || {};
  const country = String(override.country || "").trim();
  if (country) {
    const fromCountry = detectMapLocationFromText(country);
    if (fromCountry) return fromCountry;
  }

  const meta = TICKERS[String(ticker || "").toUpperCase().trim()] || {};
  const fallbackText = [
    meta.company,
    meta.name,
    ...(Array.isArray(meta.aliases) ? meta.aliases : []),
  ].filter(Boolean).join(" ");

  return detectMapLocationFromText(fallbackText);
}

async function getUniverseMapMarkers(env, tickers = Object.keys(TICKERS), limit = 18) {
  const safeTickers = (Array.isArray(tickers) ? tickers : Object.keys(TICKERS))
    .map((item) => String(item || "").toUpperCase().trim())
    .filter((item) => !!TICKERS[item])
    .slice(0, 80);

  const markers = [];

  for (const ticker of safeTickers) {
    const rows = await env.DB.prepare(
      `
      SELECT
        r.ticker,
        r.form,
        r.filing_date,
        r.source_url,
        b.heading,
        b.text_content
      FROM mining_report_blocks b
      JOIN mining_reports r
        ON r.id = b.report_id
      WHERE r.ticker = ?
        AND LOWER(COALESCE(r.form, '')) IN ('40-f', '40-f/a', '40f', '40f/a')
        AND (
          LOWER(COALESCE(b.heading, '')) LIKE '%location%'
          OR LOWER(COALESCE(b.heading, '')) LIKE '%mine%'
          OR LOWER(COALESCE(b.heading, '')) LIKE '%project%'
          OR LOWER(COALESCE(b.text_content, '')) LIKE '%location%'
          OR LOWER(COALESCE(b.text_content, '')) LIKE '%mine%'
          OR LOWER(COALESCE(b.text_content, '')) LIKE '%project%'
        )
      ORDER BY r.filing_date DESC, b.block_index ASC
      LIMIT 10
      `
    ).bind(ticker).all().catch(() => ({ results: [] }));

    const blocks = buildDisclosureContext((rows && rows.results) || []);
    const selected = selectRelevantCompanyExcerpts(blocks, "mine", 3);
    const sourceText = selected.map((item) => `${item.heading || ""} ${item.text || ""}`).join(" ");
    const location = resolveMapLocationForTicker(ticker, sourceText);
    if (!location) continue;

    const offset = markerOffsetForTicker(ticker);
    const latestFilingDate = selected[0]?.filing_date || null;
    const sourceExcerpt = cleanExcerptText(sourceText, 180) || `Primary mapped operating region: ${location.label}.`;
    markers.push({
      key: ticker,
      ticker,
      company_name: String(TICKERS[ticker]?.company || TICKERS[ticker]?.name || ticker).trim(),
      label: ticker,
      map_label: String(TICKERS[ticker]?.name || TICKERS[ticker]?.company || ticker).trim(),
      location_label: location.label,
      sub_location: getMapSubLocationLabel(location, sourceText, ticker),
      x: location.x + offset[0],
      y: location.y + offset[1],
      anchor_x: location.x,
      anchor_y: location.y,
      metal: String(TICKERS[ticker]?.metal || "gold").toLowerCase(),
      latest_filing_date: latestFilingDate,
      source_excerpt: sourceExcerpt,
      detail: [location.label, getMapSubLocationLabel(location, sourceText, ticker)].filter(Boolean).join(" • "),
    });
  }

  return markers
    .sort((a, b) => {
      const dateDiff = String(b.latest_filing_date || "").localeCompare(String(a.latest_filing_date || ""));
      if (dateDiff !== 0) return dateDiff;
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    })
    .slice(0, Math.max(1, Number(limit || 18)));
}

async function buildCompanyDescription(env, payload) {
  const fallback = `${payload.name || payload.ticker} is tracked in Minerlytics with market, news, filing, and transcript coverage where available.`;

  if (!env.AI) return fallback;

  const prompt =
    "You are Minerlytics AI. Return one short paragraph only.\n" +
    "Describe the company in plain English using only the provided DATA.\n" +
    "Do not invent mines, production, or financial facts not supported by DATA.\n" +
    "Keep it under 90 words.\n\nDATA:\n" +
    stableStringify(payload);

  try {
    const result = await env.AI.run(WORKERS_AI_CHAT_MODEL, {
      prompt,
      max_tokens: 180,
      temperature: 0,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    const raw =
      (typeof result === "string" && result) ||
      (result && (result.response || result.result || result.output_text)) ||
      "";

    const cleaned = String(raw || "").replace(/\s+/g, " ").trim();
    return cleaned || fallback;
  } catch {
    return fallback;
  }
}

function ytSourceUrl(video_id, start) {
  const t = Math.max(0, Math.floor(Number(start || 0)));
  return `https://www.youtube.com/watch?v=${video_id}&t=${t}s`;
}

function buildTranscriptContext(results) {
  return (results || []).map((r, i) => {
    const sid = `YT${i + 1}`;
    const start = Number(r.start || 0);
    return {
      sid,
      video_id: r.video_id,
      start,
      duration: Number(r.duration || 0),
      title: r.title || "",
      channel: r.channel || "",
      published_at: r.published_at || "",
      url: r.url || ytSourceUrl(r.video_id, start),
      text: String(r.text || "").replace(/\s+/g, " ").trim(),
    };
  });
}

function buildDisclosureContext(results) {
  return (results || []).map((r, i) => {
    const sid = `SEC${i + 1}`;
    return {
      sid,
      ticker: r.ticker || "",
      accession_number: r.accession_number || "",
      filing_date: r.filing_date || "",
      form: r.form || "",
      primary_document: r.primary_document || r.source_url || "",
      heading: r.heading || "",
      url: r.source_url || "",
      text: String(r.text_content || "").replace(/\s+/g, " ").trim(),
    };
  });
}

function buildRssContext(results) {
  return (results || []).map((r, i) => {
    const sid = `RSS${i + 1}`;
    return {
      sid,
      ticker: r.ticker || "",
      title: r.title || "",
      source: r.source || "",
      link: r.link || "",
      published_at: r.published_at || "",
      fetched_at: r.fetched_at || "",
    };
  });
}

function isTechnicalReportQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    q.includes("technical report") ||
    q.includes("technical reports") ||
    q.includes("technical report summary") ||
    /\btrs\b/.test(q) ||
    q.includes("exhibit 96")
  );
}

function extractSearchTerms(q, ticker) {
  const stopwords = new Set([
    "what", "which", "who", "when", "where", "why", "how",
    "did", "does", "do", "is", "are", "was", "were", "can",
    "could", "would", "should", "tell", "me", "about",
    "mention", "mentioned", "mentions", "give", "show",
    "latest", "from", "into", "that", "this", "with",
    "have", "has", "had", "their", "they", "them", "for",
    "and", "the", "a", "an", "of", "to", "in", "on", "at",
    "please", "full", "detail", "details", "overview", "company",
    "ticker", "explain", "describe"
  ]);

  const upperTicker = String(ticker || "").toUpperCase().trim();
  const raw = String(q || "").toLowerCase();
  const technicalReportQuestion = isTechnicalReportQuestion(raw);

  const words = raw
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.length >= 2)
    .filter((s) => !stopwords.has(s))
    .filter((s) => !(technicalReportQuestion && ["technical", "report", "reports", "summary", "associated"].includes(s)))
    .filter((s) => s.toUpperCase() !== upperTicker);

  const terms = new Set(words);

  if (/\b40\s*-?\s*f\b/i.test(raw) || /\b40f\b/i.test(raw)) {
    terms.add("40-f");
    terms.add("40f");
    terms.add("form 40-f");
    terms.add("annual report");
  }

  if (/\b10\s*-?\s*k\b/i.test(raw) || /\b10k\b/i.test(raw)) {
    terms.add("10-k");
    terms.add("10k");
    terms.add("form 10-k");
    terms.add("annual report");
  }

  if (/\b10\s*-?\s*q\b/i.test(raw) || /\b10q\b/i.test(raw)) {
    terms.add("10-q");
    terms.add("10q");
    terms.add("form 10-q");
    terms.add("quarterly report");
  }

  if (technicalReportQuestion) {
    terms.add("technical report");
    terms.add("technical report summary");
    terms.add("exhibit 96");
    terms.add("trs");
  }

  return Array.from(terms).slice(0, 12);
}

function isFilingQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    q.includes("40-f") ||
    q.includes("40f") ||
    q.includes("10-k") ||
    q.includes("10k") ||
    q.includes("10-q") ||
    q.includes("10q") ||
    q.includes("filing") ||
    q.includes("annual report") ||
    q.includes("technical report") ||
    q.includes("form ")
  );
}

function isCapabilityQuestion(question = "") {
  const q = String(question || "").toLowerCase().trim();
  if (!q) return false;
  return (
    q.includes("what can i ask") ||
    q.includes("what should i ask") ||
    q.includes("what are good questions") ||
    q.includes("what questions can i ask") ||
    q.includes("how can you help") ||
    q.includes("what can you help with") ||
    q.includes("what can i ask about") ||
    q.includes("what should i ask about")
  );
}

function isConversationalQuestion(question = "") {
  const q = String(question || "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return false;

  const exact = new Set([
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "how are you",
    "how are you doing",
    "how is it going",
    "whats up",
    "what's up",
    "thanks",
    "thank you",
    "ok thanks",
  ]);

  return exact.has(q) || /^(hi|hello|hey)\b/.test(q);
}

function buildConversationalAnswer(question = "", favoriteTickers = []) {
  const q = String(question || "").toLowerCase();
  const favorites = Array.isArray(favoriteTickers)
    ? favoriteTickers.map((item) => String(item || "").toUpperCase().trim()).filter(Boolean).slice(0, 5)
    : [];
  const favoriteHint = favorites.length
    ? ` I can also use your saved tickers: ${favorites.join(", ")}.`
    : "";

  if (q.includes("thank")) {
    return [
      "You're welcome. I'm here whenever you want to dig into miners, filings, market moves, news, or transcript commentary.",
      favoriteHint.trim(),
    ].filter(Boolean).join("\n\n");
  }

  return [
    "Hi, I'm doing well and ready to help with mining research.",
    `You can ask me things like "What are the latest filings for AEM?", "How has WPM performed recently?", or "What news is moving FCX?"${favoriteHint}`,
  ].join("\n\n");
}

function isBroadResearchQuestion(question = "") {
  const q = String(question || "").toLowerCase().trim();
  if (!q) return false;
  return (
    q.includes("research summary") ||
    q.includes("full summary") ||
    q.includes("full analysis") ||
    q.includes("deep analysis") ||
    q.includes("company memo") ||
    q.includes("investment memo") ||
    q.includes("tell me about") ||
    q.includes("analyze ") ||
    q.includes("overview")
  );
}

function isMarketQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    q.includes("stock price") ||
    q.includes("share price") ||
    q.includes("market data") ||
    q.includes("performance") ||
    q.includes("momentum") ||
    q.includes("trend") ||
    q.includes("volume") ||
    q.includes("close") ||
    q.includes("high") ||
    q.includes("low") ||
    q.includes("open")
  );
}

function isNewsQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    q.includes("news") ||
    q.includes("headline") ||
    q.includes("rss") ||
    q.includes("sentiment") ||
    q.includes("recent article") ||
    q.includes("latest article")
  );
}

function isTranscriptQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  return (
    q.includes("youtube") ||
    q.includes("video") ||
    q.includes("transcript") ||
    q.includes("interview") ||
    q.includes("commentary") ||
    q.includes("discussion") ||
    q.includes("channel")
  );
}

function getAssistantIntent(question = "") {
  const capability = isCapabilityQuestion(question);
  const filing = isFilingQuestion(question);
  const technicalReport = isTechnicalReportQuestion(question);
  const market = isMarketQuestion(question);
  const news = isNewsQuestion(question);
  const transcripts = isTranscriptQuestion(question);
  const broad = isBroadResearchQuestion(question) || (!filing && !technicalReport && !market && !news && !transcripts && !capability);

  const sourceGroups = [];
  if (capability || broad || market) sourceGroups.push("market_data");
  if (capability || broad || news) sourceGroups.push("news_sentiment", "rss_news");
  if (capability || broad || filing || technicalReport) sourceGroups.push("sec_filings");
  if (capability || broad || transcripts) sourceGroups.push("youtube_transcripts");

  const primarySource =
    technicalReport || filing ? "sec_filings" :
    transcripts ? "youtube_transcripts" :
    news ? "rss_news" :
    market ? "market_data" :
    "mixed";

  return {
    capability,
    broad,
    filing,
    technicalReport,
    market,
    news,
    transcripts,
    primarySource,
    sourceGroups: Array.from(new Set(sourceGroups)),
    answerStyle: broad ? "research_brief" : "direct_answer",
  };
}

function buildCapabilityAnswer(context = {}) {
  const ticker = String(context?.resolved_ticker || context?.ticker || "")
    .replace(/\.us$/i, "")
    .toUpperCase()
    .trim() || "this company";

  const marketAvailable = !!context?.market_data?.latest || (context?.market_data?.observations || []).length > 0;
  const newsAvailable = !!context?.news_sentiment || (context?.rss_news?.item_count || 0) > 0;
  const filingsAvailable = (context?.sec_filings?.item_count || 0) > 0;
  const transcriptsAvailable = (context?.youtube_transcripts?.item_count || 0) > 0;

  const sourceLabels = [];
  if (marketAvailable) sourceLabels.push("market data");
  if (newsAvailable) sourceLabels.push("news sentiment and RSS");
  if (filingsAvailable) sourceLabels.push("filings / mining disclosure");
  if (transcriptsAvailable) sourceLabels.push("YouTube transcripts");

  const prompts = [
    `What does recent market performance look like for ${ticker}?`,
    `How has ${ticker} performed over the last 30 days and 6 months?`,
    `What does recent news sentiment say about ${ticker}?`,
    `What are the latest headlines associated with ${ticker}?`,
    `What filings or mining disclosures mention ${ticker}?`,
    `What technical reports are associated with ${ticker}?`,
    `What do recent transcript discussions say about ${ticker}?`,
    `What are the main risks and opportunities for ${ticker} based on the available data?`,
  ];

  return [
    "✅ What You Can Ask",
    `You can ask about ${ticker}'s market performance, news sentiment, filings / technical reports, and transcript commentary using the data currently available in Minerlytics.`,
    "",
    "💡 Good Questions to Try",
    ...prompts.map((prompt) => `- ${prompt}`),
    "",
    "🏷️ Sources Available",
    sourceLabels.length ? `- ${sourceLabels.join("\n- ")}` : "- Not available",
    "",
    "🧾 Disclaimer",
    "this information is for research purposes only and does not constitute investment advice.",
  ].join("\n");
}

async function getLatestDisclosureBlocksForTicker(env, ticker, limit = 12) {
  const safeLimit = Math.min(Math.max(Number(limit || 12), 1), 50);
  if (!ticker) return [];

  const rows = await env.DB.prepare(
    `
    SELECT
      r.ticker,
      r.accession_number,
      r.filing_date,
      r.source_url,
      r.form,
      r.source_url AS primary_document,
      b.heading,
      b.text_content
    FROM mining_report_blocks b
    JOIN mining_reports r
      ON r.id = b.report_id
    WHERE r.ticker = ?
    ORDER BY r.filing_date DESC, b.block_index ASC
    LIMIT ?
    `
  ).bind(ticker, safeLimit).all();

  return buildDisclosureContext((rows && rows.results) || []);
}

async function getTechnicalReportMatches(env, ticker, limit = 12) {
  const safeLimit = Math.min(Math.max(Number(limit || 12), 1), 50);
  if (!ticker) return [];

  const rows = await env.DB.prepare(
    `
    SELECT
      r.ticker,
      r.accession_number,
      r.filing_date,
      r.source_url,
      r.form,
      r.source_url AS primary_document,
      COALESCE(b.heading, 'Technical Report Reference') AS heading,
      b.text_content
    FROM mining_report_blocks b
    JOIN mining_reports r
      ON r.id = b.report_id
    WHERE r.ticker = ?
      AND (
        LOWER(COALESCE(b.heading, '')) LIKE '%technical report%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%technical report%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%technical report summary%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%exhibit 96%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.1%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.2%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.3%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.4%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.5%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.6%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.7%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.8%'
        OR LOWER(COALESCE(b.text_content, '')) LIKE '%96.9%'
      )
    ORDER BY r.filing_date DESC, b.block_index ASC
    LIMIT ?
    `
  ).bind(ticker, safeLimit).all();

  return buildDisclosureContext((rows && rows.results) || []);
}

async function getMiningDisclosureMatches(env, ticker, q, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 50);
  const terms = extractSearchTerms(q, ticker);
  const rawQ = String(q || "").trim().toLowerCase();
  const technicalReportQuestion = isTechnicalReportQuestion(rawQ);

  let rows = { results: [] };

  const is40FQuery = /\b40\s*-?\s*f\b/i.test(rawQ) || /\b40f\b/i.test(rawQ);

  if (ticker && technicalReportQuestion) {
    const technicalMatches = await getTechnicalReportMatches(env, ticker, safeLimit);
    return technicalMatches;
  }

  if (ticker && terms.length) {
    const likeClauses = [];
    const bindings = [ticker];

    for (const term of terms) {
      likeClauses.push(`
        (
          LOWER(COALESCE(b.text_content, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(b.heading, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(r.form, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(r.source_url, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(r.source_url, '')) LIKE '%' || LOWER(?) || '%'
        )
      `);
      bindings.push(term, term, term, term, term);
    }

    bindings.push(safeLimit);

    rows = await env.DB.prepare(
      `
      SELECT
        r.ticker,
        r.accession_number,
        r.filing_date,
        r.source_url,
        r.form,
        r.source_url AS primary_document,
        b.heading,
        b.text_content
      FROM mining_report_blocks b
      JOIN mining_reports r
        ON r.id = b.report_id
      WHERE r.ticker = ?
        AND (${likeClauses.join(" OR ")})
      ORDER BY
        CASE
          WHEN LOWER(COALESCE(r.form, '')) IN ('40-f', '40f') THEN 0
          ELSE 1
        END,
        r.filing_date DESC,
        b.block_index ASC
      LIMIT ?
      `
    ).bind(...bindings).all();
  } else if (ticker && is40FQuery) {
    rows = await env.DB.prepare(
      `
      SELECT
        r.ticker,
        r.accession_number,
        r.filing_date,
        r.source_url,
        r.form,
        r.source_url AS primary_document,
        b.heading,
        b.text_content
      FROM mining_report_blocks b
      JOIN mining_reports r
        ON r.id = b.report_id
      WHERE r.ticker = ?
        AND (
          LOWER(COALESCE(r.form, '')) IN ('40-f', '40f')
          OR LOWER(COALESCE(r.source_url, '')) LIKE '%40-f%'
          OR LOWER(COALESCE(r.source_url, '')) LIKE '%40-f%'
          OR LOWER(COALESCE(b.heading, '')) LIKE '%40-f%'
          OR LOWER(COALESCE(b.text_content, '')) LIKE '%40-f%'
        )
      ORDER BY r.filing_date DESC, b.block_index ASC
      LIMIT ?
      `
    ).bind(ticker, safeLimit).all();
  } else if (!ticker && terms.length) {
    const likeClauses = [];
    const bindings = [];

    for (const term of terms) {
      likeClauses.push(`
        (
          LOWER(COALESCE(b.text_content, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(b.heading, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(r.form, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(r.source_url, '')) LIKE '%' || LOWER(?) || '%'
          OR LOWER(COALESCE(r.source_url, '')) LIKE '%' || LOWER(?) || '%'
        )
      `);
      bindings.push(term, term, term, term, term);
    }

    bindings.push(safeLimit);

    rows = await env.DB.prepare(
      `
      SELECT
        r.ticker,
        r.accession_number,
        r.filing_date,
        r.source_url,
        r.form,
        r.source_url AS primary_document,
        b.heading,
        b.text_content
      FROM mining_report_blocks b
      JOIN mining_reports r
        ON r.id = b.report_id
      WHERE ${likeClauses.join(" OR ")}
      ORDER BY r.filing_date DESC, b.block_index ASC
      LIMIT ?
      `
    ).bind(...bindings).all();
  } else if (ticker) {
    return await getLatestDisclosureBlocksForTicker(env, ticker, Math.min(safeLimit, 12));
  }

  const results = (rows && rows.results) || [];
  if (ticker && results.length === 0) {
    return await getLatestDisclosureBlocksForTicker(env, ticker, Math.min(safeLimit, 12));
  }

  return buildDisclosureContext(results);
}

async function getTranscriptMatches(env, ticker, q, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 50);
  const activeTicker = String(ticker || "").toUpperCase().trim();
  const terms = extractSearchTerms(q, ticker);

  let rows = { results: [] };

  if (activeTicker && terms.length) {
    const clauses = [];
    const bindings = [activeTicker];

    for (const term of terms) {
      clauses.push("LOWER(COALESCE(s.text, '')) LIKE '%' || LOWER(?) || '%'");
      bindings.push(term);
    }

    bindings.push(safeLimit);

    rows = await env.DB.prepare(
      `
      SELECT
        s.video_id, s.start, s.duration, s.text,
        v.title, v.channel, v.published_at, v.url
      FROM youtube_segments s
      JOIN youtube_videos v ON v.video_id = s.video_id
      LEFT JOIN youtube_video_symbols ys ON ys.video_id = s.video_id
      WHERE (ys.symbol = ? OR ${clauses.join(" OR ")})
      ORDER BY v.published_at DESC, s.start ASC
      LIMIT ?
      `
    ).bind(...bindings).all();
  } else if (activeTicker) {
    rows = await env.DB.prepare(
      `
      SELECT
        s.video_id, s.start, s.duration, s.text,
        v.title, v.channel, v.published_at, v.url
      FROM youtube_segments s
      JOIN youtube_videos v ON v.video_id = s.video_id
      JOIN youtube_video_symbols ys ON ys.video_id = s.video_id
      WHERE ys.symbol = ?
      ORDER BY v.published_at DESC, s.start ASC
      LIMIT ?
      `
    ).bind(activeTicker, safeLimit).all();
  } else if (terms.length) {
    const clauses = [];
    const bindings = [];

    for (const term of terms) {
      clauses.push("LOWER(COALESCE(s.text, '')) LIKE '%' || LOWER(?) || '%'");
      bindings.push(term);
    }

    bindings.push(safeLimit);

    rows = await env.DB.prepare(
      `
      SELECT
        s.video_id, s.start, s.duration, s.text,
        v.title, v.channel, v.published_at, v.url
      FROM youtube_segments s
      JOIN youtube_videos v ON v.video_id = s.video_id
      WHERE ${clauses.join(" OR ")}
      ORDER BY v.published_at DESC, s.start ASC
      LIMIT ?
      `
    ).bind(...bindings).all();
  }

  return buildTranscriptContext((rows && rows.results) || []);
}

async function getLatestRssItemsForTicker(env, ticker, limit = 8) {
  if (!ticker) return [];
  const safeLimit = Math.min(Math.max(Number(limit || 8), 1), 25);

  const rows = await env.DB.prepare(
    `
    SELECT ticker, title, link, source, published_at, fetched_at
    FROM news_items
    WHERE ticker = ?
    ORDER BY
      CASE
        WHEN published_at IS NOT NULL AND published_at != '' THEN published_at
        ELSE fetched_at
      END DESC
    LIMIT ?
    `
  ).bind(ticker, safeLimit).all();

  return buildRssContext((rows && rows.results) || []);
}

async function getLatestNewsCardForTicker(env, ticker) {
  try {
    const row = await env.DB.prepare(
      `
      SELECT title, source, published_at, fetched_at
      FROM news_items
      WHERE ticker = ?
      ORDER BY
        CASE WHEN published_at IS NOT NULL AND published_at != '' THEN published_at ELSE fetched_at END DESC
      LIMIT 1
      `
    ).bind(ticker).first();

    if (row && row.title) {
      const when = row.published_at || row.fetched_at || null;
      const meta = `${row.source || "News"} • ${when ? relTime(when) : "recent"}`;
      return { title: `${ticker}: ${row.title}`, meta };
    }
  } catch {
    // ignore and fallback
  }

  try {
    if (!TICKERS[ticker]) return null;
    const rssUrl = googleRssUrl(TICKERS[ticker].q);
    const r = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const xml = await r.text();
    const items = parseRssItems(xml, 5);
    const top = items && items[0] ? items[0] : null;
    if (!top || !top.title) return null;

    const when = top.published_at || top.pubDate || top.date || null;
    const src = top.source || top.publisher || "News";
    const meta = `${src} • ${when ? relTime(when) : "recent"}`;

    return { title: `${ticker}: ${top.title}`, meta };
  } catch {
    return null;
  }
}

function summarizeHeadlineOneLiner(title = "", ticker = "") {
  const cleaned = String(title || "")
    .replace(/\s+/g, " ")
    .replace(new RegExp(`^${String(ticker || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-]\\s*`, "i"), "")
    .trim();

  if (!cleaned) return "Latest sector update available.";
  if (cleaned.length <= 118) return cleaned;
  return `${cleaned.slice(0, 115).trimEnd()}...`;
}

async function getLatestUniverseNewsItems(env, symbols = [], limit = 12, days = 60) {
  const tickers = (symbols.length ? symbols : Object.keys(TICKERS))
    .map((t) => String(t || "").toUpperCase().trim())
    .filter((t) => !!TICKERS[t])
    .slice(0, 40);

  if (!tickers.length) return [];

  const placeholders = tickers.map(() => "?").join(",");
  const safeDays = clamp(Number(days || 60), 1, 365);
  const recentCutoffIso = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `
    SELECT id, ticker, title, link, source, published_at, fetched_at
    FROM news_items
    WHERE ticker IN (${placeholders})
      AND COALESCE(NULLIF(published_at, ''), fetched_at, '') >= ?
    ORDER BY
      CASE WHEN published_at IS NOT NULL AND published_at != '' THEN published_at ELSE fetched_at END DESC
    LIMIT ?
    `
  ).bind(...tickers, recentCutoffIso, clamp(Number(limit || 12), 1, 24)).all();

  return ((rows && rows.results) || []).map((row) => {
    const when = row.published_at || row.fetched_at || null;
    return {
      ticker: row.ticker,
      title: row.title,
      link: row.link,
      source: row.source || "RSS",
      published_at: row.published_at || null,
      fetched_at: row.fetched_at || null,
      meta: `${row.ticker} • ${row.source || "RSS"} • ${when ? relTime(when) : "recent"}`,
      one_liner: summarizeHeadlineOneLiner(row.title, row.ticker)
    };
  });
}

async function getWebsiteInvestorNewsForTicker(env, ticker, limit = 8) {
  const symbol = String(ticker || "").toUpperCase().trim();
  if (!symbol) return [];
  const safeLimit = clamp(Number(limit || 8), 1, 25);

  const rows = await env.DB.prepare(
    `
    SELECT
      symbol,
      company_name,
      homepage_url,
      news_landing_url,
      article_url,
      article_title,
      published_date,
      summary_text,
      page_title,
      retrieved_at,
      evidence_text,
      confidence,
      extraction_layer
    FROM website_investor_news
    WHERE symbol = ?
      AND status_code = 'found'
      AND article_url IS NOT NULL
      AND article_url != ''
    ORDER BY
      CASE
        WHEN published_date IS NOT NULL AND published_date != '' THEN published_date
        ELSE retrieved_at
      END DESC
    LIMIT ?
    `
  ).bind(symbol, safeLimit).all();

  return ((rows && rows.results) || []).map((row) => {
    const when = row.published_date || row.retrieved_at || null;
    return {
      ticker: row.symbol,
      title: row.article_title,
      link: row.article_url,
      source: "Company website",
      source_type: "website_investor_news",
      published_at: row.published_date || null,
      fetched_at: row.retrieved_at || null,
      summary_text: row.summary_text || "",
      evidence_text: row.evidence_text || "",
      news_landing_url: row.news_landing_url || "",
      homepage_url: row.homepage_url || "",
      confidence: row.confidence ?? null,
      meta: `${row.symbol} • Company website • ${when ? relTime(when) : "recent"}`,
      one_liner: summarizeHeadlineOneLiner(row.article_title, row.symbol)
    };
  });
}

async function getStooqSeriesForTicker(env, ticker, limit = 60) {
  if (!ticker) return [];
  const safeLimit = Math.min(Math.max(Number(limit || 60), 1), 120);
  const candidates = getSymbolCandidates(ticker);

  for (const candidate of candidates) {
    const rows = await env.DB.prepare(
      `
      SELECT symbol, category, date, open, high, low, close, volume, source
      FROM daily_ohlcv
      WHERE symbol = ?
      ORDER BY date DESC
      LIMIT ?
      `
    ).bind(candidate, safeLimit).all().catch(() => null);

    const results = (rows && rows.results) || [];
    if (results.length) return results;
  }

  return [];
}

function inferTickerCategory(ticker) {
  const upper = String(ticker || "").toUpperCase().trim();
  if (["SLV", "SIVR", "PSLV"].includes(upper)) return "Silver";
  if (["SIL", "SILJ"].includes(upper)) return "Silver miners ETF";
  if (["AEM", "GFI", "WPM", "CDE", "HL", "HYMC", "PZG", "GAYMF", "DSVSF", "SLVR"].includes(upper)) {
    return "Mining";
  }
  return "Market";
}

function getYahooSymbolCandidates(raw) {
  const ticker = symbolToTicker(raw) || String(raw || "").toUpperCase().trim();
  return Array.from(new Set([
    ticker,
    ticker.replace(/\./g, "-"),
  ].filter(Boolean)));
}

function formatYahooDate(ts) {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function formatYahooTime(ts) {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(11, 19);
}

async function fetchYahooChartForSymbol(symbol, range = "6mo", interval = "1d") {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
    const res = await fetch(url, {
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0 Minerlytics/1.0"
      }
    });
    if (!res.ok) return null;

    const payload = await res.json().catch(() => null);
    return payload?.chart?.result?.[0] || null;
  } catch {
    return null;
  }
}

function buildYahooHistoryPayload(chart, limit = 180) {
  const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : [];
  const quote = chart?.indicators?.quote?.[0] || {};
  const rows = [];

  for (let i = 0; i < timestamps.length; i++) {
    const date = formatYahooDate(timestamps[i]);
    const close = Number(quote?.close?.[i]);
    if (!date || !Number.isFinite(close)) continue;

    rows.push({
      date,
      open: Number(quote?.open?.[i]),
      high: Number(quote?.high?.[i]),
      low: Number(quote?.low?.[i]),
      close,
      volume: Number(quote?.volume?.[i]),
    });
  }

  const results = rows.slice(-limit);
  const meta = chart?.meta || {};
  const last = results[results.length - 1] || null;
  const liveTimestamp = Number(meta.regularMarketTime || timestamps[timestamps.length - 1] || 0);
  const liveDate = formatYahooDate(liveTimestamp) || last?.date || null;

  const liveQuote = last
    ? {
        symbol: String(meta.symbol || "").toUpperCase() || null,
        date: liveDate,
        time: formatYahooTime(liveTimestamp),
        open: Number.isFinite(Number(meta.regularMarketOpen)) ? Number(meta.regularMarketOpen) : last.open,
        high: Number.isFinite(Number(meta.regularMarketDayHigh)) ? Number(meta.regularMarketDayHigh) : last.high,
        low: Number.isFinite(Number(meta.regularMarketDayLow)) ? Number(meta.regularMarketDayLow) : last.low,
        close: Number.isFinite(Number(meta.regularMarketPrice)) ? Number(meta.regularMarketPrice) : last.close,
        volume: Number.isFinite(Number(meta.regularMarketVolume)) ? Number(meta.regularMarketVolume) : last.volume,
      }
    : null;

  return {
    symbol: String(meta.symbol || "").toUpperCase() || null,
    results,
    liveQuote,
  };
}

async function fetchYahooHistoryForTicker(ticker, limit = 180) {
  for (const candidate of getYahooSymbolCandidates(ticker)) {
    const chart = await fetchYahooChartForSymbol(candidate, "6mo", "1d");
    if (!chart) continue;

    const payload = buildYahooHistoryPayload(chart, limit);
    if (payload.results.length) {
      return {
        results: payload.results,
        symbol: payload.symbol || candidate,
        liveQuote: payload.liveQuote,
        source: "yahoo_history",
      };
    }
  }

  return { results: [], symbol: String(ticker || "").toUpperCase().trim(), liveQuote: null, source: "yahoo_history" };
}

async function fetchStooqHistoryForSymbol(symbol, limit = 180) {
  try {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
    const res = await fetch(url, {
      headers: { "user-agent": "Minerlytics/1.0" }
    });
    if (!res.ok) return [];

    const text = await res.text();
    const lines = String(text || "").trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    return lines
      .slice(1)
      .map((line) => {
        const [date, open, high, low, close, volume] = String(line || "").split(",");
        return {
          date: String(date || "").trim(),
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume),
        };
      })
      .filter((row) => row.date && Number.isFinite(row.close))
      .slice(-limit);
  } catch {
    return [];
  }
}

async function fetchLiveHistoryForTicker(ticker, limit = 180) {
  const yahooHistory = await fetchYahooHistoryForTicker(ticker, limit);
  if (yahooHistory.results.length) return yahooHistory;

  const candidates = getSymbolCandidates(ticker);
  for (const candidate of candidates) {
    const results = await fetchStooqHistoryForSymbol(candidate, limit);
    if (results.length) {
      return { results, symbol: candidate, liveQuote: null, source: "stooq_history" };
    }
  }
  return {
    results: [],
    symbol: normalizeSymbolToStooqUS(ticker),
    liveQuote: null,
    source: "stooq_history",
  };
}

async function persistDailyOhlcvRows(env, ticker, symbol, rows, source = "live_history_sync") {
  if (!env?.DB || !Array.isArray(rows) || !rows.length) return 0;

  const category = inferTickerCategory(ticker);
  const statements = rows
    .filter((row) => row?.date && Number.isFinite(Number(row.close)))
    .map((row) =>
      env.DB.prepare(
        `
        INSERT OR REPLACE INTO daily_ohlcv
          (symbol, category, date, open, high, low, close, volume, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).bind(
        String(symbol || "").toLowerCase(),
        category,
        row.date,
        Number.isFinite(Number(row.open)) ? Number(row.open) : null,
        Number.isFinite(Number(row.high)) ? Number(row.high) : null,
        Number.isFinite(Number(row.low)) ? Number(row.low) : null,
        Number(row.close),
        Number.isFinite(Number(row.volume)) ? Number(row.volume) : 0,
        source
      )
    );

  if (!statements.length) return 0;

  try {
    if (typeof env.DB.batch === "function") {
      await env.DB.batch(statements);
    } else {
      for (const stmt of statements) {
        await stmt.run();
      }
    }
    return statements.length;
  } catch {
    return 0;
  }
}

async function refreshMarketHistoryForUniverse(env, tickers = Object.keys(TICKERS), limit = 180) {
  const safeLimit = Math.min(Math.max(Number(limit || 180), 30), 365);
  const out = [];

  for (const ticker of (Array.isArray(tickers) ? tickers : [])) {
    const cleanTicker = String(ticker || "").toUpperCase().trim();
    if (!cleanTicker || !TICKERS[cleanTicker]) continue;

    const liveHistory = await fetchLiveHistoryForTicker(cleanTicker, safeLimit);
    if (!liveHistory.results.length) {
      out.push({ ticker: cleanTicker, ok: false, rows: 0, source: liveHistory.source || "live_history" });
      continue;
    }

    const saved = await persistDailyOhlcvRows(
      env,
      cleanTicker,
      liveHistory.symbol || normalizeSymbolToStooqUS(cleanTicker),
      liveHistory.results,
      liveHistory.source || "live_history"
    );

    out.push({
      ticker: cleanTicker,
      ok: true,
      rows: saved,
      symbol: liveHistory.symbol || null,
      source: liveHistory.source || "live_history",
    });
  }

  return out;
}

async function getTrendSeriesForTickers(env, tickers, limit = 180) {
  const safeLimit = Math.min(Math.max(Number(limit || 180), 30), 365);
  const out = [];

  for (const ticker of tickers) {
    const liveHistory = await fetchLiveHistoryForTicker(ticker, safeLimit);
    let symbol = liveHistory.symbol;
    let results = liveHistory.results;
    let source = liveHistory.source || "live_history";
    let liveQuote = liveHistory.liveQuote || null;

    if (results.length) {
      await persistDailyOhlcvRows(env, ticker, symbol || normalizeSymbolToStooqUS(ticker), results, source);
    }

    if (!results.length) {
      for (const candidate of getSymbolCandidates(ticker)) {
        const rows = await env.DB.prepare(
          `
          SELECT symbol, date, open, high, low, close, volume
          FROM daily_ohlcv
          WHERE symbol = ?
          ORDER BY date DESC
          LIMIT ?
          `
        ).bind(candidate, safeLimit).all().catch(() => null);

        const candidateResults = ((rows && rows.results) || [])
          .slice()
          .reverse()
          .map((row) => ({
            date: row.date,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume),
          }))
          .filter((row) => row.date && Number.isFinite(row.close));

        if (candidateResults.length) {
          results = candidateResults;
          symbol = candidate;
          source = "d1_history";
          break;
        }
      }
    }

    if (!results.length) continue;

    const latest = results[results.length - 1] || null;
    const previous = results.length > 1 ? results[results.length - 2] : null;
    const latestClose = Number(latest?.close);
    const previousClose = Number(previous?.close);
    const change = Number.isFinite(latestClose) && Number.isFinite(previousClose)
      ? latestClose - previousClose
      : null;
    const changePct = change !== null && previousClose
      ? (change / previousClose) * 100
      : null;

    out.push({
      ticker,
      symbol,
      source,
      name: TICKERS[ticker]?.name || ticker,
      latest_close: Number.isFinite(latestClose) ? latestClose : null,
      previous_close: Number.isFinite(previousClose) ? previousClose : null,
      day_change: change !== null ? Number(change.toFixed(4)) : null,
      day_change_pct: changePct !== null ? Number(changePct.toFixed(2)) : null,
      live_quote: liveQuote,
      points: results,
    });
  }

  return out;
}

async function getStoredTrendSeriesForTickers(env, tickers, limit = 180) {
  const safeLimit = Math.min(Math.max(Number(limit || 180), 30), 365);
  const out = [];

  for (const ticker of tickers) {
    const cleanTicker = String(ticker || "").toUpperCase().trim();
    if (!cleanTicker) continue;

    let symbol = null;
    let results = [];

    for (const candidate of getSymbolCandidates(cleanTicker)) {
      const rows = await env.DB.prepare(
        `
        SELECT symbol, date, open, high, low, close, volume
        FROM daily_ohlcv
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
        `
      ).bind(candidate, safeLimit).all().catch(() => null);

      const candidateResults = ((rows && rows.results) || [])
        .slice()
        .reverse()
        .map((row) => ({
          date: row.date,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        }))
        .filter((row) => row.date && Number.isFinite(row.close));

      if (candidateResults.length) {
        symbol = candidate;
        results = candidateResults;
        break;
      }
    }

    if (!results.length) continue;

    const latest = results[results.length - 1] || null;
    const previous = results.length > 1 ? results[results.length - 2] : null;
    const latestClose = Number(latest?.close);
    const previousClose = Number(previous?.close);
    const change = Number.isFinite(latestClose) && Number.isFinite(previousClose)
      ? latestClose - previousClose
      : null;
    const changePct = change !== null && previousClose
      ? (change / previousClose) * 100
      : null;

    out.push({
      ticker: cleanTicker,
      symbol,
      source: "d1_history",
      name: TICKERS[cleanTicker]?.name || cleanTicker,
      latest_close: Number.isFinite(latestClose) ? latestClose : null,
      previous_close: Number.isFinite(previousClose) ? previousClose : null,
      day_change: change !== null ? Number(change.toFixed(4)) : null,
      day_change_pct: changePct !== null ? Number(changePct.toFixed(2)) : null,
      live_quote: null,
      points: results,
    });
  }

  return out;
}

async function fetchLatestQuoteForSymbol(symbol) {
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcvn&e=csv`;
    const res = await fetch(url, {
      headers: { "user-agent": "Minerlytics/1.0" }
    });
    if (!res.ok) return null;

    const text = await res.text();
    const lines = String(text || "").trim().split(/\r?\n/);
    if (lines.length < 2) return null;

    const cols = lines[1].split(",");
    if (cols.length < 8) return null;

    const [
      rawSymbol,
      date,
      time,
      open,
      high,
      low,
      close,
      volume
    ] = cols.map((v) => String(v || "").trim());

    const parsedClose = Number(close);
    if (!rawSymbol || !date || !Number.isFinite(parsedClose)) return null;

    return {
      symbol: rawSymbol.toUpperCase(),
      date,
      time,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: parsedClose,
      volume: Number(volume),
    };
  } catch {
    return null;
  }
}

async function fetchLatestQuoteForTicker(ticker) {
  const yahooHistory = await fetchYahooHistoryForTicker(ticker, 5);
  if (yahooHistory.liveQuote) return yahooHistory.liveQuote;

  for (const candidate of getSymbolCandidates(ticker)) {
    const quote = await fetchLatestQuoteForSymbol(candidate);
    if (quote) return quote;
  }
  return null;
}

async function enrichTrendSeriesWithLatestQuotes(series) {
  const enriched = [];

  for (const item of series) {
    const latestQuote = item?.live_quote || await fetchLatestQuoteForTicker(item.ticker || item.symbol);
    if (!latestQuote) {
      enriched.push({ ...item, live_quote: null });
      continue;
    }

    const points = Array.isArray(item.points) ? item.points.slice() : [];
    const lastPoint = points.length ? points[points.length - 1] : null;
    const sameDay = lastPoint && lastPoint.date === latestQuote.date;

    if (sameDay) {
      points[points.length - 1] = {
        ...points[points.length - 1],
        close: latestQuote.close,
        open: Number.isFinite(latestQuote.open) ? latestQuote.open : points[points.length - 1].open,
        high: Number.isFinite(latestQuote.high) ? latestQuote.high : points[points.length - 1].high,
        low: Number.isFinite(latestQuote.low) ? latestQuote.low : points[points.length - 1].low,
        volume: Number.isFinite(latestQuote.volume) ? latestQuote.volume : points[points.length - 1].volume,
        time: latestQuote.time || null,
        is_live: true,
      };
    } else {
      points.push({
        date: latestQuote.date,
        time: latestQuote.time || null,
        close: latestQuote.close,
        open: Number.isFinite(latestQuote.open) ? latestQuote.open : latestQuote.close,
        high: Number.isFinite(latestQuote.high) ? latestQuote.high : latestQuote.close,
        low: Number.isFinite(latestQuote.low) ? latestQuote.low : latestQuote.close,
        volume: Number.isFinite(latestQuote.volume) ? latestQuote.volume : 0,
        is_live: true,
      });
    }

    const latest = points[points.length - 1] || null;
    const previous = points.length > 1 ? points[points.length - 2] : null;
    const latestClose = Number(latest?.close);
    const previousClose = Number(previous?.close);
    const change = Number.isFinite(latestClose) && Number.isFinite(previousClose)
      ? latestClose - previousClose
      : null;
    const changePct = change !== null && previousClose
      ? (change / previousClose) * 100
      : null;

    enriched.push({
      ...item,
      latest_close: Number.isFinite(latestClose) ? latestClose : item.latest_close,
      previous_close: Number.isFinite(previousClose) ? previousClose : item.previous_close,
      day_change: change !== null ? Number(change.toFixed(4)) : item.day_change,
      day_change_pct: changePct !== null ? Number(changePct.toFixed(2)) : item.day_change_pct,
      live_quote: latestQuote,
      points,
    });
  }

  return enriched;
}

function pickTopItems(arr, max = 8) {
  return Array.isArray(arr) ? arr.slice(0, max) : [];
}

function summarizeMarketData(latest, previous, series) {
  const out = {
    latest: latest || null,
    previous: previous || null,
    observations: [],
  };

  if (latest && previous) {
    const close = Number(latest.close);
    const prevClose = Number(previous.close);

    if (Number.isFinite(close) && Number.isFinite(prevClose) && prevClose !== 0) {
      const delta = close - prevClose;
      const pct = (delta / prevClose) * 100;

      out.observations.push({
        type: "day_change",
        close,
        previous_close: prevClose,
        change: Number(delta.toFixed(4)),
        change_pct: Number(pct.toFixed(2)),
        date: latest.date || null,
      });
    }
  }

  if (Array.isArray(series) && series.length >= 5) {
    const closes = series
      .map((r) => Number(r.close))
      .filter((v) => Number.isFinite(v));

    if (closes.length) {
      const maxClose = Math.max(...closes);
      const minClose = Math.min(...closes);
      out.observations.push({
        type: "recent_range",
        period_points: closes.length,
        min_close: minClose,
        max_close: maxClose,
      });
    }
  }

  return out;
}

function computeWindowPerformance(points, lookbackDays) {
  const arr = Array.isArray(points) ? points : [];
  if (arr.length < 2) return null;

  const safeLookback = Math.min(Math.max(Number(lookbackDays || 30), 1), arr.length - 1);
  const latest = arr[arr.length - 1];
  const base = arr[Math.max(0, arr.length - 1 - safeLookback)];
  const latestClose = Number(latest?.close);
  const baseClose = Number(base?.close);

  if (!Number.isFinite(latestClose) || !Number.isFinite(baseClose) || baseClose === 0) {
    return null;
  }

  const change = latestClose - baseClose;
  const pct = (change / baseClose) * 100;
  return {
    days: safeLookback,
    base_date: base?.date || null,
    latest_date: latest?.date || null,
    change: Number(change.toFixed(4)),
    change_pct: Number(pct.toFixed(2)),
  };
}

async function getAnalysisUniverse(env) {
  const tickers = ANALYSIS_UNIVERSE
    .map((meta) => String(meta.ticker || "").toUpperCase().trim())
    .filter(Boolean);
  const metaByTicker = new Map(ANALYSIS_UNIVERSE.map((meta) => [String(meta.ticker || "").toUpperCase().trim(), meta]));
  const items = [];

  const storedSeries = await getStoredTrendSeriesForTickers(env, tickers, 180).catch(() => []);
  const series = await enrichTrendSeriesWithLatestQuotes(storedSeries).catch(() => storedSeries);
  const marketByTicker = new Map(series.map((item) => [item.ticker, item]));

  const placeholders = tickers.map(() => "?").join(", ");
  const bindTickers = tickers.slice();

  const sentimentRows = placeholders
    ? await env.DB.prepare(
        `SELECT * FROM news_sentiment_summary WHERE ticker IN (${placeholders})`
      ).bind(...bindTickers).all().catch(() => ({ results: [] }))
    : { results: [] };
  const sentimentByTicker = new Map(((sentimentRows && sentimentRows.results) || []).map((row) => [String(row.ticker || "").toUpperCase(), row]));

  const headlineRows = placeholders
    ? await env.DB.prepare(
        `
        SELECT ticker, title, source, published_at, fetched_at, link
        FROM news_items
        WHERE ticker IN (${placeholders})
        ORDER BY
          CASE
            WHEN published_at IS NOT NULL AND published_at != '' THEN published_at
            ELSE fetched_at
          END DESC
        `
      ).bind(...bindTickers).all().catch(() => ({ results: [] }))
    : { results: [] };
  const latestHeadlineByTicker = new Map();
  for (const row of ((headlineRows && headlineRows.results) || [])) {
    const ticker = String(row.ticker || "").toUpperCase().trim();
    if (ticker && !latestHeadlineByTicker.has(ticker)) {
      latestHeadlineByTicker.set(ticker, row);
    }
  }

  const filingRows = placeholders
    ? await env.DB.prepare(
        `
        SELECT
          ticker,
          COUNT(*) AS filing_count,
          MAX(filing_date) AS latest_filing_date
        FROM mining_reports
        WHERE ticker IN (${placeholders})
        GROUP BY ticker
        `
      ).bind(...bindTickers).all().catch(() => ({ results: [] }))
    : { results: [] };
  const filingByTicker = new Map(((filingRows && filingRows.results) || []).map((row) => [String(row.ticker || "").toUpperCase(), row]));

  const transcriptRows = placeholders
    ? await env.DB.prepare(
        `
        SELECT symbol, COUNT(DISTINCT video_id) AS transcript_count
        FROM youtube_video_symbols
        WHERE symbol IN (${placeholders})
        GROUP BY symbol
        `
      ).bind(...bindTickers).all().catch(() => ({ results: [] }))
    : { results: [] };
  const transcriptByTicker = new Map(((transcriptRows && transcriptRows.results) || []).map((row) => [String(row.symbol || "").toUpperCase(), row]));

  for (const ticker of tickers) {
    const meta = metaByTicker.get(ticker);
    if (!meta) continue;
    const market = marketByTicker.get(ticker) || null;
    const points = market?.points || [];

    const perf30 = computeWindowPerformance(points, 30);
    const perf180 = computeWindowPerformance(points, 180);

    const sentimentRow = sentimentByTicker.get(ticker) || null;
    const news = buildNewsDetailFromSummary(sentimentRow);

    const latestHeadline = latestHeadlineByTicker.get(ticker) || null;
    const filingStats = filingByTicker.get(ticker) || null;
    const transcriptStats = transcriptByTicker.get(ticker) || null;

    items.push({
      ticker,
      name: TICKERS[ticker]?.name || ticker,
      metal: meta.metal,
      stage: meta.stage,
      country: meta.country,
      latest_close: market?.latest_close ?? null,
      previous_close: market?.previous_close ?? null,
      day_change: market?.day_change ?? null,
      day_change_pct: market?.day_change_pct ?? null,
      perf_30d: perf30,
      perf_180d: perf180,
      point_count: points.length,
      market_source: market?.source || null,
      live_quote_time: market?.live_quote?.time || null,
      news_mentions: news?.total || 0,
      bullish_pct: news?.bullish_pct ?? null,
      bearish_pct: news?.bearish_pct ?? null,
      latest_news_title: latestHeadline?.title || "",
      latest_news_source: latestHeadline?.source || "",
      latest_news_at: latestHeadline?.published_at || latestHeadline?.fetched_at || null,
      latest_news_link: latestHeadline?.link || "",
      filing_count: Number(filingStats?.filing_count || 0),
      latest_filing_date: filingStats?.latest_filing_date || null,
      transcript_count: Number(transcriptStats?.transcript_count || 0),
    });
  }

  return items.sort((a, b) => {
    const aPerf = Number(a?.perf_30d?.change_pct);
    const bPerf = Number(b?.perf_30d?.change_pct);
    if (Number.isFinite(aPerf) && Number.isFinite(bPerf) && aPerf !== bPerf) {
      return bPerf - aPerf;
    }
    return String(a.ticker).localeCompare(String(b.ticker));
  });
}

function summarizeRssNews(rssItems) {
  const items = pickTopItems(rssItems, 8);
  return {
    item_count: items.length,
    latest_items: items.map((x) => ({
      sid: x.sid,
      title: x.title,
      source: x.source,
      published_at: x.published_at || x.fetched_at || null,
      link: x.link || "",
    })),
  };
}

function summarizeSecFilings(secFilings) {
  const items = pickTopItems(secFilings, 10);
  return {
    item_count: items.length,
    excerpts: items.map((x) => ({
      sid: x.sid,
      filing_date: x.filing_date,
      form: x.form || "",
      primary_document: x.primary_document || "",
      heading: x.heading,
      url: x.url,
      text: String(x.text || "").slice(0, 600),
    })),
  };
}

function summarizeYoutubeTranscripts(transcripts) {
  const items = pickTopItems(transcripts, 10);
  return {
    item_count: items.length,
    excerpts: items.map((x) => ({
      sid: x.sid,
      title: x.title,
      channel: x.channel,
      published_at: x.published_at,
      url: x.url,
      text: String(x.text || "").slice(0, 500),
    })),
  };
}

function buildCrossSourceSummary({ marketData, newsSentiment, rssNews, secFilings, youtubeTranscripts }) {
  return {
    has_market_data: !!marketData?.latest,
    has_news_sentiment: !!newsSentiment,
    has_rss_news: (rssNews?.item_count || 0) > 0,
    has_sec_filings: (secFilings?.item_count || 0) > 0,
    has_youtube_transcripts: (youtubeTranscripts?.item_count || 0) > 0,
  };
}

function buildSourceCoverage(context) {
  return {
    market_data: !!context.market_data?.latest,
    news_sentiment: !!context.news_sentiment,
    rss_news: (context.rss_news?.item_count || 0) > 0,
    sec_filings: (context.sec_filings?.item_count || 0) > 0,
    youtube_transcripts: (context.youtube_transcripts?.item_count || 0) > 0,
  };
}

function buildUnifiedAssistantContext({
  q,
  resolvedTicker,
  intent,
  latest,
  previous,
  series,
  newsDetail,
  rssItems,
  filingMatches,
  transcriptMatches,
}) {
const marketData = summarizeMarketData(latest, previous, series);
const rssNews = summarizeRssNews(rssItems);
const secFilings = summarizeSecFilings(filingMatches);
const youtubeTranscripts = summarizeYoutubeTranscripts(transcriptMatches);

  const context = {
    question: q,
    symbol: resolvedTicker ? normalizeSymbolToStooqUS(resolvedTicker) : null,
    ticker: resolvedTicker || null,
    resolved_ticker: resolvedTicker || null,
    assistant_intent: intent || getAssistantIntent(q),
    market_data: marketData,
    news_sentiment: newsDetail || null,
    rss_news: rssNews,
    sec_filings: secFilings,
    youtube_transcripts: youtubeTranscripts,
  };

  context.cross_source_summary = buildCrossSourceSummary({
    marketData,
    newsSentiment: newsDetail,
    rssNews,
    secFilings,
    youtubeTranscripts,
  });

  context.source_coverage = buildSourceCoverage(context);

  return context;
}

function buildSourceSections(context) {
  const hasStooq =
    !!(context && context.latest) ||
    !!(context && Array.isArray(context.series) && context.series.length);

  const hasRss =
    !!(context && context.news) ||
    !!(context && Array.isArray(context.rss_items) && context.rss_items.length);

  const hasDisclosure =
    !!(context && Array.isArray(context.sec_filings) && context.sec_filings.length);

  const hasYoutube =
    !!(context && Array.isArray(context.youtube_transcripts) && context.youtube_transcripts.length);

  return {
    stooq: hasStooq,
    rss: hasRss,
    mining_disclosure: hasDisclosure,
    youtube_transcripts: hasYoutube,
  };
}

function stableSortValue(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(stableSortValue);

    if (normalized.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      return normalized.sort((a, b) => {
        const aKey = [
          a.sid ?? "",
          a.date ?? a.filingDate ?? a.published_at ?? "",
          a.form ?? "",
          a.title ?? "",
          a.url ?? "",
          JSON.stringify(a),
        ].join("|");

        const bKey = [
          b.sid ?? "",
          b.date ?? b.filingDate ?? b.published_at ?? "",
          b.form ?? "",
          b.title ?? "",
          b.url ?? "",
          JSON.stringify(b),
        ].join("|");

        return aKey.localeCompare(bKey);
      });
    }

    if (normalized.every((v) => ["string", "number", "boolean"].includes(typeof v))) {
      return normalized.sort((a, b) => String(a).localeCompare(String(b)));
    }

    return normalized;
  }

  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSortValue(value[key]);
    }
    return sorted;
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSortValue(value));
}

async function runAssistant(env, question, context) {
  const resolvedTicker =
    String(context?.resolved_ticker || context?.ticker || context?.symbol || "")
      .replace(/\.us$/i, "")
      .toUpperCase()
      .trim() || null;

  const filingQuestion = isFilingQuestion(question);
  const technicalReportQuestion = isTechnicalReportQuestion(question);
  const capabilityQuestion = isCapabilityQuestion(question);
  const intent = context?.assistant_intent || getAssistantIntent(question);

  const normalizedContext = stableSortValue(context || {});
  const normalizedDataString = stableStringify(normalizedContext);
  const allowedSources = Array.isArray(intent.sourceGroups) && intent.sourceGroups.length
    ? intent.sourceGroups.join(", ")
    : "none";

  const system =
    "You are Minerlytics AI.\n" +
    "You are an expert mining-sector research assistant.\n" +
    "You must answer ONLY from the provided DATA.\n" +
    "Answer the user's exact question directly instead of expanding into a broad company memo unless the question explicitly asks for a broad summary.\n\n" +

    "CRITICAL RULES:\n" +
    "- If RESOLVED_TICKER exists, do not ask for a ticker.\n" +
    "- If the question includes a recognizable company name or ticker, answer directly.\n" +
    "- Only ask for clarification when no company or ticker can be resolved at all.\n" +
    "- Never say 'Please mention a ticker symbol' when RESOLVED_TICKER is present.\n" +
    "- Use only facts explicitly present in DATA.\n" +
    "- Never invent facts, numbers, mine names, dates, plans, guidance, commentary, or risks.\n" +
    "- If information is missing, write exactly: 'Not available'.\n" +
    "- If something is not explicitly stated in DATA, write exactly: 'Not available as explicitly stated in the provided data.'\n" +
    "- Do not provide investment advice.\n" +
    "- Do not output internal mode labels like 'COMPANY RESEARCH MODE'.\n" +
    "- Use stable wording.\n" +
    "- Prefer short factual sentences over paraphrased summaries.\n" +
    "- When the same question and same DATA are provided, keep the same structure and phrasing as much as possible.\n\n" +

    "INTENT RULES:\n" +
    `- Detected answer style: ${intent.answerStyle || "direct_answer"}.\n` +
    `- Primary source group: ${intent.primarySource || "mixed"}.\n` +
    `- Allowed source groups for this answer: ${allowedSources}.\n` +
    "- Do not use source groups that are not listed as allowed, even if they appear in DATA.\n" +
    "- If answer style is direct_answer, start with a concise answer in 1-3 sentences, then include only brief evidence bullets and sources.\n" +
    "- If answer style is research_brief, use the broader section format only when the user asked for an overview, full analysis, company memo, or 'tell me about'.\n" +
    "- Never include market, news, filing, and transcript sections together for a narrow single-source question.\n\n" +

    "CAPABILITY QUESTION RULES:\n" +
    "- If the user asks what they can ask about a company or how you can help, do not generate a research summary.\n" +
    "- Instead, return a short capability-oriented answer with concrete example questions tailored to the resolved ticker.\n" +
    "- In capability answers, do not include market/news/transcript/disclosure sections unless the user explicitly asked for analysis.\n" +
    "- Capability answers should help the user continue the conversation with better prompts.\n\n" +

    "MANDATORY SOURCE COVERAGE RULE:\n" +
    "- Inspect the source groups present in DATA and use only the ones needed to answer the exact question.\n" +
    "- Do not add unrelated sections just because extra data is available.\n" +
    "- Keep source categories separate.\n" +
    "- Do not mix transcript commentary into SEC filing facts.\n" +
    "- Do not mix market data into disclosure facts.\n\n" +

    "FILING QUESTION RULES:\n" +
    "- If the user asks about a filing, form, 40-F, 10-K, 10-Q, annual report, technical report, or disclosure document, prioritize DATA.sec_filings first.\n" +
    "- If DATA.sec_filings contains matching filing excerpts or metadata, answer from those excerpts before using other categories.\n" +
    "- If a filing form is present in DATA.sec_filings.form or DATA.sec_filings.primary_document, treat that as valid evidence even if the exact phrase is not repeated in the excerpt text.\n" +
    "- Do not say 'not available' if the filing metadata clearly indicates a matching form exists.\n\n" +

    "SOURCE GROUPS TO CHECK:\n" +
    "- DATA.market_data\n" +
    "- DATA.news_sentiment\n" +
    "- DATA.rss_news\n" +
    "- DATA.sec_filings\n" +
    "- DATA.youtube_transcripts\n" +
    "- DATA.cross_source_summary\n" +
    "- DATA.source_coverage\n\n" +

    "OUTPUT FORMAT:\n" +
    (capabilityQuestion
      ? "1. ✅ What You Can Ask\n" +
        "2. 💡 Good Questions to Try\n" +
        "3. 🏷️ Sources Available\n" +
        "4. 🧾 Disclaimer\n\n"
      : technicalReportQuestion
      ? "1. 📄 Direct Answer\n" +
        "2. 📚 Technical Reports Found\n" +
        "3. 🏷️ Sources Used\n" +
        "4. 🧾 Disclaimer\n\n"
      : filingQuestion
        ? "1. 📄 Direct Answer\n" +
          "2. 📄 Filing / Disclosure Details\n" +
          "3. 🏷️ Sources Used\n" +
          "4. 🧾 Disclaimer\n\n"
        : intent.answerStyle === "direct_answer"
          ? "1. ✅ Direct Answer\n" +
            "2. 🔎 Evidence\n" +
            "3. 🏷️ Sources Used\n" +
            "4. 🧾 Disclaimer\n\n"
          : "1. 📌 Executive Summary\n" +
            "2. 📄 Technical Reports / Mining Disclosure\n" +
            "3. 📈 Market Data\n" +
            "4. 📰 News / RSS\n" +
            "5. 🎥 YouTube Transcripts\n" +
            "6. 🔗 Cross-Source Takeaways\n" +
            "7. ⚠️ Risks & Opportunities\n" +
            "8. 🏷️ Sources Used\n" +
            "9. 🧾 Disclaimer\n\n") +

    "SECTION RULES:\n" +
    "- Include only sections needed for the question.\n" +
    "- If a section has no available data, omit it.\n" +
    "- In capability answers, list the types of analysis available and 6-10 example user questions tailored to RESOLVED_TICKER.\n" +
    "- In capability answers, prefer question examples over narrative explanation.\n" +
    "- In Executive Summary, summarize only the most explicit points across available source groups.\n" +
    "- In Technical Reports / Mining Disclosure, use only DATA.sec_filings.\n" +
    "- In Market Data, use only DATA.market_data.\n" +
    "- In News / RSS, use only DATA.news_sentiment and DATA.rss_news.\n" +
    "- In YouTube Transcripts, use only DATA.youtube_transcripts and clearly label this as commentary/discussion if appropriate.\n" +
    "- In Cross-Source Takeaways, compare themes across at least two source groups.\n" +
    "- In Risks & Opportunities, remain grounded in DATA. Any inference must begin with exactly 'Interpretation:'.\n" +
    "- Do not rename sections.\n" +
    "- Do not add extra emoji headings.\n" +
    "- Do not vary capitalization of section titles.\n\n" +

    "CITATION RULES:\n" +
    "- If using SEC excerpts, cite sid and url.\n" +
    "- If using transcript excerpts, cite sid and url.\n" +
    "- Do not fabricate citations.\n\n" +

    "FINAL DISCLAIMER RULE:\n" +
    'The disclaimer must be exactly:\n"this information is for research purposes only and does not constitute investment advice."';

  const userPrompt =
    "IMPORTANT:\n" +
    "- Answer the exact question asked.\n" +
    "- Do not broaden the answer into unrelated company context.\n" +
    "- Use only the minimum relevant source categories needed for the question.\n" +
    `- Use only these allowed source groups: ${allowedSources}.\n` +
    `- Answer style: ${intent.answerStyle || "direct_answer"}.\n` +
    "- Do not ask for ticker if RESOLVED_TICKER is present.\n" +
    "- Keep the response deterministic and consistent for the same question and same DATA.\n" +
    "- Prefer extractive, factual wording over creative paraphrasing.\n" +
    (capabilityQuestion
      ? "- This is a capability question. Do not give a company memo. Provide example questions the user can ask next about the resolved ticker.\n"
      : "") +
    (technicalReportQuestion
      ? "- This is a technical-report lookup. Focus on identifying technical reports or explicitly state that none were found in the provided filing data.\n"
      : "") +
    (filingQuestion
      ? "- This is a filing-focused question. Prioritize DATA.sec_filings and explain the relevant filing/disclosure details first.\n"
      : "") +
    "\n" +
    `RESOLVED_TICKER: ${resolvedTicker || "Not available"}\n\n` +
    "User question:\n" +
    (question || "Provide a detailed research summary based on available data.") +
    "\n\nDATA:\n" +
    normalizedDataString;

  const result = await env.AI.run(WORKERS_AI_CHAT_MODEL, {
    prompt: system + "\n\n" + userPrompt,
    max_tokens: 1000,
    temperature: 0,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  });

  const rawAnswer =
    (typeof result === "string" && result) ||
    (result && (result.response || result.result || result.output_text)) ||
    JSON.stringify(result);

  const DISCLAIMER =
    "this information is for research purposes only and does not constitute investment advice.";

  if (!rawAnswer.toLowerCase().includes(DISCLAIMER)) {
    return rawAnswer.trim() + "\n\n🧾 Disclaimer\n" + DISCLAIMER;
  }

  return rawAnswer;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // =========================
// 🔐 AUTH ROUTES
// =========================

// SIGNUP
if (url.pathname === "/api/signup" && request.method === "POST") {
  const { firstName, lastName, email, password } = await request.json();
  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();

  if (!first || !last || !email || !password)
    return json({ ok: false, error: "First name, last name, email, and password are required" }, 400);

  if (password.length < 6)
    return json({ ok: false, error: "Password must be at least 6 characters" }, 400);

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?"
  ).bind(email.toLowerCase()).first();

  if (existing)
    return json({ ok: false, error: "Email already exists" }, 409);

  const userId = crypto.randomUUID();
  const passwordHash = await sha256(password + env.AUTH_SECRET);
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO users (id, first_name, last_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(userId, first, last, email.toLowerCase(), passwordHash, now).run();

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now, expiresAt).run();

  const notificationPayload = {
    event: "user_signup",
    occurred_at: now,
    app: "Minerlytics",
    user: {
      id: userId,
      first_name: first,
      last_name: last,
      email: email.toLowerCase(),
      display_name: `${first} ${last}`.trim()
    }
  };

  // Keep signup reliable even if the notification destination is down.
  try {
    await sendSignupNotification(env, notificationPayload);
  } catch {
    // ignore notification failures
  }

  return json(
  {
    ok: true,
    email,
    first_name: first,
    last_name: last,
    display_name: `${first} ${last}`.trim()
  },
  200,
  { "Set-Cookie": makeSessionCookie(sessionId) },
  request
);
}

// LOGIN
if (url.pathname === "/api/login" && request.method === "POST") {
  const { email, password } = await request.json();

  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).bind(email.toLowerCase()).first();

  if (!user)
    return json({ ok: false, error: "Invalid login" }, 401);

  const passwordHash = await sha256(password + env.AUTH_SECRET);

  if (passwordHash !== user.password_hash)
    return json({ ok: false, error: "Invalid login" }, 401);

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, user.id, now, expiresAt).run();

  const displayName = buildUserDisplayName(user);

  return json(
  {
    ok: true,
    email: user.email,
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    display_name: displayName
  },
  200,
  { "Set-Cookie": makeSessionCookie(sessionId) },
  request
);
}

// CHANGE PASSWORD
if (url.pathname === "/api/change-password" && request.method === "POST") {
  const sessionId = getCookie(request, "minerlytics_session");

  if (!sessionId) {
    return json({ ok: false, error: "Not logged in" }, 401);
  }

  const sessionUser = await env.DB.prepare(`
    SELECT users.id, users.first_name, users.last_name, users.email, users.password_hash
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  if (!sessionUser) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");
  const confirmPassword = String(body.confirmPassword || "");

  if (!currentPassword || !newPassword || !confirmPassword) {
    return json({ ok: false, error: "All password fields are required" }, 400);
  }

  if (newPassword.length < 6) {
    return json({ ok: false, error: "New password must be at least 6 characters" }, 400);
  }

  if (newPassword !== confirmPassword) {
    return json({ ok: false, error: "New passwords do not match" }, 400);
  }

  const currentHash = await sha256(currentPassword + env.AUTH_SECRET);
  if (currentHash !== sessionUser.password_hash) {
    return json({ ok: false, error: "Current password is incorrect" }, 401);
  }

  const newHash = await sha256(newPassword + env.AUTH_SECRET);
  if (newHash === sessionUser.password_hash) {
    return json({ ok: false, error: "New password must be different from current password" }, 400);
  }

  await env.DB.prepare(`
    UPDATE users
    SET password_hash = ?
    WHERE id = ?
  `).bind(newHash, sessionUser.id).run();

  return json({ ok: true, email: sessionUser.email, message: "Password updated successfully" }, 200, {}, request);
}

// CHECK USER
if (url.pathname === "/api/me" && request.method === "GET") {
  const sessionId = getCookie(request, "minerlytics_session");

  if (!sessionId)
    return json({ loggedIn: false });

  const user = await env.DB.prepare(`
    SELECT users.id, users.first_name, users.last_name, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  if (!user)
    return json({ loggedIn: false });

  return json({
    loggedIn: true,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      display_name: buildUserDisplayName(user)
    }
  });
}

if (url.pathname === "/api/watchlist" && request.method === "GET") {
  const sessionId = getCookie(request, "minerlytics_session");

  if (!sessionId) {
    return json({ ok: false, error: "Not logged in" }, 401);
  }

  const user = await env.DB.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  if (!user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }

  const rows = await env.DB.prepare(`
    SELECT symbol, created_at
    FROM user_watchlist
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(user.id).all();

  return json({
    ok: true,
    user,
    watchlist: rows.results || []
  });
}

// watchlist

if (url.pathname === "/api/watchlist/add" && request.method === "POST") {
  const sessionId = getCookie(request, "minerlytics_session");

  if (!sessionId) {
    return json({ ok: false, error: "Not logged in" }, 401);
  }

  const user = await env.DB.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  if (!user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const symbol = String(body.symbol || "").trim().toUpperCase();

  if (!symbol) {
    return json({ ok: false, error: "Symbol required" }, 400);
  }

  const existingRows = await env.DB.prepare(`
    SELECT symbol
    FROM user_watchlist
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(user.id).all().catch(() => ({ results: [] }));

  const existingItems = (existingRows && existingRows.results) || [];
  const alreadySaved = existingItems.some((item) => item.symbol === symbol);
  if (!alreadySaved && existingItems.length >= 5) {
    return json({ ok: false, error: "You can save up to 5 favorite tickers." }, 400);
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO user_watchlist (id, user_id, symbol, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), user.id, symbol, new Date().toISOString()).run();

  return json({ ok: true, symbol });
}

if (url.pathname === "/api/watchlist/remove" && request.method === "POST") {
  const sessionId = getCookie(request, "minerlytics_session");

  if (!sessionId) {
    return json({ ok: false, error: "Not logged in" }, 401);
  }

  const user = await env.DB.prepare(`
    SELECT users.id
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ? AND sessions.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  if (!user) {
    return json({ ok: false, error: "Invalid session" }, 401);
  }

  const body = await request.json().catch(() => ({}));
  const symbol = String(body.symbol || "").trim().toUpperCase();

  await env.DB.prepare(`
    DELETE FROM user_watchlist
    WHERE user_id = ? AND symbol = ?
  `).bind(user.id, symbol).run();

  return json({ ok: true, symbol });
}

// LOGOUT
if (url.pathname === "/api/logout" && request.method === "POST") {
  const sessionId = getCookie(request, "minerlytics_session");

  if (sessionId) {
    await env.DB.prepare(
      "DELETE FROM sessions WHERE id = ?"
    ).bind(sessionId).run();
  }

  return json({ ok: true }, 200, {
    "Set-Cookie": "minerlytics_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0"
  }, request);
}

if (url.pathname === "/api/contact" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const subject = String(body.subject || "").trim();
  const message = String(body.message || "").trim();

  if (!name || !email || !subject || !message) {
    return json({ ok: false, error: "Name, email, subject, and message are required." }, 400, {}, request);
  }

  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailLooksValid) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400, {}, request);
  }

  if (!env.DB) {
    return json({ ok: false, error: "Missing D1 binding 'DB'." }, 500, {}, request);
  }

  const feedbackId = crypto.randomUUID();
  const submittedAt = new Date().toISOString();

  try {
    await env.DB.prepare(`
      INSERT INTO contact_feedback (
        id,
        name,
        email,
        subject,
        message,
        submitted_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      feedbackId,
      name,
      email.toLowerCase(),
      subject,
      message,
      submittedAt
    ).run();
  } catch (err) {
    return json(
      { ok: false, error: "Feedback could not be saved right now.", detail: String(err) },
      500,
      {},
      request
    );
  }

  return json(
    { ok: true, id: feedbackId, message: "Thank you. Your feedback has been received." },
    200,
    {},
    request
  );
}

      if (request.method === "OPTIONS" && url.pathname === "/api/education-portal-chat") {
        return educationOptions();
      }

      if (request.method === "OPTIONS") return options(request);

      if (url.pathname === "/api/education-portal-chat" && request.method === "POST") {
        return handleEducationPortalChat(request, env);
      }

      if (url.pathname === "/api/education-portal-chat" && request.method === "GET") {
        return json({ ok: true, route: "education-portal-chat" }, 200);
      }

      if (url.pathname === "/api/health") {
        return text("Minerlytics DEV is running ✅ v2026");
      }

      if (url.pathname === "/api/d1-test") {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM daily_ohlcv").first();
        return json({ ok: true, rows_in_daily_ohlcv: r && r.n ? r.n : 0 });
      }

      if (url.pathname === "/api/youtube/config" && request.method === "GET") {
        return json({ ok: true, youtube: YOUTUBE }, 200);
      }

      if (url.pathname === "/api/news/trending" && request.method === "GET") {
        const symbols = parseSymbolsParam(url.searchParams.get("symbols") || "");
        const maxCards = clamp(parseInt(url.searchParams.get("limit") || "6", 10), 1, 12);

        const tickers = (symbols.length ? symbols : Object.keys(TICKERS))
          .map((t) => String(t || "").toUpperCase().trim())
          .filter((t) => !!TICKERS[t])
          .slice(0, 20);

        if (!tickers.length) return json({ cards: [] }, 200);

        const cards = [];
        for (const t of tickers) {
          const card = await getLatestNewsCardForTicker(env, t);
          if (card) cards.push(card);
          if (cards.length >= maxCards) break;
        }

        return json({ cards }, 200);
      }

      if (url.pathname === "/api/news/latest-feed" && request.method === "GET") {
        const symbols = parseSymbolsParam(url.searchParams.get("symbols") || "");
        const limit = clamp(parseInt(url.searchParams.get("limit") || "12", 10), 1, 24);
        const days = clamp(parseInt(url.searchParams.get("days") || "60", 10), 1, 365);
        const items = await getLatestUniverseNewsItems(env, symbols, limit, days).catch(() => []);

        return json({
          ok: true,
          days,
          symbols: symbols.length ? symbols : Object.keys(TICKERS),
          items
        }, 200);
      }

      if (url.pathname === "/api/company-website-news" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) return json({ ok: false, error: "unknown ticker" }, 400);
        const limit = clamp(parseInt(url.searchParams.get("limit") || "8", 10), 1, 25);
        const items = await getWebsiteInvestorNewsForTicker(env, ticker, limit).catch(() => []);

        return json({
          ok: true,
          ticker,
          source: "website_investor_news",
          items
        }, 200);
      }

      if (url.pathname === "/api/market/sync" && request.method === "POST") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const body = await request.json().catch(() => ({}));
        const requested = Array.isArray(body.symbols)
          ? body.symbols
          : parseSymbolsParam(body.symbols || "");
        const tickers = (requested.length ? requested : Object.keys(TICKERS))
          .map((t) => String(t || "").toUpperCase().trim())
          .filter((t) => !!TICKERS[t]);
        const limitDays = clamp(parseInt(body.days || "180", 10), 30, 365);

        const results = await refreshMarketHistoryForUniverse(env, tickers, limitDays);
        return json({
          ok: true,
          tickers,
          days: limitDays,
          results,
        }, 200);
      }

      if (url.pathname === "/api/news/sync" && request.method === "POST") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        await refreshNewsForAll(env);

        return json({
          ok: true,
          tickers: Object.keys(TICKERS).length,
          refreshed_at: new Date().toISOString(),
        }, 200);
      }

      if (url.pathname === "/api/market/top-trends" && request.method === "GET") {
        const requested = parseSymbolsParam(url.searchParams.get("symbols") || "");
        const defaultTickers = ["AEM", "WPM", "CDE", "HYMC", "GFI"];
        const limitDays = clamp(parseInt(url.searchParams.get("days") || "180", 10), 30, 365);

        const tickers = (requested.length ? requested : defaultTickers)
          .map((t) => String(t || "").toUpperCase().trim())
          .filter(Boolean)
          .slice(0, 5);

        const historicalSeries = await getTrendSeriesForTickers(env, tickers, limitDays);
        const series = await enrichTrendSeriesWithLatestQuotes(historicalSeries);
        const usedFallback = series.some((item) => item.source === "d1_history");

        return json({
          ok: true,
          window_days: limitDays,
          source: usedFallback ? "live_history_with_d1_fallback" : "live_history_plus_live_quote",
          tickers: series
        }, 200);
      }

      if (url.pathname === "/api/youtube/recent" && request.method === "GET") {
        const symbols = parseSymbolsParam(url.searchParams.get("symbols") || "");
        const limit = clamp(parseInt(url.searchParams.get("limit") || "8", 10), 1, 20);
        const days = clamp(parseInt(url.searchParams.get("days") || "60", 10), 1, 365);
        let videos = await getRecentYoutubeVideosForTickers(env, symbols, limit, days);
        let source = "database_recent";
        if (!Array.isArray(videos) || !videos.length) {
          videos = await getFallbackYoutubeCoverage(limit).catch(() => []);
          if (videos.length) source = "live_channel_fallback";
        }

        return json({
          ok: true,
          days,
          symbols,
          source,
          videos,
        }, 200);
      }

      if (url.pathname === "/api/universe/map" && request.method === "GET") {
        const symbols = parseSymbolsParam(url.searchParams.get("symbols") || "");
        const limit = clamp(parseInt(url.searchParams.get("limit") || "18", 10), 1, 30);
        const markers = await getUniverseMapMarkers(env, symbols.length ? symbols : Object.keys(TICKERS), limit).catch(() => []);

        return json({
          ok: true,
          source: "40-f mining disclosure",
          symbols: symbols.length ? symbols : Object.keys(TICKERS),
          markers,
        }, 200);
      }

      if (url.pathname === "/api/company-detail" && request.method === "GET") {
        const ticker = String(url.searchParams.get("ticker") || "").toUpperCase().trim();
        if (!ticker || !TICKERS[ticker]) {
          return json({ ok: false, error: "unknown ticker" }, 400);
        }

        const marketBase = await getTrendSeriesForTickers(env, [ticker], 180).catch(() => []);
        const marketSeries = marketBase.length
          ? await enrichTrendSeriesWithLatestQuotes(marketBase).catch(() => marketBase)
          : [];
        const market = marketSeries[0] || null;
        const points = Array.isArray(market?.points) ? market.points : [];

        const sentimentRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first().catch(() => null);
        const newsDetail = buildNewsDetailFromSummary(sentimentRow);
        const rssItems = await getLatestRssItemsForTicker(env, ticker, 8).catch(() => []);
        const videos = await getRecentYoutubeVideosForTickers(env, [ticker], 8, 60).catch(() => []);

        const productionExcerpts = await getMiningDisclosureMatches(env, ticker, `${ticker} production ounces produced ounce ounces quarter quarterly`, 6).catch(() => []);
        const mineExcerpts = await getMiningDisclosureMatches(env, ticker, `${ticker} mine project operation location grade ounces produced`, 8).catch(() => []);
        const managementExcerpts = await getMiningDisclosureMatches(env, ticker, `${ticker} management discussion strategy operations capital allocation quarterly results`, 6).catch(() => []);
        const riskExcerpts = await getMiningDisclosureMatches(env, ticker, `${ticker} risk risks uncertainty inflation permitting environmental`, 6).catch(() => []);
        const forwardLookingExcerpts = await getTranscriptMatches(env, ticker, `${ticker} outlook guidance forward looking expect anticipate plan`, 8).catch(() => []);
        const latestFilings = await getLatestDisclosureBlocksForTicker(env, ticker, 8).catch(() => []);

        const description = await buildCompanyDescription(env, {
          ticker,
          name: TICKERS[ticker]?.name || ticker,
          market_summary: {
            latest_close: market?.latest_close ?? null,
            day_change_pct: market?.day_change_pct ?? null,
            perf_30d: computeWindowPerformance(points, 30),
            perf_180d: computeWindowPerformance(points, 180),
          },
          sentiment_summary: newsDetail,
          rss_items: rssItems.slice(0, 5),
          production_excerpts: productionExcerpts.slice(0, 4),
          mine_excerpts: mineExcerpts.slice(0, 4),
          management_excerpts: managementExcerpts.slice(0, 4),
          risk_excerpts: riskExcerpts.slice(0, 4),
          forward_looking_excerpts: forwardLookingExcerpts.slice(0, 4),
          latest_filings: latestFilings.slice(0, 4),
        });

        const aiSections = {
          description,
          ounces_produced_past_quarter: buildUserFriendlySection(productionExcerpts, "production", "Not available."),
          mine_details: buildUserFriendlySection(mineExcerpts, "mine", "Not available."),
          management_summary: buildUserFriendlySection(managementExcerpts, "management", "Not available."),
          risks: buildUserFriendlySection(riskExcerpts, "risk", "Not available."),
          forward_looking_statement: buildUserFriendlySection(forwardLookingExcerpts, "forward", "Not available."),
        };

        return json({
          ok: true,
          ticker,
          name: TICKERS[ticker]?.name || ticker,
          market: market
            ? {
                ticker: market.ticker,
                symbol: market.symbol,
                source: market.source,
                latest_close: market.latest_close,
                previous_close: market.previous_close,
                day_change: market.day_change,
                day_change_pct: market.day_change_pct,
                live_quote: market.live_quote || null,
                points,
                perf_30d: computeWindowPerformance(points, 30),
                perf_180d: computeWindowPerformance(points, 180),
              }
            : null,
          sentiment: newsDetail,
          sentiment_explanation: buildSentimentExplanation(ticker, newsDetail),
          rss_items: rssItems,
          videos,
          filing_excerpts: {
            latest: latestFilings,
            production: productionExcerpts,
            mines: mineExcerpts,
            management: managementExcerpts,
            risks: riskExcerpts,
          },
          transcript_excerpts: {
            forward_looking: forwardLookingExcerpts,
          },
          ai_sections: aiSections,
        }, 200);
      }

      if (url.pathname === "/api/analysis/overview" && request.method === "GET") {
        const items = await getAnalysisUniverse(env);
        return json({
          ok: true,
          as_of: new Date().toISOString(),
          items,
        }, 200);
      }

      if (url.pathname === "/api/youtube/seen" && request.method === "GET") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const video_id = String(url.searchParams.get("video_id") || "").trim();
        if (!video_id) return json({ ok: false, error: "video_id required" }, 400);

        const row = await env.DB.prepare(
          "SELECT video_id FROM youtube_videos WHERE video_id = ?"
        ).bind(video_id).first();

        if (!row) return json({ seen: false }, 200);

        const symbols = await env.DB.prepare(
          "SELECT symbol FROM youtube_video_symbols WHERE video_id = ?"
        ).bind(video_id).all();

        return json(
          { seen: true, symbols: (symbols.results || []).map((r) => r.symbol) },
          200
        );
      }

      if (url.pathname === "/api/ingest/youtube" && request.method === "POST") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON" }, 400);
        }

        const video_id = body.video_id;
        if (!video_id) return json({ ok: false, error: "video_id required" }, 400);

        const title = body.title || "";
        const channel = body.channel || "";
        const published_at = body.published_at || "";
        const urlStr = body.url || "";
        const segments = Array.isArray(body.segments) ? body.segments : [];
        const symbol_tags = Array.isArray(body.symbol_tags) ? body.symbol_tags : [];

        const stmts = [];

        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO youtube_videos (video_id, title, channel, published_at, url)
VALUES (?, ?, ?, ?, ?)`
          ).bind(video_id, title, channel, published_at, urlStr)
        );

        for (const sym of symbol_tags) {
          if (!sym) continue;
          stmts.push(
            env.DB.prepare(
              `INSERT OR IGNORE INTO youtube_video_symbols (video_id, symbol)
VALUES (?, ?)`
            ).bind(video_id, String(sym).toUpperCase())
          );
        }

        for (const s of segments) {
          if (!s || typeof s.text !== "string") continue;
          const start = Number(s.start ?? 0);
          const duration = Number(s.duration ?? 0);
          const textVal = s.text;

          stmts.push(
            env.DB.prepare(
              `INSERT INTO youtube_segments (video_id, start, duration, text)
VALUES (?, ?, ?, ?)`
            ).bind(video_id, start, duration, textVal)
          );
        }

        try {
          await env.DB.batch(stmts);
        } catch (e) {
          return json({ ok: false, error: "DB error", detail: String(e) }, 500);
        }

        return json({ ok: true, video_id, segments: segments.length }, 200);
      }

      // Transcript existence check
      if (path === "/api/youtube-transcript/exists" && request.method === "GET") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const video_id = url.searchParams.get("video_id");
        if (!video_id) return json({ ok: false, error: "video_id required" }, 400);

        const row = await env.DB.prepare(
          "SELECT video_id FROM youtube_transcripts WHERE video_id = ?"
        ).bind(video_id).first();

        return json({ ok: true, exists: !!row });
      }

      // Full transcript ingest route
      if (path === "/api/ingest/youtube-transcript" && request.method === "POST") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const {
          video_id,
          title,
          channel_id,
          channel_title,
          published_at,
          video_url,
          transcript_text,
          transcript_language,
          is_generated,
        } = body || {};

        if (!video_id || !transcript_text) {
          return json({ ok: false, error: "video_id and transcript_text required" }, 400);
        }

        try {
          await env.DB.prepare(`
            INSERT INTO youtube_transcripts (
              video_id,
              title,
              channel_id,
              channel_title,
              published_at,
              video_url,
              transcript_text,
              transcript_language,
              is_generated,
              inserted_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(video_id) DO UPDATE SET
              title = excluded.title,
              channel_id = excluded.channel_id,
              channel_title = excluded.channel_title,
              published_at = excluded.published_at,
              video_url = excluded.video_url,
              transcript_text = excluded.transcript_text,
              transcript_language = excluded.transcript_language,
              is_generated = excluded.is_generated,
              updated_at = datetime('now')
          `).bind(
            video_id,
            title || null,
            channel_id || null,
            channel_title || null,
            published_at || null,
            video_url || null,
            transcript_text,
            transcript_language || null,
            is_generated ? 1 : 0
          ).run();
        } catch (e) {
          return json({ ok: false, error: "DB error", detail: String(e) }, 500);
        }

        return json({ ok: true, video_id });
      }

      if (url.pathname === "/api/ai/search" && request.method === "GET") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const q = String(url.searchParams.get("q") || "").trim();
        const providedSymbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1),
          50
        );

        if (!q) return json({ ok: false, error: "q required" }, 400);

        const resolvedTicker = resolveTicker({
          explicitTicker: providedSymbol,
          question: q,
        });

        const results = await getTranscriptMatches(env, resolvedTicker, q, limit);
        const filingResults = await getMiningDisclosureMatches(env, resolvedTicker || null, q, limit);
        const rssItems = resolvedTicker ? await getLatestRssItemsForTicker(env, resolvedTicker, 8) : [];

        return json(
          {
            ok: true,
            q,
            symbol: resolvedTicker || null,
            results,
            sec_filing_matches: filingResults,
            rss_items: rssItems,
            source_sections: {
              stooq: false,
              rss: rssItems.length > 0,
              mining_disclosure: filingResults.length > 0,
              youtube_transcripts: results.length > 0,
            },
          },
          200
        );
      }

      if (url.pathname === "/api/ai/ask" && request.method === "POST") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const body = await request.json().catch(() => ({}));
        const q = String(body.q || "").trim();
        const providedSymbol = String(body.symbol || "").trim().toUpperCase();
        const limit = Math.min(
          Math.max(parseInt(body.limit || "20", 10), 1),
          50
        );

        if (!q) return json({ ok: false, error: "q required" }, 400);

        const resolvedTicker = resolveTicker({
          explicitTicker: providedSymbol,
          question: q,
        });
        const filingQuestion = isFilingQuestion(q);

        const transcriptMatches = await getTranscriptMatches(env, resolvedTicker, q, limit);
        const filingMatches = await getMiningDisclosureMatches(env, resolvedTicker || null, q, limit);

        let rssItems = [];
        let newsDetail = null;
        let stooqLatest = null;
        let stooqPrevious = null;
        let stooqSeries = [];

        if (resolvedTicker && !filingQuestion) {
          rssItems = await getLatestRssItemsForTicker(env, resolvedTicker, 8);

          const sentimentRow = await env.DB.prepare(
            "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
          ).bind(resolvedTicker).first();

          newsDetail = buildNewsDetailFromSummary(sentimentRow);

          stooqSeries = await getStooqSeriesForTicker(env, resolvedTicker, 60);
          stooqLatest = stooqSeries[0] || null;
          stooqPrevious = stooqSeries.length > 1 ? stooqSeries[1] : null;
        }

        const context = buildUnifiedAssistantContext({
          q,
          resolvedTicker,
          latest: stooqLatest,
          previous: stooqPrevious,
          series: stooqSeries,
          newsDetail,
          rssItems,
          filingMatches,
          transcriptMatches,
        });

        const answer = await runAssistant(env, q, context);

        return json(
          {
            ok: true,
            q,
            symbol: resolvedTicker || null,
            answer,
            context,
            youtube_matches: transcriptMatches,
            sec_filing_matches: filingMatches,
            rss_items: rssItems,
            stooq_latest: stooqLatest,
            stooq_series: stooqSeries,
            source_sections: buildSourceSections({
              latest: stooqLatest,
              series: stooqSeries,
              news: newsDetail,
              rss_items: rssItems,
              sec_filings: filingMatches,
              youtube_transcripts: transcriptMatches,
            }),
          },
          200
        );
      }

      if (url.pathname === "/api/sec/search" && request.method === "GET") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const q = String(url.searchParams.get("q") || "").trim();
        const providedSymbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1),
          50
        );

        const resolvedTicker = resolveTicker({
          explicitTicker: providedSymbol,
          question: q,
        });

        const results = await getMiningDisclosureMatches(env, resolvedTicker || null, q, limit);
        return json({ ok: true, q, symbol: resolvedTicker || null, results }, 200);
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
        return text(
          'OK. Use POST /api/assistant with JSON body like {"symbol":"HYMC","question":"Tell me about HYMC"} or {"question":"Tell me about AEM"}'
        );
      }

      if (url.pathname === "/api/assistant" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));

        const question = String(body.question || "").trim();
        const providedSymbol = String(body.symbol || "").trim().toUpperCase();
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const favoriteTickers = Array.isArray(body.favoriteTickers) ? body.favoriteTickers : [];

        if (isConversationalQuestion(question)) {
          return json({
            symbol: null,
            ticker: null,
            answer: buildConversationalAnswer(question, favoriteTickers),
            context: {
              question,
              assistant_intent: {
                conversational: true,
                primarySource: "conversation",
                sourceGroups: [],
                answerStyle: "conversational",
              },
            },
            source_sections: {
              stooq: false,
              rss: false,
              mining_disclosure: false,
              youtube_transcripts: false,
            },
          });
        }

        const resolvedTicker = resolveAssistantTicker({
          explicitTicker: providedSymbol,
          explicitSymbol: providedSymbol,
          question,
          messages,
          favoriteTickers,
        });
        const intent = getAssistantIntent(question);
        const capabilityQuestion = intent.capability;

        if (!resolvedTicker) {
          const favoriteHint = favoriteTickers.length
            ? ` Your saved tickers are: ${favoriteTickers.join(", ")}.`
            : "";
          return json({
            error:
              "I could not identify the company or ticker from your question. Please mention either a ticker or company name, for example: AEM, Agnico Eagle, HYMC, or Coeur Mining." + favoriteHint,
          }, 400);
        }

        const symbol = normalizeSymbolToStooqUS(resolvedTicker);

        let stooqSeries = [];
        let latest = null;
        let previous = null;
        let newsDetail = null;
        let rssItems = [];

        if (intent.sourceGroups.includes("market_data")) {
          stooqSeries = await getStooqSeriesForTicker(env, resolvedTicker, 60);
          latest = stooqSeries[0] || null;
          previous = stooqSeries.length > 1 ? stooqSeries[1] : null;
        }

        if (intent.sourceGroups.includes("news_sentiment") || intent.sourceGroups.includes("rss_news")) {
          const sentimentRow = await env.DB.prepare(
            "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
          ).bind(resolvedTicker).first();

          newsDetail = buildNewsDetailFromSummary(sentimentRow);
          rssItems = await getLatestRssItemsForTicker(env, resolvedTicker, 8);
        }

        const transcriptMatches = intent.sourceGroups.includes("youtube_transcripts")
          ? await getTranscriptMatches(env, resolvedTicker, question || resolvedTicker, intent.broad ? 12 : 8)
          : [];
        const filingMatches = intent.sourceGroups.includes("sec_filings")
          ? await getMiningDisclosureMatches(env, resolvedTicker, question || resolvedTicker, intent.broad ? 12 : 8)
          : [];

        const context = buildUnifiedAssistantContext({
          q: question,
          resolvedTicker,
          intent,
          latest,
          previous,
          series: stooqSeries,
          newsDetail,
          rssItems,
          filingMatches,
          transcriptMatches,
        });

        if (capabilityQuestion) {
          return json({
            symbol,
            ticker: resolvedTicker,
            answer: buildCapabilityAnswer(context),
            context,
            youtube_matches: transcriptMatches,
            sec_filing_matches: filingMatches,
            rss_items: rssItems,
            stooq_latest: latest,
            stooq_series: stooqSeries,
            source_sections: buildSourceSections({
              latest,
              series: stooqSeries,
              news: newsDetail,
              rss_items: rssItems,
              sec_filings: filingMatches,
              youtube_transcripts: transcriptMatches,
            }),
          });
        }

        const answer = await runAssistant(env, question, context);

        return json({
          symbol,
          ticker: resolvedTicker,
          answer,
          context,
          youtube_matches: transcriptMatches,
          sec_filing_matches: filingMatches,
          rss_items: rssItems,
          stooq_latest: latest,
          stooq_series: stooqSeries,
          source_sections: buildSourceSections({
            latest,
            series: stooqSeries,
            news: newsDetail,
            rss_items: rssItems,
            sec_filings: filingMatches,
            youtube_transcripts: transcriptMatches,
          }),
        });
      }

      if (url.pathname === "/api/debug-lookup" && request.method === "GET") {
        const raw = (url.searchParams.get("s") || "").trim();
        const s = raw.toUpperCase();

        const exact = await env.DB
          .prepare("SELECT symbol, date, close FROM daily_ohlcv WHERE symbol = ? ORDER BY date DESC LIMIT 5")
          .bind(s)
          .all();

        return json({
          query: s,
          exact: exact.results || [],
          exact_count: exact.results?.length || 0,
        });
      }

      return new Response("Not found", {
  status: 404,
  headers: getCorsHeaders(request)
});
    } catch (err) {
      return new Response(
        "Worker error:\n" + (err && (err.stack || err.message)) + "\n" + String(err),
        { status: 500, headers: {
  "content-type": "text/plain; charset=utf-8",
  ...getCorsHeaders(request)
} }
      );
    }
  },

  async scheduled(event, env) {
    await Promise.allSettled([
      refreshNewsForAll(env),
      refreshMarketHistoryForUniverse(env, Object.keys(TICKERS), 180),
    ]);

    // Placeholder for future YouTube cron handling
    // You can later branch on event.cron === MONTHLY_YT_CRON
    // Example:
    // if (event.cron === MONTHLY_YT_CRON) {
    //   console.log("Run YouTube transcript sync for:", YOUTUBE.CHANNELS);
    // }
  },
};
