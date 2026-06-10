import fs from "node:fs";
import path from "node:path";
import { secGetJson } from "./secFetch.js";

const universePath = path.resolve("data/universe.json");
const rulesPath = path.resolve("data/miner.rules.json");
const companyMetaPath = path.resolve("public/data/company_meta.json");
const filingsPath = path.resolve("public/data/filings.json");
const disclosureIndexPath = path.resolve("public/data/mining_disclosure_index.json");
const coverageReportPath = path.resolve("public/data/sec_coverage_report.json");

function pad10(n) { return String(n).padStart(10, "0"); }

function normalizeName(value = "") {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(CORP(ORATION)?|INC(ORPORATED)?|LTD|LIMITED|PLC|SA|NV|HOLDINGS?|GROUP|CO|COMPANY|ETF|TRUST)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function buildLocalCikMap() {
  const localMap = new Map();

  const companyMeta = readJsonIfExists(companyMetaPath, []);
  for (const row of Array.isArray(companyMeta) ? companyMeta : []) {
    const ticker = String(row?.ticker || "").toUpperCase().trim();
    const cik = String(row?.cik || "").trim();
    if (ticker && cik) localMap.set(ticker, pad10(cik));
  }

  const filings = readJsonIfExists(filingsPath, []);
  for (const row of Array.isArray(filings) ? filings : []) {
    const ticker = String(row?.ticker || "").toUpperCase().trim();
    const cik = String(row?.cik || "").trim();
    if (ticker && cik) localMap.set(ticker, pad10(cik));
  }

  const disclosureIndex = readJsonIfExists(disclosureIndexPath, { items: [] });
  const items = Array.isArray(disclosureIndex?.items) ? disclosureIndex.items : [];
  for (const row of items) {
    const ticker = String(row?.ticker || "").toUpperCase().trim();
    const cik = String(row?.cik || "").trim();
    if (ticker && cik) localMap.set(ticker, pad10(cik));
  }

  return localMap;
}

async function main() {
  const universe = JSON.parse(fs.readFileSync(universePath, "utf8"));
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));

  const userAgent = rules.edgar?.userAgent;
  if (!userAgent) throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");

  const mapUrl = "https://www.sec.gov/files/company_tickers.json";
  const mapObj = await secGetJson(mapUrl, userAgent);

  const byTicker = new Map();
  const byName = new Map();
  for (const k of Object.keys(mapObj)) {
    const row = mapObj[k];
    const ticker = String(row.ticker || "").toUpperCase().trim();
    const cik = row.cik_str;
    const title = normalizeName(row.title || "");
    if (ticker && cik) byTicker.set(ticker, cik);
    if (title && cik && !byName.has(title)) byName.set(title, cik);
  }

  const localCiks = buildLocalCikMap();
  let updated = 0;
  const unresolved = [];
  for (const [ticker, info] of Object.entries(universe)) {
    if (!info || typeof info !== "object") continue;
    if (info.cik) continue;

    const upperTicker = String(ticker).toUpperCase().trim();
    let cikStr =
      localCiks.get(upperTicker) ||
      byTicker.get(upperTicker) ||
      null;

    if (!cikStr) {
      const namesToTry = [
        info.name,
        ...(Array.isArray(info.queries) ? info.queries : []),
      ]
        .map((value) => normalizeName(value))
        .filter(Boolean);

      for (const candidateName of namesToTry) {
        const match = byName.get(candidateName);
        if (match) {
          cikStr = match;
          break;
        }
      }
    }

    if (!cikStr) {
      unresolved.push({
        ticker: upperTicker,
        name: info?.name || null,
        metal: info?.metal || null,
      });
      continue;
    }

    universe[ticker] = { ...info, cik: pad10(cikStr) };
    updated++;
  }

  fs.writeFileSync(universePath, JSON.stringify(universe, null, 2));
  fs.writeFileSync(coverageReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalUniverseTickers: Object.keys(universe).length,
    resolvedWithCik: Object.values(universe).filter((item) => item?.cik).length,
    unresolvedCount: unresolved.length,
    unresolved,
  }, null, 2));

  console.log(`Done. Added CIK to ${updated} companies.`);
  console.log(`Remaining unresolved tickers: ${unresolved.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
