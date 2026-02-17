import fs from "node:fs";
import path from "node:path";
import { secGetJson, createThrottle } from "./secFetch.js";

const rules = JSON.parse(fs.readFileSync(path.resolve("data/miner.rules.json"), "utf8"));
const universe = JSON.parse(fs.readFileSync(path.resolve("data/universe.json"), "utf8"));

const userAgent = rules.edgar?.userAgent;
const rps = rules.edgar?.rps ?? 3;
const forms = rules.edgar?.forms ?? ["10-K", "10-Q", "8-K"];
const lookbackDays = rules.edgar?.lookbackDays ?? 365;

if (!userAgent) throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");

const throttle = createThrottle(rps);

function normalizeRecent(recent) {
  const out = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    out.push({
      accessionNumber: recent.accessionNumber[i],
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] ?? null,
      primaryDocument: recent.primaryDocument[i]
    });
  }
  return out;
}

function withinLookback(dateStr) {
  const cutoff = Date.now() - lookbackDays * 86400000;
  return new Date(dateStr).getTime() >= cutoff;
}

async function main() {
  const companyMeta = [];
  const filings = [];

  for (const [ticker, info] of Object.entries(universe)) {
  const cik = info?.cik;
  const name = info?.name;

  if (!cik) {
    console.log(`Skip ${ticker} (no CIK)`);
    continue;
  }

  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  ...
  companyMeta.push({
    cik,
    ticker: (sub.tickers && sub.tickers[0]) || ticker,
    name: sub.name || name || null,
    sic: sub.sic || null,
    sicDescription: sub.sicDescription || null,
    exchanges: sub.exchanges || null
  });

  ...
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


    const recent = sub?.filings?.recent;
    if (!recent) continue;

    const rows = normalizeRecent(recent)
      .filter(r => forms.includes(r.form))
      .filter(r => withinLookback(r.filingDate));

    for (const r of rows) {
      filings.push({
        cik: c.cik,
        ticker: (sub.tickers && sub.tickers[0]) || c.ticker,
        accessionNumber: r.accessionNumber,
        form: r.form,
        filingDate: r.filingDate,
        reportDate: r.reportDate,
        primaryDocument: r.primaryDocument
      });
    }

    console.log(`${c.ticker}: filings kept=${rows.length}`);
  }

  fs.mkdirSync(path.resolve("public/data"), { recursive: true });
  fs.writeFileSync(path.resolve("public/data/company_meta.json"), JSON.stringify(companyMeta, null, 2));
  fs.writeFileSync(path.resolve("public/data/filings.json"), JSON.stringify(filings, null, 2));
  console.log("Wrote public/data/company_meta.json and public/data/filings.json");
}

main().catch(e => { console.error(e); process.exit(1); });
