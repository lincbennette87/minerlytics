import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const UNIVERSE_FILE = path.join(ROOT, "data", "universe.json");
const OUTPUT_DIR = path.join(ROOT, "public", "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "balance_sheets.json");

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Minerlytics your-email@example.com";

// Common balance-sheet concepts.
// Primary list is us-gaap. IFRS concepts are included as fallbacks where useful.
const TAGS = [
  { label: "Total Assets", taxonomy: ["us-gaap"], tag: "Assets" },
  { label: "Current Assets", taxonomy: ["us-gaap"], tag: "AssetsCurrent" },
  {
    label: "Cash & Equivalents",
    taxonomy: ["us-gaap"],
    tag: "CashAndCashEquivalentsAtCarryingValue",
  },
  { label: "Total Liabilities", taxonomy: ["us-gaap"], tag: "Liabilities" },
  {
    label: "Current Liabilities",
    taxonomy: ["us-gaap"],
    tag: "LiabilitiesCurrent",
  },
  {
    label: "Stockholders Equity",
    taxonomy: ["us-gaap"],
    tag: "StockholdersEquity",
  },
  {
    label: "Retained Earnings / Deficit",
    taxonomy: ["us-gaap"],
    tag: "RetainedEarningsAccumulatedDeficit",
  },

  // Optional IFRS fallbacks for foreign issuers
  { label: "Total Assets", taxonomy: ["ifrs-full"], tag: "Assets" },
  {
    label: "Current Assets",
    taxonomy: ["ifrs-full"],
    tag: "CurrentAssets",
  },
  {
    label: "Cash & Equivalents",
    taxonomy: ["ifrs-full"],
    tag: "CashAndCashEquivalents",
  },
  {
    label: "Total Liabilities",
    taxonomy: ["ifrs-full"],
    tag: "Liabilities",
  },
  {
    label: "Current Liabilities",
    taxonomy: ["ifrs-full"],
    tag: "CurrentLiabilities",
  },
  {
    label: "Stockholders Equity",
    taxonomy: ["ifrs-full"],
    tag: "Equity",
  },
];

function zeroPadCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw);
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }

  return res.json();
}

/**
 * Prefer the newest annual value (FY / 10-K / 20-F / 40-F),
 * otherwise fall back to newest quarterly value.
 */
function chooseBestFact(units = []) {
  if (!Array.isArray(units) || units.length === 0) return null;

  const cleaned = units
    .filter((x) => x && x.val != null && x.end)
    .map((x) => ({
      val: x.val,
      end: x.end,
      start: x.start || null,
      fy: x.fy || null,
      fp: x.fp || null,
      form: x.form || null,
      filed: x.filed || null,
      frame: x.frame || null,
      unit: x.uom || x.unit || null,
    }));

  if (cleaned.length === 0) return null;

  const annualForms = new Set(["10-K", "20-F", "40-F", "10-K/A", "20-F/A", "40-F/A"]);
  const quarterlyForms = new Set(["10-Q", "10-Q/A"]);

  const sortNewest = (a, b) => {
    const aDate = new Date(a.end || a.filed || 0).getTime();
    const bDate = new Date(b.end || b.filed || 0).getTime();
    return bDate - aDate;
  };

  const annual = cleaned
    .filter((x) => annualForms.has(x.form) || x.fp === "FY")
    .sort(sortNewest);

  if (annual.length) return annual[0];

  const quarterly = cleaned
    .filter((x) => quarterlyForms.has(x.form) || /^Q[1-4]$/i.test(x.fp || ""))
    .sort(sortNewest);

  if (quarterly.length) return quarterly[0];

  return cleaned.sort(sortNewest)[0];
}

function extractFact(companyFacts, taxonomy, tag) {
  const node = companyFacts?.facts?.[taxonomy]?.[tag];
  if (!node?.units) return null;

  // Most balance-sheet values are in USD, but support fallback.
  const preferredUnits = ["USD", "USDm", "USD/shares"];
  const unitKeys = Object.keys(node.units);

  for (const unitKey of preferredUnits) {
    if (node.units[unitKey]) {
      const chosen = chooseBestFact(node.units[unitKey]);
      if (chosen) return { ...chosen, taxonomy, tag, unitKey };
    }
  }

  for (const unitKey of unitKeys) {
    const chosen = chooseBestFact(node.units[unitKey]);
    if (chosen) return { ...chosen, taxonomy, tag, unitKey };
  }

  return null;
}

async function loadUniverse() {
  const raw = await readJson(UNIVERSE_FILE);

  // Supports either:
  // 1) array of objects
  // 2) object map keyed by ticker
  if (Array.isArray(raw)) return raw;

  return Object.entries(raw).map(([ticker, value]) => ({
    ticker,
    ...value,
  }));
}

function getTicker(item) {
  return item.ticker || item.symbol || item.code || item.Ticker || null;
}

function getCik(item) {
  return item.cik || item.CIK || item.company_cik || null;
}

async function run() {
  const universe = await loadUniverse();
  const results = [];

  for (const item of universe) {
    const ticker = getTicker(item);
    const cik = getCik(item);

    if (!ticker || !cik) {
      console.warn(`Skipping item with missing ticker/cik: ${JSON.stringify(item)}`);
      continue;
    }

    const cik10 = zeroPadCik(cik);
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

    console.log(`Fetching ${ticker} (${cik10})`);

    try {
      const companyFacts = await fetchJson(url);

      const extracted = {};
      for (const def of TAGS) {
        const found = extractFact(companyFacts, def.taxonomy[0], def.tag);

        if (found && !extracted[def.label]) {
          extracted[def.label] = {
            value: found.val,
            end: found.end,
            start: found.start,
            filed: found.filed,
            form: found.form,
            fy: found.fy,
            fp: found.fp,
            unit: found.unit || found.unitKey || null,
            taxonomy: found.taxonomy,
            tag: found.tag,
          };
        }
      }

      results.push({
        ticker,
        cik: cik10,
        entityName: companyFacts.entityName || ticker,
        extractedAt: new Date().toISOString(),
        balanceSheet: extracted,
      });
    } catch (err) {
      console.error(`Failed for ${ticker}: ${err.message}`);
      results.push({
        ticker,
        cik: cik10,
        error: err.message,
      });
    }
  }

  await writeJson(OUTPUT_FILE, results);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
