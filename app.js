/* =========================
   Minerlytics - app.js
   (Top Trending cards now pull real-time headlines via /api/news/trending
    and tickers are loaded from /universe.json)
   ========================= */

/* ---------- Trending Cards (TOP) ---------- */
/**
 * NOTE:
 * - "Trending cards" are rendered from `trending[]` via renderTrending()
 * - We now update `trending` from the Worker endpoint: /api/news/trending
 * - The list of symbols is loaded from /universe.json (served from /public)
 */

let trending = [
  { title: "Loading news…", meta: "Fetching latest headlines" },
  { title: "Loading news…", meta: "Fetching latest headlines" },
  { title: "Loading news…", meta: "Fetching latest headlines" },
];

// fallback until universe.json loads
let NEWS_TICKERS = ["WPM", "CDE", "HYMC", "GFI", "AEM"];
const API_BASE = "https://minerlytics-dev.lincbennette87.workers.dev";

/* ---------- Quotes ---------- */
let quotes = [
  { sym: "WPM", company: "Wheaton Precious Metals", price: 0, chg: 0 },
  { sym: "CDE", company: "Coeur Mining", price: 0, chg: 0 },
  { sym: "HYMC", company: "Hycroft Mining", price: 0, chg: 0 },
];

/* ---------- Running ticker strip (latest RSS across universe) ---------- */
let tickerItems = [
  { text: "Loading latest RSS headlines across your miner universe...", href: "#" },
  { text: "Loading latest RSS headlines across your miner universe...", href: "#" },
];

/* ============ Universe Loader ============ */
/**
 * Make sure universe.json is served from /public/universe.json
 * so it's accessible at: https://YOUR_DOMAIN/universe.json
 */
async function loadUniverseTickers(limit = 12) {
  const res = await fetch("/universe.json", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`universe.json status ${res.status}`);
  const uni = await res.json();

  // Accept common shapes:
  // 1) ["AEM","WPM",...]
  // 2) { tickers: ["AEM", ...] }
  // 3) { symbols: ["AEM", ...] }
  // 4) { items: [{sym:"AEM"}, ...] }
  if (Array.isArray(uni)) return uni.map(String).slice(0, limit);

  const arr =
    uni.tickers ||
    uni.symbols ||
    uni.universe ||
    (Array.isArray(uni.items)
      ? uni.items
          .map((x) => x?.sym || x?.symbol || x?.ticker)
          .filter(Boolean)
      : []);

  return (arr || []).map(String).slice(0, limit);
}

/* ============ Real-time Trending News Fetch ============ */
/**
 * Your Worker (index.js) should implement:
 * GET /api/news/trending?symbols=AEM,WPM,NEM
 *
 * and return:
 * { cards: [{ title: "AEM: ...", meta: "Source • 2h ago" }, ...] }
 */
async function refreshTrendingNews() {
  try {
    const res = await fetch(
      `${API_BASE}/api/news/trending?symbols=${encodeURIComponent(NEWS_TICKERS.join(","))}`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`news status ${res.status}`);

    const data = await res.json();
    const cards = Array.isArray(data.cards) ? data.cards : [];

    if (cards.length) {
      trending = cards.slice(0, 6); // adjust based on how many cards you want visible
      renderTrending();
    }
  } catch (e) {
    console.warn("refreshTrendingNews failed:", e);
    // keep old cards (fallback)
  }
}

/* ============ Renderers ============ */
function renderTrending() {
  const el = document.getElementById("trendRow");
  if (!el) return;
  el.innerHTML = trending
    .map(
      (t) => `
    <div class="trendCard">
      <div class="avatar" aria-hidden="true"></div>
      <div class="trendText">
        <div class="trendTitle">${escapeHtml(t.title ?? "")}</div>
        <div class="trendMeta">${escapeHtml(t.meta ?? "")}</div>
      </div>
    </div>
  `
    )
    .join("");
}

function renderQuotes() {
  const el = document.getElementById("quoteRow");
  if (!el) return;
  el.innerHTML = quotes
    .map((q) => {
      const up = q.chg >= 0;
      const cls = up ? "up" : "down";
      const sign = up ? "+" : "";
      return `
      <a class="quoteCard" href="./company.html?ticker=${encodeURIComponent(q.sym)}">
        <div class="quoteTop">
          <div class="sym">${escapeHtml(q.sym)}</div>
          <div class="price">${Number(q.price).toFixed(2)}</div>
          <div class="chg ${cls}">${sign}${Number(q.chg).toFixed(2)}%</div>
        </div>
        <div class="company">${escapeHtml(q.company)}</div>
      </a>
    `;
    })
    .join("");
}

function renderTicker() {
  const el = document.getElementById("tickerTrack");
  if (!el) return;
  // Duplicate so it loops cleanly
  const combined = [...tickerItems, ...tickerItems]
    .map(
      (item) => `
    <a class="tickerItem" href="${escapeHtml(item.href || "#")}" ${item.href ? 'target="_blank" rel="noreferrer"' : ""}>
      <span class="badge"></span>${escapeHtml(item.text || "")}
    </a>
  `
    )
    .join("");
  el.innerHTML = combined;
}

async function refreshLatestTickerFeed() {
  try {
    const res = await fetch(
      `${API_BASE}/api/news/latest-feed?symbols=${encodeURIComponent(NEWS_TICKERS.join(","))}&limit=12`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`latest-feed status ${res.status}`);

    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return;

    tickerItems = items.map((item) => ({
      href: item.link || "#",
      text: `${item.meta || "Latest RSS"} — ${item.one_liner || item.title || "Headline available"}`
    }));
    renderTicker();
  } catch (e) {
    console.warn("refreshLatestTickerFeed failed:", e);
  }
}

async function refreshQuoteCards(symbols = NEWS_TICKERS.slice(0, 5)) {
  try {
    const res = await fetch(
      `${API_BASE}/api/market/top-trends?symbols=${encodeURIComponent(symbols.join(","))}&days=180`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`quote status ${res.status}`);

    const data = await res.json();
    const items = Array.isArray(data.tickers) ? data.tickers : [];
    if (!items.length) return;

    quotes = items.slice(0, 5).map((item) => ({
      sym: item.ticker,
      company: item.name || item.ticker,
      price: Number(item.latest_close || 0),
      chg: Number(item.day_change_pct || 0),
    }));
    renderQuotes();
  } catch (e) {
    console.warn("refreshQuoteCards failed:", e);
  }
}

/* ============ Search wiring ============ */
function wireSearch() {
  const hero = document.getElementById("heroSearch");
  const btn = document.getElementById("searchBtn");
  const global = document.getElementById("globalSearch");

  function go(q) {
    const query = (q || "").trim();
    if (!query) return;
    const ticker = query.split(/[,\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean)[0];
    if (ticker) {
      window.location.href = `./company.html?ticker=${encodeURIComponent(ticker)}`;
    }
  }

  // The homepage hero search has dedicated chart/search wiring inline in index.html.
  // Keep app.js focused on auxiliary/global search entry points so we do not double-handle clicks.
  if (global)
    global.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go(global.value);
    });
}

/* ============ Tiny chart placeholder (simple canvas sparkline) ============ */
function spark(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = (c.width = c.parentElement.clientWidth - 4);
  const h = c.height;

  const pts = Array.from({ length: 28 }, (_, i) => {
    const base = Math.sin(i / 4) * 0.35 + 0.5;
    const noise = (Math.random() - 0.5) * 0.12;
    return Math.max(0.08, Math.min(0.92, base + noise));
  });

  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "#ffffff";
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * i) / 4);
    ctx.lineTo(w, (h * i) / 4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // line
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(234,240,255,.82)";
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (w * i) / (pts.length - 1);
    const y = h - p * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(124,92,255,.22)");
  grad.addColorStop(1, "rgba(124,92,255,0)");
  ctx.fillStyle = grad;
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
}

function wireSegButtons() {
  document.querySelectorAll(".segBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.parentElement;
      group.querySelectorAll(".segBtn").forEach((b) => b.classList.remove("isOn"));
      btn.classList.add("isOn");
      // Placeholder: later fetch data by range (1d/7d/6m/1y)
      spark("goldChart");
      spark("silverChart");
      spark("copperChart");
    });
  });
}

/* ============ Small helpers ============ */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ============ Boot ============ */
renderTrending();
renderQuotes();
renderTicker();
wireSearch();
wireSegButtons();

spark("goldChart");
spark("silverChart");
spark("copperChart");

// Load tickers from universe.json, then start real-time trending refresh
(async () => {
  try {
    NEWS_TICKERS = await loadUniverseTickers(12); // first 12 tickers
  } catch (e) {
    console.warn("universe load failed, using fallback tickers:", e);
  }

  refreshTrendingNews(); // immediate
  refreshLatestTickerFeed(); // immediate
  refreshQuoteCards(NEWS_TICKERS.slice(0, 5)); // immediate
  setInterval(refreshTrendingNews, 60000); // every 60s
  setInterval(refreshLatestTickerFeed, 60000); // every 60s
  setInterval(() => refreshQuoteCards(NEWS_TICKERS.slice(0, 5)), 60000); // every 60s
})();

window.addEventListener("minerlytics:trend-symbols", (event) => {
  const symbols = Array.isArray(event?.detail?.symbols) ? event.detail.symbols : [];
  if (!symbols.length) return;
  NEWS_TICKERS = symbols.slice(0, 12);
  refreshTrendingNews();
  refreshLatestTickerFeed();
  refreshQuoteCards(symbols.slice(0, 5));
});

window.addEventListener("resize", () => {
  spark("goldChart");
  spark("silverChart");
  spark("copperChart");
});
