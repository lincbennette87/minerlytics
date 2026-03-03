import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

const OUT_DIR = "public/data";
const REPORT_DIR = "public/data/trs_reports";

const HEADERS = {
  "user-agent": "Minerlytics EDGAR Extractor (contact@minerlytics.ai)",
  "accept": "application/json,text/html"
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cikNoZeros(cik) {
  return String(cik).replace(/\D/g, "").replace(/^0+/, "");
}

function accNoDashes(acc) {
  return acc.replaceAll("-", "");
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error("Failed: " + url);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error("Failed: " + url);
  return r.text();
}

function extractHtml(html) {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();

  const sections = [];
  let current = { heading: "Document", text: "" };

  $("h1,h2,h3,p").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (!text) return;

    if (tag.startsWith("h")) {
      if (current.text) sections.push(current);
      current = { heading: text, text: "" };
    } else {
      current.text += "\n" + text;
    }
  });

  if (current.text) sections.push(current);
  return sections;
}

async function main() {
  ensureDir(REPORT_DIR);

  const filings = JSON.parse(
    fs.readFileSync(path.join(OUT_DIR, "trs_index.json"))
  );

  const results = [];

  for (const item of filings.items || []) {
    const cik = item.cik;
    const accession = item.accession;

    const cikNz = cikNoZeros(cik);
    const acc = accNoDashes(accession);

    const indexUrl =
      `https://data.sec.gov/Archives/edgar/data/${cikNz}/${acc}/index.json`;

    const idx = await fetchJson(indexUrl);

    const files = idx.directory.item || [];

    const candidate = files.find(f =>
      (f.description || "").toLowerCase().includes("technical report")
    );

    if (!candidate) continue;

    const docUrl =
      `https://www.sec.gov/Archives/edgar/data/${cikNz}/${acc}/${candidate.name}`;

    const html = await fetchText(docUrl);
    const sections = extractHtml(html);

    const output = {
      cik,
      accession,
      exhibit: docUrl,
      extractedAt: new Date().toISOString(),
      sections
    };

    const outFile =
      `${REPORT_DIR}/${cik}_${accession}.json`;

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

    results.push(output);
  }

  console.log("Extracted:", results.length);
}

main();
