import fs from "fs/promises";
import path from "path";
import * as cheerio from "cheerio";

const ROOT = process.cwd();
const UNIVERSE_FILE = path.join(ROOT, "data", "universe.json");
const OUTPUT_DIR = path.join(ROOT, "public", "data", "ex99_1_reports");

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Minerlytics your-email@example.com";

const SEC_ARCHIVES = "https://www.sec.gov/Archives";
const SEC_SUBMISSIONS = "https://data.sec.gov/submissions";

const TARGET_FORMS = new Set([
  "8-K",
  "8-K/A",
  "6-K",
  "6-K/A",
  "10-K",
  "10-K/A",
  "10-Q",
  "10-Q/A",
  "20-F",
  "20-F/A",
  "40-F",
  "40-F/A",
]);

function zeroPadCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function noDashAccession(accession) {
  return String(accession || "").replace(/-/g, "");
}

function normalizeText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw);
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

async function writeText(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, "utf-8");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html, text/plain, application/xhtml+xml, */*",
      "Accept-Encoding": "gzip, deflate",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 500)}`);
  }

  return await res.text();
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
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 500)}`);
  }

  return await res.json();
}

function getTicker(item) {
  return item.ticker || item.symbol || item.code || item.Ticker || null;
}

function getCik(item) {
  return item.cik || item.CIK || item.company_cik || null;
}

async function loadUniverse() {
  const raw = await readJson(UNIVERSE_FILE);
  if (Array.isArray(raw)) return raw;

  return Object.entries(raw).map(([ticker, value]) => ({
    ticker,
    ...value,
  }));
}

async function fetchRecentFilings(cik) {
  const cik10 = zeroPadCik(cik);
  const url = `${SEC_SUBMISSIONS}/CIK${cik10}.json`;
  const data = await fetchJson(url);

  const recent = data?.filings?.recent;
  if (!recent) return [];

  const out = [];
  const forms = recent.form || [];
  const accessions = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const primaryDocs = recent.primaryDocument || [];
  const primaryDesc = recent.primaryDocDescription || [];

  for (let i = 0; i < forms.length; i++) {
    if (!TARGET_FORMS.has(forms[i])) continue;

    out.push({
      form: forms[i],
      accessionNumber: accessions[i],
      filingDate: filingDates[i],
      primaryDocument: primaryDocs[i],
      primaryDocDescription: primaryDesc[i],
    });
  }

  return out;
}

function buildIndexUrl(cik, accession) {
  const cikNoPad = String(Number(String(cik).replace(/\D/g, "")));
  const accessionNoDash = noDashAccession(accession);
  return `${SEC_ARCHIVES}/edgar/data/${cikNoPad}/${accessionNoDash}/${accession}-index.html`;
}

function buildDocUrlFromHref(href) {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("/")) return `https://www.sec.gov${href}`;
  return `${SEC_ARCHIVES}/${href.replace(/^Archives\//, "")}`;
}

function parseIndexForEx991(indexHtml) {
  const $ = cheerio.load(indexHtml);
  const docs = [];

  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 4) return;

    const seq = $(cells[0]).text().trim();
    const description = $(cells[1]).text().trim();
    const docAnchor = $(cells[2]).find("a");
    const filename = docAnchor.text().trim();
    const href = docAnchor.attr("href");
    const type = $(cells[3]).text().trim();
    const size = $(cells[4]).text().trim();

    docs.push({
      seq,
      description,
      filename,
      href,
      type,
      size,
      url: buildDocUrlFromHref(href),
    });
  });

  const exact = docs.find((d) => normalizeText(d.type).toUpperCase() === "EX-99.1");
  if (exact) return exact;

  const fallback = docs.find((d) => {
    const combined = `${d.type} ${d.description} ${d.filename}`.toUpperCase();
    return combined.includes("EX-99.1") || combined.includes("EX99-1");
  });

  return fallback || null;
}

function extractTables($) {
  const tables = [];

  $("table").each((tableIdx, tableEl) => {
    const rows = [];
    $(tableEl)
      .find("tr")
      .each((_, tr) => {
        const cells = [];
        $(tr)
          .find("th, td")
          .each((__, cell) => {
            const txt = normalizeText($(cell).text());
            if (txt) cells.push(txt);
          });

        if (cells.length) rows.push(cells);
      });

    if (rows.length) {
      tables.push({
        tableIndex: tableIdx,
        rowCount: rows.length,
        rows,
      });
    }
  });

  return tables;
}

function extractHeadings($) {
  const headings = [];

  $("h1, h2, h3, h4, h5, h6, b, strong, title").each((_, el) => {
    const text = normalizeText($(el).text());
    if (!text) return;
    if (text.length < 3) return;
    headings.push(text);
  });

  // de-duplicate while preserving order
  return [...new Set(headings)].slice(0, 200);
}

function extractHtmlDocument(html, url) {
  const $ = cheerio.load(html);

  $("script, style, noscript").remove();

  const title = normalizeText($("title").first().text());
  const headings = extractHeadings($);
  const tables = extractTables($);

  let bodyText = normalizeText($("body").text());
  if (!bodyText) {
    bodyText = normalizeText($.text());
  }

  return {
    sourceUrl: url,
    contentType: "html",
    title,
    headings,
    text: bodyText,
    tables,
    html,
  };
}

function extractTxtDocument(txt, url) {
  return {
    sourceUrl: url,
    contentType: "text",
    title: "",
    headings: [],
    text: normalizeText(txt),
    tables: [],
    raw: txt,
  };
}

async function downloadAndExtractExhibit(docUrl) {
  const raw = await fetchText(docUrl);

  if (/<html/i.test(raw) || /<!doctype html/i.test(raw)) {
    return extractHtmlDocument(raw, docUrl);
  }

  return extractTxtDocument(raw, docUrl);
}

async function processCompany(item) {
  const ticker = getTicker(item);
  const cik = getCik(item);

  if (!ticker || !cik) {
    return {
      ticker: ticker || null,
      cik: cik || null,
      error: "Missing ticker or CIK",
    };
  }

  let recentFilings = [];
  try {
    recentFilings = await fetchRecentFilings(cik);
  } catch (err) {
    return [{
      ticker,
      cik: zeroPadCik(cik),
      error: `Could not load SEC submissions feed: ${err.message}`,
    }];
  }

  const outputs = [];

  for (const filing of recentFilings) {
    try {
      const indexUrl = buildIndexUrl(cik, filing.accessionNumber);
      const indexHtml = await fetchText(indexUrl);
      const exhibit = parseIndexForEx991(indexHtml);

      if (!exhibit?.url) continue;

      const extracted = await downloadAndExtractExhibit(exhibit.url);

      outputs.push({
        ticker,
        cik: zeroPadCik(cik),
        form: filing.form,
        filingDate: filing.filingDate,
        accessionNumber: filing.accessionNumber,
        primaryDocument: filing.primaryDocument,
        indexUrl,
        exhibit: {
          type: exhibit.type,
          description: exhibit.description,
          filename: exhibit.filename,
          url: exhibit.url,
        },
        extractedAt: new Date().toISOString(),
        report: extracted,
      });
    } catch (err) {
      outputs.push({
        ticker,
        cik: zeroPadCik(cik),
        form: filing.form,
        filingDate: filing.filingDate,
        accessionNumber: filing.accessionNumber,
        error: err.message,
      });
    }
  }

  return outputs;
}

async function run() {
  const universe = await loadUniverse();
  const manifest = [];
  let companyFailures = 0;

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  for (const item of universe) {
    const ticker = getTicker(item);
    console.log(`Processing ${ticker || "UNKNOWN"}`);

    const results = await processCompany(item);
    const records = Array.isArray(results) ? results : [results];

    for (const record of records) {
      const safeTicker = String(record.ticker || "unknown").toUpperCase();
      const accession = String(record.accessionNumber || "na").replace(/[^a-zA-Z0-9_-]/g, "_");
      const base = `${safeTicker}_${accession}`;

      await writeJson(path.join(OUTPUT_DIR, `${base}.json`), record);

      if (record?.report?.text) {
        await writeText(path.join(OUTPUT_DIR, `${base}.txt`), record.report.text);
      }

      manifest.push({
        ticker: record.ticker,
        cik: record.cik,
        filingDate: record.filingDate,
        form: record.form,
        accessionNumber: record.accessionNumber,
        hasEx991: !!record.exhibit,
        outputJson: `${base}.json`,
        outputText: record?.report?.text ? `${base}.txt` : null,
        error: record.error || null,
      });

      if (record.error) companyFailures++;
    }
  }

  await writeJson(path.join(OUTPUT_DIR, "_manifest.json"), manifest);
  console.log(`Wrote ${manifest.length} records to ${OUTPUT_DIR}`);
  console.log(`Companies/records with errors: ${companyFailures}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
