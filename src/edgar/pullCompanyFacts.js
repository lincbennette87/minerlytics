import fs from "node:fs";
import path from "node:path";
import { secGetJson, createThrottle } from "./secFetch.js";

const rules = JSON.parse(fs.readFileSync(path.resolve("data/miner.rules.json"), "utf8"));
const universe = JSON.parse(fs.readFileSync(path.resolve("data/universe.json"), "utf8"));

const userAgent = rules.edgar?.userAgent;
const rps = rules.edgar?.rps ?? 3;
if (!userAgent) throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");

const throttle = createThrottle(rps);

const METRICS = {
  revenue: ["Revenues", "SalesRevenueNet"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  cashFlowOps: ["NetCashProvidedByUsedInOperatingActivities"],
  epsBasic: ["EarningsPerShareBasic"],
  epsDiluted: ["EarningsPerShareDiluted"],
  sharesOutstanding: ["CommonStockSharesOutstanding"]
};

function pickLatest(arr) {
  const sorted = [...arr].sort((a, b) => new Date(b.end) - new Date(a.end));
  return sorted[0];
}

function extractLatest(usgaap, tagList) {
  for (const tag of tagList) {
    const node = usgaap?.[tag];
    if (!node?.units) continue;

    const unitKeys = Object.keys(node.units);
    const preferred = unitKeys.includes("USD") ? "USD"
      : unitKeys.includes("shares") ? "shares"
      : unitKeys[0];

    const arr = node.units[preferred]?.filter(x => x.end && x.val !== undefined);
    if (!arr || arr.length === 0) continue;

    const latest = pickLatest(arr);
    return { tag, unit: preferred, end: latest.end, fy: latest.fy, fp: latest.fp, val: latest.val };
  }
  return null;
}

async function main() {
  const fundamentals = [];

  for (const c of universe.companies) {
    if (!c.cik) continue;

    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${c.cik}.json`;
    await throttle();
    const data = await secGetJson(url, userAgent);

    const usgaap = data?.facts?.["us-gaap"];
    if (!usgaap) continue;

    const row = { cik: c.cik, ticker: c.ticker, asOf: new Date().toISOString() };
    for (const [metric, tags] of Object.entries(METRICS)) {
      row[metric] = extractLatest(usgaap, tags);
    }
    fundamentals.push(row);
    console.log(`${c.ticker}: fundamentals ok`);
  }

  fs.mkdirSync(path.resolve("public/data"), { recursive: true });
  fs.writeFileSync(path.resolve("public/data/fundamentals_latest.json"), JSON.stringify(fundamentals, null, 2));
  console.log("Wrote public/data/fundamentals_latest.json");
}

main().catch(e => { console.error(e); process.exit(1); });
