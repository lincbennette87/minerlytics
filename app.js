const API_BASE = "https://minerlytics-dev.lincbennette87.workers.dev";
const RSS_LOOKBACK_DAYS = 60;
const MAP_VIEWBOX_WIDTH = 900;
const MAP_VIEWBOX_HEIGHT = 460;

const RSS_ENDPOINT_CANDIDATES = [
  "/api/home/rss",
  "/api/rss-news",
  "/api/rss",
  "/api/home/news",
  "/api/news",
];

const METAL_COLORS = {
  gold: "#e0a440",
  silver: "#b7c9db",
  copper: "#d67d4f",
  uranium: "#8ecf79",
  lithium: "#72bfd2",
  royalty: "#ddb26d",
  streaming: "#ddb26d",
};

let universeMarkers = [];
let selectedMarkerIndex = -1;
let latestHeadlineCount = 0;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeSearchValue(value) {
  return String(value || "").trim();
}

function openCompanyProfile(value) {
  const query = normalizeSearchValue(value);
  if (!query) return;
  window.location.href = `./company.html?q=${encodeURIComponent(query)}`;
}

function wireSearch() {
  const hero = document.getElementById("heroSearch");
  const global = document.getElementById("globalSearch");
  const button = document.getElementById("searchBtn");

  if (button && hero) {
    button.addEventListener("click", () => openCompanyProfile(hero.value));
    hero.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openCompanyProfile(hero.value);
    });
  }

  if (global) {
    global.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openCompanyProfile(global.value);
    });
  }
}

function formatHeadlineDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function parseHeadlineDate(item) {
  const rawValue = item.published_at || item.publishedAt || item.pubDate || item.date || item.created_at || item.createdAt;
  if (!rawValue) return null;
  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRecentHeadline(date) {
  const maxAgeMs = RSS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - date.getTime() <= maxAgeMs;
}

function normalizeHeadline(item) {
  const publishedAt = parseHeadlineDate(item);
  if (!publishedAt) return null;

  const title = item.title || item.headline || item.name;
  const url = item.url || item.link || item.article_url || item.articleUrl;
  if (!title || !url) return null;

  return {
    title: String(title).trim(),
    url: String(url).trim(),
    source: String(item.source || item.feed_name || item.feed || item.publisher || "RSS").trim(),
    summary: String(item.summary || item.description || item.snippet || "").trim(),
    publishedAt,
  };
}

async function fetchRssHeadlines() {
  for (const path of RSS_ENDPOINT_CANDIDATES) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;

      const payload = await response.json();
      const items = Array.isArray(payload)
        ? payload
        : payload.items || payload.headlines || payload.results || payload.data || [];

      if (Array.isArray(items) && items.length) {
        return items;
      }
    } catch (_error) {
      // Continue to the next endpoint candidate.
    }
  }

  return [];
}

function updateSignalCards() {
  const signalGrid = document.getElementById("signalGrid");
  if (!signalGrid) return;

  const jurisdictions = new Set(universeMarkers.map((item) => item.location_label).filter(Boolean));
  const metals = new Set(universeMarkers.map((item) => String(item.metal || "").toLowerCase()).filter(Boolean));
  const cards = [
    {
      label: "Mapped coverage",
      value: universeMarkers.length ? String(universeMarkers.length) : "0",
      meta: universeMarkers.length ? "Universe markers" : "Waiting for markers",
    },
    {
      label: "Jurisdictions",
      value: jurisdictions.size ? String(jurisdictions.size) : "0",
      meta: metals.size ? `${metals.size} tracked metal groups` : "Active regions",
    },
    {
      label: "Latest headlines",
      value: latestHeadlineCount ? String(latestHeadlineCount) : "0",
      meta: `Last ${RSS_LOOKBACK_DAYS} days`,
    },
  ];

  signalGrid.innerHTML = cards.map((card) => `
    <div class="signalCard">
      <span class="signalLabel">${escapeHtml(card.label)}</span>
      <strong class="signalValue">${escapeHtml(card.value)}</strong>
      <span class="signalMeta">${escapeHtml(card.meta)}</span>
    </div>
  `).join("");
}

async function renderRssFeed() {
  const container = document.getElementById("rssFeed");
  if (!container) return;

  container.innerHTML = '<div class="rssState">Loading RSS headlines...</div>';

  const headlines = (await fetchRssHeadlines())
    .map(normalizeHeadline)
    .filter(Boolean)
    .filter((item) => isRecentHeadline(item.publishedAt))
    .sort((a, b) => b.publishedAt - a.publishedAt);

  latestHeadlineCount = headlines.length;
  updateSignalCards();

  if (!headlines.length) {
    container.innerHTML = `<div class="rssState">No RSS headlines found from the last ${RSS_LOOKBACK_DAYS} days.</div>`;
    return;
  }

  container.innerHTML = headlines.map((item) => {
    const summary = item.summary
      ? `<div class="rssSummary">${escapeHtml(item.summary.slice(0, 180))}${item.summary.length > 180 ? "..." : ""}</div>`
      : "";

    return `
      <a class="rssCard" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
        <div class="rssCardTop">
          <div class="rssSource">${escapeHtml(item.source)}</div>
          <div class="rssDate">${escapeHtml(formatHeadlineDate(item.publishedAt))}</div>
        </div>
        <div class="rssHeadline">${escapeHtml(item.title)}</div>
        ${summary}
        <span class="rssLink">Open headline -></span>
      </a>
    `;
  }).join("");
}

function metalColor(metal) {
  const key = String(metal || "").toLowerCase();
  return METAL_COLORS[key] || "#8fa9c4";
}

function buildMarkerSvg(marker, index) {
  const x = Number(marker.x || 0);
  const y = Number(marker.y || 0);
  const color = metalColor(marker.metal);
  const selectedClass = index === selectedMarkerIndex ? " isSelected" : "";
  const labelX = x + 12;
  const labelY = y - 13;

  return `
    <g class="mapMarker${selectedClass}" data-marker-index="${index}" tabindex="0" role="button" aria-label="${escapeHtml(marker.ticker)}">
      <circle class="mapMarkerPulse" cx="${x}" cy="${y}" r="16"></circle>
      <circle class="mapMarkerCircle" cx="${x}" cy="${y}" r="7.5" fill="${color}"></circle>
      <text class="mapMarkerText" x="${labelX}" y="${labelY}">${escapeHtml(marker.ticker)}</text>
    </g>
  `;
}

function renderMapDetail() {
  const title = document.getElementById("mapDetailTitle");
  const meta = document.getElementById("mapDetailMeta");
  const copy = document.getElementById("mapDetailCopy");
  const facts = document.getElementById("mapDetailFacts");
  const link = document.getElementById("mapDetailLink");
  const list = document.getElementById("mapTickerList");
  const subtitle = document.getElementById("mapSubtitle");

  const marker = universeMarkers[selectedMarkerIndex] || null;
  if (!marker) {
    if (title) title.textContent = "No marker selected";
    if (meta) meta.textContent = "Universe details will appear here.";
    if (copy) copy.textContent = "No marker data is available yet.";
    if (facts) facts.innerHTML = "";
    if (list) list.innerHTML = "";
    if (subtitle) subtitle.textContent = "Plotting filing-backed operating regions.";
    return;
  }

  if (title) title.textContent = `${marker.map_label || marker.company_name || marker.ticker}`;
  if (meta) meta.textContent = `${marker.ticker} • ${marker.location_label || "Location unavailable"}${marker.sub_location ? ` • ${marker.sub_location}` : ""}`;
  if (copy) copy.textContent = marker.source_excerpt || "No filing excerpt available for this marker.";
  if (subtitle) subtitle.textContent = `${universeMarkers.length} markers loaded across the current Minerlytics universe map.`;
  if (link) link.href = `./company.html?ticker=${encodeURIComponent(marker.ticker)}`;
  if (link) link.textContent = `Open ${marker.ticker} profile`;

  const markerFacts = [
    marker.metal ? `Metal: ${marker.metal}` : "",
    marker.latest_filing_date ? `Latest filing: ${marker.latest_filing_date}` : "Latest filing: unavailable",
    marker.detail ? `Region: ${marker.detail}` : "",
  ].filter(Boolean);

  if (facts) {
    facts.innerHTML = markerFacts.map((item) => `<span class="mapFact">${escapeHtml(item)}</span>`).join("");
  }

  if (list) {
    list.innerHTML = universeMarkers.map((item, index) => `
      <button class="mapTickerButton${index === selectedMarkerIndex ? " isSelected" : ""}" type="button" data-list-marker-index="${index}">
        ${escapeHtml(item.ticker)} • ${escapeHtml(item.location_label || "Unknown")}
      </button>
    `).join("");

    list.querySelectorAll("[data-list-marker-index]").forEach((buttonEl) => {
      buttonEl.addEventListener("click", () => {
        const index = Number(buttonEl.getAttribute("data-list-marker-index"));
        if (Number.isFinite(index)) selectMarker(index);
      });
    });
  }
}

function bindMarkerInteractions() {
  const markersRoot = document.getElementById("universeMarkers");
  if (!markersRoot) return;

  markersRoot.querySelectorAll("[data-marker-index]").forEach((node) => {
    const select = () => {
      const index = Number(node.getAttribute("data-marker-index"));
      if (Number.isFinite(index)) selectMarker(index);
    };

    node.addEventListener("click", select);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });
}

function renderUniverseMap() {
  const markersRoot = document.getElementById("universeMarkers");
  const emptyState = document.getElementById("mapEmptyState");

  if (!markersRoot) return;

  if (!universeMarkers.length) {
    markersRoot.innerHTML = "";
    if (emptyState) emptyState.textContent = "No universe markers returned.";
    renderMapDetail();
    updateSignalCards();
    return;
  }

  markersRoot.innerHTML = universeMarkers.map(buildMarkerSvg).join("");
  if (emptyState) emptyState.classList.add("isHidden");
  bindMarkerInteractions();
  renderMapDetail();
  updateSignalCards();
}

function selectMarker(index) {
  if (!Number.isFinite(index) || index < 0 || index >= universeMarkers.length) return;
  selectedMarkerIndex = index;
  renderUniverseMap();
}

async function loadUniverseMap() {
  const emptyState = document.getElementById("mapEmptyState");
  if (emptyState) emptyState.textContent = "Loading universe map...";

  try {
    const response = await fetch(`${API_BASE}/api/universe/map?limit=18`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Universe map request failed: ${response.status}`);

    const payload = await response.json();
    const markers = Array.isArray(payload.markers) ? payload.markers : [];

    universeMarkers = markers
      .filter((item) => Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)))
      .map((item) => ({
        ...item,
        x: Math.max(20, Math.min(MAP_VIEWBOX_WIDTH - 20, Number(item.x))),
        y: Math.max(20, Math.min(MAP_VIEWBOX_HEIGHT - 20, Number(item.y))),
      }));

    selectedMarkerIndex = universeMarkers.length ? 0 : -1;
    renderUniverseMap();
  } catch (error) {
    if (emptyState) emptyState.textContent = "Universe map unavailable right now.";
    universeMarkers = [];
    selectedMarkerIndex = -1;
    renderUniverseMap();
    console.error(error);
  }
}

wireSearch();
updateSignalCards();
loadUniverseMap();
renderRssFeed();
