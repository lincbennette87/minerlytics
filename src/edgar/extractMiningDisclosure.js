import fs from "node:fs";
import path from "node:path";
import { secGetText, createThrottle } from "./secFetch.js";
import { load } from "cheerio";

const rules = JSON.parse(fs.readFileSync("data/miner.rules.json", "utf8"));
const userAgent = rules.edgar?.userAgent;
if (!userAgent) throw new Error("Missing rules.edgar.userAgent in data/miner.rules.json");

const rps = rules.edgar?.rps ?? 1;
const throttle = createThrottle(rps);

const outDir = path.resolve("public/data");
const inFilings = path.join(outDir, "filings.json");
const outIndex = path.join(outDir, "mining_disclosure_index.json");
const outReportsDir = path.join(outDir, "mining_disclosure_reports");

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

function cikNoZeros(cik){ return String(cik).replace(/\D/g,"").replace(/^0+/,""); }
function accessionNoDashes(acc){ return String(acc).replaceAll("-",""); }

function isUsefulForm(form){
  const f = String(form || "").toUpperCase();
  return ["10-K","20-F","40-F","10-Q"].includes(f);
}

function looksMiningText(s){
  const t = String(s || "").toLowerCase();
  const keys = [
    "mineral resources",
    "mineral reserves",
    "measured",
    "indicated",
    "inferred",
    "proven",
    "probable",
    "qualified person",
    "sk-1300",
    "regulation s-k 1300"
  ];
  return keys.some(k => t.includes(k));
}

function extractTextBlocks($){
  // Get readable text by sectioning on headings-ish elements
  const blocks = [];
  const candidates = $("h1,h2,h3,h4,strong,b,div,p");
  let current = { heading: null, text: "" };

  candidates.each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    if (!txt) return;

    const isHeading = ["h1","h2","h3","h4"].includes(tag) || (tag === "strong" && txt.length < 120);

    if (isHeading) {
      if (current.text && looksMiningText(current.text)) blocks.push(current);
      current = { heading: txt, text: "" };
    } else {
      // accumulate
      current.text += (current.text ? "\n" : "") + txt;
    }
  });

  if (current.text && looksMiningText(current.text)) blocks.push(current);
  return blocks;
}

function extractRelevantTables($){
  const out = [];
  $("table").each((_, table) => {
    const rows = [];
    $(table).find("tr").each((__, tr) => {
      const cells = [];
      $(tr).find("th,td").each((___, td) => {
        const txt = $(td).text().replace(/\s+/g, " ").trim();
        cells.push(txt);
      });
      if (cells.some(looksMiningText) || cells.join(" ").toLowerCase().includes("mineral")) {
        rows.push(cells);
      }
    });

    // Keep only non-empty tables where at least one row looks mining-related
    if (rows.length) out.push({ rows });
  });
  return out;
}

async function main(){
  ensureDir(outDir);
  ensureDir(outReportsDir);

  if (!fs.existsSync(inFilings)) throw new Error("Missing public/data/filings.json. Run edgar:submissions first.");

  const filings = JSON.parse(fs.readFileSync(inFilings, "utf8"));
  const targets = filings.filter(f => isUsefulForm(f.form));

  const index = {
    generatedAt: new Date().toISOString(),
    scanned: targets.length,
    found: 0,
    items: []
  };

  for (const f of targets) {
    const cik = f.cik;
    const ticker = f.ticker;
    const accession = f.accessionNumber;
    const primary = f.primaryDocument;

    if (!cik || !accession || !primary) continue;

    const cikNz = cikNoZeros(cik);
    const accNoDash = accessionNoDashes(accession);
    const url = `https://www.sec.gov/Archives/edgar/data/${cikNz}/${accNoDash}/${primary}`;

    await throttle();
    let html;
    try {
      html = await secGetText(url, userAgent);
    } catch (e) {
      console.log(`FAIL fetch ${ticker} ${accession}: ${String(e).slice(0,160)}`);
      continue;
    }

    const $ = load(html);
    const textBlocks = extractTextBlocks($);
    const tables = extractRelevantTables($);

    if (textBlocks.length === 0 && tables.length === 0) {
      continue;
    }

    const report = {
      ticker,
      cik,
      accessionNumber: accession,
      form: f.form,
      filingDate: f.filingDate,
      reportDate: f.reportDate,
      primaryDocument: primary,
      url,
      extractedAt: new Date().toISOString(),
      textBlocks,
      tables
    };

    const outName = `${ticker}_${accession}.json`.replaceAll("/", "_");
    fs.writeFileSync(path.join(outReportsDir, outName), JSON.stringify(report, null, 2));

    index.found++;
    index.items.push({
      ticker,
      cik,
      accessionNumber: accession,
      form: f.form,
      filingDate: f.filingDate,
      url,
      output: `public/data/mining_disclosure_reports/${outName}`
    });

    console.log(`OK mining disclosure ${ticker} ${accession}: blocks=${textBlocks.length} tables=${tables.length}`);
  }

  fs.writeFileSync(outIndex, JSON.stringify(index, null, 2));
  console.log(`\nWrote ${outIndex} found=${index.found}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
