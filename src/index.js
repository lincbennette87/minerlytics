import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";
import { handleEducationPortalChat, educationOptions } from "./educationPortalChat.js";

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

function makeSessionCookie(sessionId) {
  return `minerlytics_session=${sessionId}; Path=/; Secure; SameSite=None; HttpOnly; Max-Age=${60 * 60 * 24 * 30}; Domain=.minerlyticsai.com`;
}



/* ============================
   YouTube Configuration
   ============================ */
const YOUTUBE = {
  KITCO: {
    handleUrl: "https://www.youtube.com/@kitco",
    channelId: "UCzH5n3I2P5J8R9H0pE0hL5A",
    name: "Kitco News",
  },
  CHANNELS: [
    {
      handleUrl: "https://www.youtube.com/@kitco",
      channelId: "UCzH5n3I2P5J8R9H0pE0hL5A",
      name: "Kitco News",
      symbols: ["GOLD", "SILVER"],
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
    if (technicalMatches.length > 0) {
      return technicalMatches;
    }
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

async function getStooqSeriesForTicker(env, ticker, limit = 60) {
  if (!ticker) return [];
  const safeLimit = Math.min(Math.max(Number(limit || 60), 1), 120);
  const stooqSymbol = normalizeSymbolToStooqUS(ticker);

  const rows = await env.DB.prepare(
    `
    SELECT symbol, category, date, open, high, low, close, volume, source
    FROM daily_ohlcv
    WHERE symbol = ?
    ORDER BY date DESC
    LIMIT ?
    `
  ).bind(stooqSymbol, safeLimit).all();

  return (rows && rows.results) || [];
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

  const normalizedContext = stableSortValue(context || {});
  const normalizedDataString = stableStringify(normalizedContext);

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
    (technicalReportQuestion
      ? "1. 📄 Direct Answer\n" +
        "2. 📚 Technical Reports Found\n" +
        "3. 🏷️ Sources Used\n" +
        "4. 🧾 Disclaimer\n\n"
      : filingQuestion
        ? "1. 📄 Direct Answer\n" +
          "2. 📄 Filing / Disclosure Details\n" +
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
    "- Do not ask for ticker if RESOLVED_TICKER is present.\n" +
    "- Keep the response deterministic and consistent for the same question and same DATA.\n" +
    "- Prefer extractive, factual wording over creative paraphrasing.\n" +
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

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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
  const { email, password } = await request.json();

  if (!email || !password)
    return json({ ok: false, error: "Email and password required" }, 400);

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
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).bind(userId, email.toLowerCase(), passwordHash, now).run();

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now, expiresAt).run();

  return json(
  { ok: true, email },
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

  return json(
  { ok: true, email: user.email },
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
    SELECT users.id, users.email, users.password_hash
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
    SELECT users.id, users.email
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
      email: user.email
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

// watchlist new
if (url.pathname === "/api/watchlist" && request.method === "GET") {
  const email = String(url.searchParams.get("email") || "").toLowerCase().trim();

  if (!email) return json({ ok: false, error: "email required" }, 400);

  const rows = await env.DB.prepare(`
    SELECT symbol, created_at
    FROM user_watchlist
    WHERE email = ?
    ORDER BY created_at DESC
  `).bind(email).all();

  return json({ ok: true, watchlist: rows.results || [] });
}

if (url.pathname === "/api/watchlist/add" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").toLowerCase().trim();
  const symbol = String(body.symbol || "").toUpperCase().trim();

  if (!email || !symbol) {
    return json({ ok: false, error: "email and symbol required" }, 400);
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO user_watchlist (id, email, symbol, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), email, symbol, new Date().toISOString()).run();

  return json({ ok: true, symbol });
}

if (url.pathname === "/api/watchlist/remove" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").toLowerCase().trim();
  const symbol = String(body.symbol || "").toUpperCase().trim();

  if (!email || !symbol) {
    return json({ ok: false, error: "email and symbol required" }, 400);
  }

  await env.DB.prepare(`
    DELETE FROM user_watchlist
    WHERE email = ? AND symbol = ?
  `).bind(email, symbol).run();

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
  });
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

        const resolvedTicker = resolveTicker({
          explicitTicker: providedSymbol,
          explicitSymbol: providedSymbol,
          question,
        });
        const filingQuestion = isFilingQuestion(question);

        if (!resolvedTicker) {
          return json({
            error:
              "I could not identify the company or ticker from your question. Please mention either a ticker or company name, for example: AEM, Agnico Eagle, HYMC, or Coeur Mining.",
          }, 400);
        }

        const symbol = normalizeSymbolToStooqUS(resolvedTicker);

        let stooqSeries = [];
        let latest = null;
        let previous = null;
        let newsDetail = null;
        let rssItems = [];

        if (!filingQuestion) {
          stooqSeries = await getStooqSeriesForTicker(env, resolvedTicker, 60);
          latest = stooqSeries[0] || null;
          previous = stooqSeries.length > 1 ? stooqSeries[1] : null;

          const sentimentRow = await env.DB.prepare(
            "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
          ).bind(resolvedTicker).first();

          newsDetail = buildNewsDetailFromSummary(sentimentRow);
          rssItems = await getLatestRssItemsForTicker(env, resolvedTicker, 8);
        }

        const transcriptMatches = await getTranscriptMatches(env, resolvedTicker, question || resolvedTicker, 25);
        const filingMatches = await getMiningDisclosureMatches(env, resolvedTicker, question || resolvedTicker, 25);

        const context = buildUnifiedAssistantContext({
          q: question,
          resolvedTicker,
          latest,
          previous,
          series: stooqSeries,
          newsDetail,
          rssItems,
          filingMatches,
          transcriptMatches,
        });

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
    await refreshNewsForAll(env);

    // Placeholder for future YouTube cron handling
    // You can later branch on event.cron === MONTHLY_YT_CRON
    // Example:
    // if (event.cron === MONTHLY_YT_CRON) {
    //   console.log("Run YouTube transcript sync for:", YOUTUBE.CHANNELS);
    // }
  },
};
