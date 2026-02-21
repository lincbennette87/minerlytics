const tickerItems = [
  "Gold breaks above key resistance as USD weakens",
  "Interview: permitting timelines and risk factors (new video)",
  "Copper demand outlook strengthens on electrification news",
  "Junior miner announces new drill results; sentiment spikes",
  "Regulatory update: project approval milestone reached",
];

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
  // Duplicate so it loops cleanly
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
    // Placeholder: later route to Company Profile / Analysis page
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

  // grid
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "#ffffff";
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h*i)/4);
    ctx.lineTo(w, (h*i)/4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // line (no custom color; use default current strokeStyle)
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
  document.querySelectorAll(".segBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = btn.parentElement;
      group.querySelectorAll(".segBtn").forEach(b => b.classList.remove("isOn"));
      btn.classList.add("isOn");
      // Placeholder: later fetch data by range (1d/7d/6m/1y)
      spark("goldChart");
      spark("silverChart");
      spark("copperChart");
    });
  });
}

renderTrending();
renderQuotes();
renderTicker();
wireSearch();
wireSegButtons();

spark("goldChart");
spark("silverChart");
spark("copperChart");

window.addEventListener("resize", () => {
  spark("goldChart");
  spark("silverChart");
  spark("copperChart");
});
