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

/* ============================================================
✅ ADDED: YouTube transcript helpers for assistant + UI
============================================================ */
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
      url: ytSourceUrl(r.video_id, start),
      text: String(r.text || "").replace(/\s+/g, " ").trim(),
    };
  });
}

async function runAssistant(env, question, context) {
  const system =
  "You are Minerlytics AI.\n" +
  "Role: a mining-sector research assistant.\n" +
  "Mission: help users understand mining companies, projects, commodities, and mining concepts using ONLY information available in DATA.\n\n" +

  "ABSOLUTE CONSTRAINTS (HARD RULES):\n" +
  "- Use ONLY facts that exist in DATA. If something is not in DATA, write: \"Not available\".\n" +
  "- Do NOT invent or assume: numbers, prices, dates, events, quotes, mine names, jurisdictions, management commentary, or sources.\n" +
  "- Do NOT reference or name external websites/services (e.g., Investing.com, Yahoo, Google) unless those exact references are present in DATA.\n" +
  "- Do NOT mention 'JSON', 'context', 'provided data', 'tools', 'system prompt', or internal implementation.\n" +
  "- Do NOT provide investment advice, portfolio allocations, price targets, or stock-move predictions.\n\n" +

  "TONE & FORMAT:\n" +
  "- Be direct and structured.\n" +
  "- Prefer bullets; avoid long paragraphs.\n" +
  "- Keep each section to 3–7 bullets unless the user explicitly asks for more depth.\n" +
  "- Use mining terms accurately; if a term may be unfamiliar, add a one-line plain-English definition.\n\n" +

  "NO DEFAULTS / NO DRIFT:\n" +
  "- NO DEFAULT TICKER: never choose a company/ticker unless the user explicitly mentions it.\n" +
  "- NO CONTEXT BLEED: do not inject company/transcript/news details into general questions.\n" +
  "- If the user asks a general question, answer generally. If the user asks about a company, answer about that company.\n\n" +

  "INTENT ROUTER (FOLLOW IN THIS EXACT ORDER):\n" +
  "A) CAPABILITY MODE:\n" +
  "   Trigger if the user asks what you can do or how you can help (e.g., \"how can you help?\", \"what can you do?\", \"features\").\n" +
  "   Output: a capability overview only. Do NOT mention any ticker/company. Do NOT summarize news/transcripts. Do NOT include market/price data.\n" +
  "   Sources Used must be: \"Not applicable\".\n" +
  "\n" +
  "B) OUT-OF-SCOPE MODE:\n" +
  "   Trigger if the user asks something unrelated to mining (superheroes, movies, sports, general trivia).\n" +
  "   Output: brief refusal + redirect to mining questions.\n" +
  "   Do NOT mention any ticker/company. Sources Used: \"Not applicable\".\n" +
  "\n" +
  "C) CONCEPT MODE:\n" +
  "   Trigger if the user asks to explain a mining concept/term.\n" +
  "   If the user does NOT specify the term, ask exactly ONE clarifying question: \"Which mining term would you like explained?\"\n" +
  "   If the user specifies the term, explain ONLY the concept.\n" +
  "   Do NOT reference any company, ticker, transcript, or news unless the user explicitly asks for a company-specific example.\n" +
  "   News & Transcript Insights: \"Not applicable\".\n" +
  "   Sources Used: \"Not applicable\" (unless the user explicitly asks you to quote/summarize a transcript).\n" +
  "\n" +
  "D) COMPANY/ASSET RESEARCH MODE:\n" +
  "   Trigger if the user mentions a specific company/ticker/mine/project OR asks for comparison between named entities.\n" +
  "   Use ONLY relevant items from DATA.\n" +
  "   Prefer the most recent dated items when multiple exist.\n" +
  "   If sources conflict, state the conflict and cite both.\n" +
  "\n" +
  "E) MARKET DATA MODE:\n" +
  "   Trigger ONLY if the user explicitly asks for price/performance (price, OHLCV, returns, ATH, % change, volume).\n" +
  "   Use ONLY market numbers present in DATA.\n" +
  "   If market data is missing in DATA, say \"Not available\".\n\n" +

  "DISALLOWED REQUEST HANDLING (ALWAYS):\n" +
  "- If asked for investment advice, price targets, predictions, or allocations:\n" +
  "  1) Briefly refuse.\n" +
  "  2) Redirect to research alternatives: operations, costs, reserves/resources, jurisdiction risk, guidance/capex, and what management said.\n\n" +

  "EVIDENCE DISCIPLINE:\n" +
  "- Facts must be grounded in DATA.\n" +
  "- Interpretations must be labeled with \"Interpretation:\" and must logically follow from stated facts.\n" +
  "- If key inputs are missing, list them under Risks & Opportunities as \"Unknowns\".\n" +
  "- Do not claim something is \"recent\" unless a date exists in DATA.\n" +
  "- Numbers must include units when available (oz, g/t, tpd, $/oz, $M).\n\n" +

  "TRANSCRIPT CITATION RULES:\n" +
  "- If you use any transcript content and transcript items exist in DATA.youtube_transcripts, you MUST list each used transcript in 🏷️ Sources Used.\n" +
  "- For each transcript source, include: sid and url.\n" +
  "- If the user asks for transcript insights and no transcript items match, say so explicitly in 📰 News & Transcript Insights.\n\n" +

  "NEWS / FEED CITATION RULES:\n" +
  "- If you use news/feed items from DATA, list them in 🏷️ Sources Used with any available identifiers (title/date/url/id).\n" +
  "- Never cite sources you did not use.\n\n" +

  "SECTION-BY-SECTION CONTENT RULES:\n" +
  "📌 Summary:\n" +
  "- 2–5 bullets: what the user asked + the most important grounded takeaway.\n" +
  "\n" +
  "📰 News & Transcript Insights:\n" +
  "- Only include this section if the user asked about news/transcripts OR if the question is company/asset research and DATA contains directly relevant items.\n" +
  "- Otherwise write: \"Not applicable\".\n" +
  "\n" +
  "⛏️ Operations / Fundamentals:\n" +
  "- Focus on mining-specific fundamentals: assets, production, grades, recovery, costs (AISC/cash), capex, guidance, reserves/resources, mine life, jurisdiction.\n" +
  "- If not available in DATA, write: \"Not available\".\n" +
  "\n" +
  "⚠️ Risks & Opportunities:\n" +
  "- 3–7 bullets: risks/opportunities supported by DATA.\n" +
  "- Include an \"Unknowns\" bullet list if missing info would change the conclusion.\n" +
  "\n" +
  "🏷️ Sources Used:\n" +
  "- Bullet list.\n" +
  "- For transcripts: include sid + url.\n" +
  "- If none: write \"Not applicable\".\n\n" +

  "OUTPUT FORMAT (MUST MATCH EXACTLY):\n" +
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
        return text("Minerlytics DEV is running ✅ v2026");
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

      /* ============================================================
✅ ADDED: GET /api/ai/search?q=...&limit=...&symbol=...
- Lets you show transcript matches in the UI (no LLM)
============================================================ */
      if (url.pathname === "/api/ai/search" && request.method === "GET") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const q = String(url.searchParams.get("q") || "").trim();
        const symbol = String(url.searchParams.get("symbol") || "").trim().toUpperCase();
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1),
          50
        );

        if (!q) return json({ ok: false, error: "q required" }, 400);

        let sql, bindings;

        if (symbol) {
          sql = `
            SELECT
              s.video_id, s.start, s.duration, s.text,
              v.title, v.channel, v.published_at, v.url
            FROM youtube_segments s
            JOIN youtube_videos v ON v.video_id = s.video_id
            JOIN youtube_video_symbols ys ON ys.video_id = s.video_id
            WHERE ys.symbol = ?
              AND s.text LIKE '%' || ? || '%'
            ORDER BY v.published_at DESC, s.start ASC
            LIMIT ?
          `;
          bindings = [symbol, q, limit];
        } else {
          sql = `
            SELECT
              s.video_id, s.start, s.duration, s.text,
              v.title, v.channel, v.published_at, v.url
            FROM youtube_segments s
            JOIN youtube_videos v ON v.video_id = s.video_id
            WHERE s.text LIKE '%' || ? || '%'
            ORDER BY v.published_at DESC, s.start ASC
            LIMIT ?
          `;
          bindings = [q, limit];
        }

        const rows = await env.DB.prepare(sql).bind(...bindings).all();
        const results = buildTranscriptContext(rows.results || []);
        return json({ ok: true, q, symbol: symbol || null, results }, 200);
      }

      /* ============================================================
✅ ADDED: POST /api/ai/ask
Body: { q: "...", symbol: "AEM" (optional), limit: 20 }
- Returns BOTH the LLM answer + transcript matches so your page can render them
============================================================ */
      if (url.pathname === "/api/ai/ask" && request.method === "POST") {
        const auth = requireApiKey(request, env);
        if (!auth.ok) return auth.res;

        const body = await request.json().catch(() => ({}));
        const q = String(body.q || "").trim();
        const symbol = String(body.symbol || "").trim().toUpperCase();
        const limit = Math.min(
          Math.max(parseInt(body.limit || "20", 10), 1),
          50
        );

        if (!q) return json({ ok: false, error: "q required" }, 400);

        // Pull transcript matches for context
        let sql, bindings;

        if (symbol) {
          sql = `
            SELECT
              s.video_id, s.start, s.duration, s.text,
              v.title, v.channel, v.published_at, v.url
            FROM youtube_segments s
            JOIN youtube_videos v ON v.video_id = s.video_id
            JOIN youtube_video_symbols ys ON ys.video_id = s.video_id
            WHERE ys.symbol = ?
              AND s.text LIKE '%' || ? || '%'
            ORDER BY v.published_at DESC, s.start ASC
            LIMIT ?
          `;
          bindings = [symbol, q, limit];
        } else {
          sql = `
            SELECT
              s.video_id, s.start, s.duration, s.text,
              v.title, v.channel, v.published_at, v.url
            FROM youtube_segments s
            JOIN youtube_videos v ON v.video_id = s.video_id
            WHERE s.text LIKE '%' || ? || '%'
            ORDER BY v.published_at DESC, s.start ASC
            LIMIT ?
          `;
          bindings = [q, limit];
        }

        const rows = await env.DB.prepare(sql).bind(...bindings).all();
        const transcriptMatches = buildTranscriptContext(rows.results || []);

        // Build assistant context for LLM
        const context = {
          question: q,
          symbol: symbol || null,
          youtube_transcripts: transcriptMatches,
        };

        const answer = await runAssistant(env, q, context);

        return json(
          {
            ok: true,
            q,
            symbol: symbol || null,
            answer,
            youtube_matches: transcriptMatches, // ✅ UI can show these
          },
          200
        );
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
          prevClose && Number.isFinite(prevClose) && prevClose !== 0 ? (chg / prevClose) * 100 : null;

        const sentimentRow = await env.DB.prepare(
          "SELECT * FROM news_sentiment_summary WHERE ticker = ?"
        ).bind(ticker).first();

        const newsDetail = buildNewsDetailFromSummary(sentimentRow);

        /* ============================================================
✅ ADDED: Pull transcript matches for THIS ticker + question
- Returns youtube_matches so your page can display them
- Also adds into LLM context so it can cite them
============================================================ */
        let ytMatches = [];
        try {
          // Try query-based match first; if question is empty, just filter by ticker
          const q = question || ticker;

          // If you are tagging videos by ticker in youtube_video_symbols, this will work.
          // If you tagged by channel only (KITCO_NEWS), you can still match by text (LIKE).
          const ytRows = await env.DB.prepare(
            `
              SELECT
                s.video_id, s.start, s.duration, s.text,
                v.title, v.channel, v.published_at, v.url
              FROM youtube_segments s
              JOIN youtube_videos v ON v.video_id = s.video_id
              LEFT JOIN youtube_video_symbols ys ON ys.video_id = s.video_id
              WHERE (ys.symbol = ? OR s.text LIKE '%' || ? || '%')
              ORDER BY v.published_at DESC, s.start ASC
              LIMIT 25
            `
          ).bind(ticker, q).all();

          ytMatches = buildTranscriptContext(ytRows.results || []);
        } catch (e) {
          // keep assistant working even if transcripts query fails
          ytMatches = [];
        }

        const context = {
          symbol,
          ticker,
          latest,
          previous: prev,
          computed: { one_day_change: chg, one_day_change_pct: chgPct },
          news: newsDetail,
          series: rows.results,

          // ✅ ADDED: transcripts for the assistant to use + cite
          youtube_transcripts: ytMatches,
        };

        const answer = await runAssistant(env, question, context);

        // ✅ ADDED: include transcript matches in the response for UI rendering
        return json({ symbol, answer, youtube_matches: ytMatches });
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
