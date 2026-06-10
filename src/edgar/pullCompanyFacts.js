import fs from "node:fs";
import path from "node:path";
import { secGetJson, createThrottle } from "./secFetch.js";

// Reads from /data (your choice)
const rulesPath = path.resolve("data/miner.rules.json");
const universePath = path.resolve("data/universe.json");

// Writes to Pages-served folder
const outDir = path.resolve("public/data");
const outFile = path.join(outDir, "fundamentals_latest.json");

// Load configs
const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const universe = JSON.parse(fs.readFileSync(universePath, "utf8"));

const userAgent = rules.edgar?.userAgent;
if (!userAgent) {
  throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");
}

const rps = rules.edgar?.rps ?? 1;
const throttle = createThrottle(rps);

// Metrics mapping: metricKey -> taxonomy/tag pairs tried in order.
const METRICS = {
  revenue: [
    { taxonomy: "us-gaap", tag: "Revenues" },
    { taxonomy: "us-gaap", tag: "SalesRevenueNet" }
  ],
  netIncome: [
    { taxonomy: "us-gaap", tag: "NetIncomeLoss" },
    { taxonomy: "us-gaap", tag: "ProfitLoss" }
  ],
  assets: [
    { taxonomy: "us-gaap", tag: "Assets" },
    { taxonomy: "ifrs-full", tag: "Assets" }
  ],
  liabilities: [
    { taxonomy: "us-gaap", tag: "Liabilities" },
    { taxonomy: "ifrs-full", tag: "Liabilities" }
  ],
  cashFlowOps: [
    { taxonomy: "us-gaap", tag: "NetCashProvidedByUsedInOperatingActivities" },
    { taxonomy: "ifrs-full", tag: "CashFlowsFromUsedInOperatingActivities" }
  ],
  epsBasic: [
    { taxonomy: "us-gaap", tag: "EarningsPerShareBasic" },
    { taxonomy: "ifrs-full", tag: "BasicEarningsLossPerShareFromContinuingOperations" }
  ],
  epsDiluted: [
    { taxonomy: "us-gaap", tag: "EarningsPerShareDiluted" },
    { taxonomy: "ifrs-full", tag: "DilutedEarningsLossPerShareFromContinuingOperations" }
  ],
  sharesOutstanding: [
    { taxonomy: "us-gaap", tag: "CommonStockSharesOutstanding" },
    { taxonomy: "dei", tag: "EntityCommonStockSharesOutstanding" },
    { taxonomy: "dei", tag: "EntityPublicFloatShares" }
  ]
};

function pickLatestFact(factsArr) {
  // Prefer most recent by "end" date, fall back safely
  return [...factsArr].sort((a, b) => {
    const da = new Date(a.end || 0).getTime();
    const db = new Date(b.end || 0).getTime();
    return db - da;
  })[0];
}

function chooseUnit(unitsObj, localTagName) {
  const unitKeys = Object.keys(unitsObj || {});
  if (unitKeys.length === 0) return null;

  // If shares tag, prefer "shares"
  if (localTagName.toLowerCase().includes("share")) {
    if (unitKeys.includes("shares")) return "shares";
  }

  // Prefer USD if present
  if (unitKeys.includes("USD")) return "USD";

  // Otherwise pick the first available unit
  return unitKeys[0];
}

function extractLatest(factsByTaxonomy, refs) {
  for (const ref of refs) {
    const taxonomy = ref?.taxonomy;
    const tag = ref?.tag;
    if (!taxonomy || !tag) continue;

    const node = factsByTaxonomy?.[taxonomy]?.[tag];
    if (!node?.units) continue;

    const unit = chooseUnit(node.units, tag);
    if (!unit) continue;

    const arr = node.units[unit]
      ?.filter(x => x && x.end && x.val !== undefined && x.val !== null);

    if (!arr || arr.length === 0) continue;

    const latest = pickLatestFact(arr);

    return {
      taxonomy,
      tag,
      unit,
      end: latest.end || null,
      fy: latest.fy ?? null,
      fp: latest.fp ?? null,
      form: latest.form ?? null,
      filed: latest.filed ?? null,
      val: latest.val
    };
  }
  return null;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const fundamentals = [];
  let processed = 0;
  let skipped = 0;

  // Your universe.json is: { "AEM": { name, queries, cik? }, ... }
  for (const [ticker, info] of Object.entries(universe)) {
    const cik = info?.cik;
    if (!cik) {
      console.log(`Skip ${ticker}: no CIK yet`);
      skipped++;
      continue;
    }

    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

    await throttle();
    let data;
    try {
      data = await secGetJson(url, userAgent);
    } catch (e) {
      console.log(`FAIL ${ticker}: companyfacts fetch error`);
      console.log(String(e).slice(0, 300));
      skipped++;
      continue;
    }

    const factsByTaxonomy = data?.facts || {};
    if (!Object.keys(factsByTaxonomy).length) {
      console.log(`Skip ${ticker}: no company facts taxonomy data`);
      skipped++;
      continue;
    }

    const row = {
      cik,
      ticker,
      name: info?.name ?? null,
      asOf: new Date().toISOString()
    };

    for (const [metric, refs] of Object.entries(METRICS)) {
      row[metric] = extractLatest(factsByTaxonomy, refs);
    }

    fundamentals.push(row);
    processed++;
    console.log(`OK ${ticker}: fundamentals extracted`);
  }

  fs.writeFileSync(outFile, JSON.stringify(fundamentals, null, 2));
  console.log(`\nWrote ${outFile}`);
  console.log(`Processed: ${processed}, Skipped: ${skipped}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
