import fs from "node:fs";
import path from "node:path";
import { secGetJson, createThrottle } from "./secFetch.js";

const rulesPath = path.resolve("data/miner.rules.json");
const universePath = path.resolve("data/universe.json");

const outDir = path.resolve("public/data");
const outCompanyMeta = path.join(outDir, "company_meta.json");
const outFilings = path.join(outDir, "filings.json");

const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const universe = JSON.parse(fs.readFileSync(universePath, "utf8"));

const userAgent = rules.edgar?.userAgent;
if (!userAgent) {
  throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");
}

const rps = rules.edgar?.rps ?? 1;
const forms = rules.edgar?.forms ?? ["10-K", "10-Q", "8-K"];
const lookbackDays = rules.edgar?.lookbackDays ?? 365;

const throttle = createThrottle(rps);

function withinLookback(dateStr) {
  const cutoff = Date.now() - lookbackDays * 86400000;
  return new Date(dateStr).getTime() >= cutoff;
}

function normalizeRecent(recent) {
  // SEC submissions "recent" is parallel arrays
  const out = [];
  const n = recent.accessionNumber?.length ?? 0;
  for (let i = 0; i < n; i++) {
    out.push({
      accessionNumber: recent.accessionNumber[i],
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] ?? null,
      primaryDocument: recent.primaryDocument?.[i] ?? null
    });
  }
  return out;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const companyMeta = [];
  const filings = [];

  let processed = 0;
  let skipped = 0;

  // universe.json: { "AEM": { name, queries, cik? }, ... }
  for (const [ticker, info] of Object.entries(universe)) {
    const cik = info?.cik;
    const name = info?.name ?? null;

    if (!cik) {
      console.log(`Skip ${ticker}: no CIK`);
      skipped++;
      continue;
    }

    const url = `https://data.sec.gov/submissions/CIK${cik}.json`;

    await throttle();
    let sub;
    try {
      sub = await secGetJson(url, userAgent);
    } catch (e) {
      console.log(`FAIL ${ticker}: submissions fetch error`);
      console.log(String(e).slice(0, 300));
      skipped++;
      continue;
    }

    companyMeta.push({
      cik,
      ticker: (sub.tickers && sub.tickers[0]) || ticker,
      name: sub.name || name,
      sic: sub.sic || null,
      sicDescription: sub.sicDescription || null,
      exchanges: sub.exchanges || null
    });

    const recent = sub?.filings?.recent;
    if (recent) {
      const rows = normalizeRecent(recent)
        .filter(r => r.form && forms.includes(r.form))
        .filter(r => r.filingDate && withinLookback(r.filingDate));

      for (const r of rows) {
        filings.push({
          cik,
          ticker: (sub.tickers && sub.tickers[0]) || ticker,
          accessionNumber: r.accessionNumber,
          form: r.form,
          filingDate: r.filingDate,
          reportDate: r.reportDate,
          primaryDocument: r.primaryDocument
        });
      }

      console.log(`OK ${ticker}: filings kept=${rows.length}`);
    } else {
      console.log(`OK ${ticker}: no recent filings block`);
    }

    processed++;
  }

  fs.writeFileSync(outCompanyMeta, JSON.stringify(companyMeta, null, 2));
  fs.writeFileSync(outFilings, JSON.stringify(filings, null, 2));

  console.log(`\nWrote ${outCompanyMeta} (${companyMeta.length} companies)`);
  console.log(`Wrote ${outFilings} (${filings.length} filings)`);
  console.log(`Processed: ${processed}, Skipped: ${skipped}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
