import fs from "node:fs";
import path from "node:path";
import { secGetJson, createThrottle } from "./secFetch.js";

const rules = JSON.parse(fs.readFileSync(path.resolve("config/miner.rules.json"), "utf8"));
const userAgent = rules.edgar?.userAgent;
const rps = rules.edgar?.rps ?? 3;
if (!userAgent) throw new Error("Missing rules.edgar.userAgent in config/miner.rules.json");

const throttle = createThrottle(rps);

const filingsPath = path.resolve("public/data/filings.json");
if (!fs.existsSync(filingsPath)) throw new Error("Run pullSubmissions.js first to generate public/data/filings.json");

const filings = JSON.parse(fs.readFileSync(filingsPath, "utf8"));

function accessionNoDashes(acc) { return acc.replace(/-/g, ""); }
function cikNoLeadingZeros(cik10) { return String(parseInt(cik10, 10)); }

function looksLikeEx96(name, desc) {
  const n = (name || "").toLowerCase();
  const d = (desc || "").toLowerCase();
  return n.includes("ex96") || d.includes("exhibit 96") || n.match(/ex96[-_]/);
}

async function main() {
  const eligibleForms = new Set(["10-K", "20-F", "40-F"]);
  const maxPerCompany = rules.trs?.maxFilingsToScanPerCompany ?? 20;
  const needles = (rules.trs?.searchDescriptionContains ?? ["Technical Report Summary"]).map(s => s.toLowerCase());

  const byCik = new Map();
  for (const f of filings) {
    if (!eligibleForms.has(f.form)) continue;
    if (!byCik.has(f.cik)) byCik.set(f.cik, []);
    byCik.get(f.cik).push(f);
  }
  for (const [cik, arr] of byCik) {
    arr.sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
    byCik.set(cik, arr.slice(0, maxPerCompany));
  }

  const trsHits = [];

  for (const [cik, arr] of byCik) {
    for (const f of arr) {
      const cikRaw = cikNoLeadingZeros(cik);
      const accNoDash = accessionNoDashes(f.accessionNumber);

      const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikRaw}/${accNoDash}/index.json`;
      await throttle();
      const index = await secGetJson(indexUrl, userAgent);

      const items = index?.directory?.item || [];
      for (const it of items) {
        const desc = it.description || "";
        const isNeedle = needles.some(n => desc.toLowerCase().includes(n));
        const isEx96 = looksLikeEx96(it.name, desc);

        if (isNeedle || isEx96) {
          trsHits.push({
            cik,
            ticker: f.ticker,
            accessionNumber: f.accessionNumber,
            form: f.form,
            filingDate: f.filingDate,
            fileName: it.name,
            description: desc || null,
            url: `https://www.sec.gov/Archives/edgar/data/${cikRaw}/${accNoDash}/${it.name}`
          });
        }
      }

      console.log(`${f.ticker} ${f.form} ${f.filingDate}: scanned`);
    }
  }

  fs.mkdirSync(path.resolve("public/data"), { recursive: true });
  fs.writeFileSync(path.resolve("public/data/trs_index.json"), JSON.stringify(trsHits, null, 2));
  console.log(`Wrote public/data/trs_index.json (${trsHits.length} hits)`);
}

main().catch(e => { console.error(e); process.exit(1); });
