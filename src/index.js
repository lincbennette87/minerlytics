import { refreshNewsForAll } from "./news_cron.js";
import { TICKERS } from "./tickers.js";
import { googleRssUrl, parseRssItems } from "./rss.js";

const CORS = {
"access-control-allow-origin": "*",
"access-control-allow-methods": "GET,POST,OPTIONS",
// ✅ added x-api-key so browser/clients can send it
"access-control-allow-headers": "content-type,x-api-key",
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

// Guarantee disclaimer inclusion even if model forgets
if (!rawAnswer.toLowerCase().includes(DISCLAIMER)) {
return rawAnswer.trim() + "\n\n🧾 **Disclaimer**\n" + DISCLAIMER;
}

return rawAnswer;
}

/* ============================================================
✅ ADDED: auth helper for YouTube ingest endpoints
Secret must be named exactly: WORKER_API_KEY
============================================================ */
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

/* ============================================================
✅ ADDED: GET /api/youtube/seen?video_id=...
============================================================ */
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

/* ============================================================
✅ ADDED: POST /api/ingest/youtube
============================================================ */
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

// 1) video row (only once)
stmts.push(
env.DB.prepare(
`INSERT OR IGNORE INTO youtube_videos (video_id, title, channel, published_at, url)
VALUES (?, ?, ?, ?, ?)`
).bind(video_id, title, channel, published_at, urlStr)
);

// 2) tags (multi-symbol supported)
for (const sym of symbol_tags) {
if (!sym) continue;
stmts.push(
env.DB.prepare(
`INSERT OR IGNORE INTO youtube_video_symbols (video_id, symbol)
VALUES (?, ?)`
).bind(video_id, String(sym).toUpperCase())
);
}

// 3) segments
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

// ---- your existing routes continue unchanged ----

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

const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "15", 10), 1), 100);

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
prevClose && Number.isFinite(prevClose) && prevClose !== 0 ? (chg / prevClose) * 100 : null;

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

async scheduled(event, env) {
await refreshNewsForAll(env);
},
};
