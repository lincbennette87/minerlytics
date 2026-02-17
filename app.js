const trending = [
  { title: "Top 5 Momentum (30D)", meta: "Toggle: Potential momentum stocks" },
  { title: "Recent News", meta: "Toggle: Recent interviews" },
  { title: "Mining Sector Watchlist", meta: "US + Canada tickers" },
];

const quotes = [
  { sym: "AEM", company: "Agnico Eagle Mines", price: 54.21, chg: +1.28 },
  { sym: "WPM", company: "Wheaton Precious Metals", price: 45.88, chg: -0.62 },
  { sym: "NEM", company: "Newmont", price: 39.14, chg: +0.41 },
];

const tickerItems = [
  "Gold breaks above key resistance as USD weakens",
  "Interview: permitting timelines and risk factors (new video)",
  "Copper demand outlook strengthens on electrification news",
  "Junior miner announces new drill results; sentiment spikes",
  "Regulatory update: project approval milestone reached",
];

// ✅ Worker base (no api folder needed)
const API_BASE = "https://minerlytics-dev.lincbennette87.workers.dev";

function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function fmtPct(x){
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

function fmtDate(s){
  if(!s) return "";
  return String(s).replace("T"," ").replace("Z","");
}

function renderTrending() {
  const el = document.getElementById("trendRow");
  el.innerHTML = trending.map(t => `
    <div class="trendCard">
      <div class="avatar" aria-hidden="true"></div>
      <div class="trendText">
        <div class="trendTitle">${t.title}</div>
        <div class="trendMeta">${t.meta}</div>
      </div>
    </div>
  `).join("");
}

function renderQuotes() {
  const el = document.getElementById("quoteRow");
  el.innerHTML = quotes.map(q => {
    const up = q.chg >= 0;
    const cls = up ? "up" : "down";
    const sign = up ? "+" : "";
    return `
      <div class="quoteCard">
        <div class="quoteTop">
          <div class="sym">${q.sym}</div>
          <div class="price">${q.price.toFixed(2)}</div>
          <div class="chg ${cls}">${sign}${q.chg.toFixed(2)}%</div>
        </div>
        <div class="company">${q.company}</div>
      </div>
    `;
  }).join("");
}

function renderTicker() {
  const el = document.getElementById("tickerTrack");
  const combined = [...tickerItems, ...tickerItems].map(t => `
    <span class="tickerItem"><span class="badge"></span>${t}</span>
  `).join("");
  el.innerHTML = combined;
}

function wireSearch() {
  const hero = document.getElementById("heroSearch");
  const btn = document.getElementById("searchBtn");
  const global = document.getElementById("globalSearch");

  function go(q) {
    const query = (q || "").trim();
    if (!query) return;
    alert(`Search: ${query}\n\nNext: connect to ticker/company lookup + mining-only filter.`);
  }

  btn.addEventListener("click", () => go(hero.value));
  hero.addEventListener("keydown", (e) => { if (e.key === "Enter") go(hero.value); });
  global.addEventListener("keydown", (e) => { if (e.key === "Enter") go(global.value); });
}

/* Tiny chart placeholder (simple canvas sparkline) */
function spark(canvasId) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width = c.parentElement.clientWidth - 4;
  const h = c.height;

  const pts = Array.from({length: 28}, (_, i) => {
    const base = Math.sin(i/4) * 0.35 + 0.5;
    const noise = (Math.random() - 0.5) * 0.12;
    return Math.max(0.08, Math.min(0.92, base + noise));
  });

  ctx.clearRect(0,0,w,h);

  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "#ffffff";
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h*i)/4);
    ctx.lineTo(w, (h*i)/4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(234,240,255,.82)";
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (w * i) / (pts.length - 1);
    const y = h - p * h;
    if (i === 0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  });
  ctx.stroke();

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
  document.querySelectorAll(".segBtn").forEach(btn => {
    // Only apply this placeholder behavior to the chart segment group
    // Media toggle has its own wiring below (by ID)
    if (btn.id === "mediaNewsBtn" || btn.id === "mediaInterviewsBtn") return;

    btn.addEventListener("click", () => {
      const group = btn.parentElement;
      group.querySelectorAll(".segBtn").forEach(b => b.classList.remove("isOn"));
      btn.classList.add("isOn");
      spark("goldChart");
      spark("silverChart");
      spark("copperChart");
    });
  });
}

/* =========================
   Phase 1: Top 5 Momentum
   ========================= */
async function loadMomentumTop(){
  const el = document.getElementById("momentumRow");
  if(!el) return;

  el.innerHTML = `<div class="quoteCard" style="grid-column:1/-1;">Loading momentum…</div>`;

  try{
    const r = await fetch(`${API_BASE}/api/momentum-top?limit=5`);
    if(!r.ok) throw new Error("momentum-top failed: " + r.status);
    const j = await r.json();
    const items = j.items || [];

    if(items.length === 0){
      el.innerHTML = `<div class="quoteCard" style="grid-column:1/-1;">No momentum data yet.</div>`;
      return;
    }

    el.innerHTML = items.map(it => {
      const sym = String(it.symbol || "").replace(/\.us$/i,"").toUpperCase();
      const pct = fmtPct(it.chg_pct);
      return `
        <div class="trendCard">
          <div class="avatar" aria-hidden="true"></div>
          <div class="trendText">
            <div class="trendTitle">${esc(sym)}</div>
            <div class="trendMeta">${esc(pct)} · Close ${esc(it.close_latest)}</div>
          </div>
        </div>
      `;
    }).join("");
  } catch(e){
    console.error(e);
    el.innerHTML = `<div class="quoteCard" style="grid-column:1/-1;">Failed to load momentum.</div>`;
  }
}

/* =========================
   Phase 1: Recent Media
   ========================= */
async function loadRecentMedia(type){
  const list = document.getElementById("recentMediaList");
  if(!list) return;

  if(type === "interviews"){
    list.innerHTML = `<div style="opacity:.75;">Interviews coming soon.</div>`;
    return;
  }

  list.innerHTML = "Loading…";

  try{
    const r = await fetch(`${API_BASE}/api/recent-media?type=news&limit=10`);
    if(!r.ok) throw new Error("recent-media failed: " + r.status);
    const j = await r.json();
    const items = j.items || [];

    if(items.length === 0){
      list.innerHTML = `<div style="opacity:.75;">No news yet.</div>`;
      return;
    }

    list.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${items.map(it => `
          <a href="${esc(it.link)}" target="_blank" rel="noreferrer"
             style="display:flex;flex-direction:column;gap:4px;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.03);">
            <div style="font-weight:650;">${esc(it.title)}</div>
            <div style="font-size:12px;opacity:.70;">
              ${esc(it.source || "Source")}
              ${it.ticker ? " · " + esc(it.ticker) : ""}
              ${it.published_at || it.fetched_at ? " · " + esc(fmtDate(it.published_at || it.fetched_at)) : ""}
            </div>
          </a>
        `).join("")}
      </div>
    `;
  } catch(e){
    console.error(e);
    list.innerHTML = `<div style="opacity:.75;">Failed to load news.</div>`;
  }
}

function wireMediaToggle(){
  const newsBtn = document.getElementById("mediaNewsBtn");
  const intBtn  = document.getElementById("mediaInterviewsBtn");
  if(!newsBtn || !intBtn) return;

  newsBtn.addEventListener("click", () => {
    newsBtn.classList.add("isOn");
    intBtn.classList.remove("isOn");
    loadRecentMedia("news");
  });

  intBtn.addEventListener("click", () => {
    intBtn.classList.add("isOn");
    newsBtn.classList.remove("isOn");
    loadRecentMedia("interviews");
  });
}

/* Init */
renderTrending();
renderQuotes();
renderTicker();
wireSearch();
wireSegButtons();

loadMomentumTop();
wireMediaToggle();
loadRecentMedia("news");

spark("goldChart");
spark("silverChart");
spark("copperChart");

window.addEventListener("resize", () => {
  spark("goldChart");
  spark("silverChart");
  spark("copperChart");
});
