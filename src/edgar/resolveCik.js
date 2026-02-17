import fs from "node:fs";
import path from "node:path";
import { secGetJson } from "./secFetch.js";

const universePath = path.resolve("data/universe.json");
const rulesPath = path.resolve("data/miner.rules.json");

function pad10(n) { return String(n).padStart(10, "0"); }

async function main() {
  const universe = JSON.parse(fs.readFileSync(universePath, "utf8"));
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));

  const userAgent = rules.edgar?.userAgent;
  if (!userAgent) throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");

  const mapUrl = "https://www.sec.gov/files/company_tickers.json";
  const mapObj = await secGetJson(mapUrl, userAgent);

  const byTicker = new Map();
  for (const k of Object.keys(mapObj)) {
    const row = mapObj[k];
    byTicker.set(String(row.ticker).toUpperCase(), row.cik_str);
  }

  let updated = 0;
  universe.companies = universe.companies.map(c => {
    if (c.cik) return c;
    const cikStr = byTicker.get(String(c.ticker).toUpperCase());
    if (!cikStr) return c;
    updated++;
    return { ...c, cik: pad10(cikStr) };
  });

  fs.writeFileSync(universePath, JSON.stringify(universe, null, 2));
  console.log(`Done. Added CIK to ${updated} companies.`);
}

main().catch(e => { console.error(e); process.exit(1); });
