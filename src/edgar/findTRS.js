import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "public", "data");
const HEADERS = {
  // Use a real contact email to reduce SEC blocking
  "user-agent": "Minerlytics EDGAR TRS Finder (contact: vishakhedu@gmail.com)",
  accept: "application/json,text/html,*/*",
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cikNoZeros(cik) {
  return String(cik).replace(/\D/g, "").replace(/^0+/, "");
}

function accessionNoDashes(acc) {
  return String(acc).replaceAll("-", "");
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.json();
}

// Score SEC filing package files to identify TRS exhibits reliably
function scoreTRSFile(item) {
  const name = String(item?.name || "").toLowerCase();
  const desc = String(item?.description || "").toLowerCase();
  let s = 0;

  // Description matches (best case)
  if (desc.includes("technical report summary")) s += 120;
  if (desc.includes("technical report")) s += 80;
  if (desc.includes("exhibit 96")) s += 70;

  // Filename patterns (very common)
  if (name.includes("ex96")) s += 100;         // ex96_1.htm, ex96-1.htm
  if (name.includes("exhibit96")) s += 90;
  if (name.includes("96.1")) s += 70;
  if (name.includes("trs")) s += 40;
  if (name.includes("technical")) s += 35;

  // Prefer HTML
  if (name.endsWith(".htm") || name.endsWith(".html")) s += 25;

  // Penalize
  if (name.endsWith(".xml")) s -= 30;
  if (name.endsWith(".jpg") || name.endsWith(".png")) s -= 80;

  return s;
}

// Pull candidate filings from submissions.json output (your pipeline must already create filings.json)
function getCandidateFilingsFromFilingsJson() {
  const filingsPath = path.join(OUT_DIR, "filings.json");
  const filings = readJsonIfExists(filingsPath);

  if (!filings) {
    console.log("No public/data/filings.json found. Run edgar:submissions first.");
    return [];
  }

  // Try to normalize possible shapes without guessing too hard:
  // 1) Array of filings [{ticker,cik,accession,filingDate,form}, ...]
  if (Array.isArray(filings)) return filings;

  // 2) { items: [...] }
  if (Array.isArray(filings.items)) return filings.items;

  // 3) { <ticker>: { filings: [...] } }
  const out = [];
  for (const [k, v] of Object.entries(filings)) {
    const arr = v?.filings;
    if (Array.isArray(arr)) {
      for (const f of arr) out.push({ ticker: k, ...f });
    }
  }
  return out;
}

async function main() {
  ensureDir(OUT_DIR);

  // Use filings.json as the “universe” of recent filings to scan
  const candidates = getCandidateFilingsFromFilingsJson();

  // Keep it bounded so you don’t hammer SEC.
  // Scan most-recent first if dates exist.
  candidates.sort((a, b) => String(b.filingDate || "").localeCompare(String(a.filingDate || "")));

  const MAX_SCAN = 120; // start small; increase after it works
  const toScan = candidates.slice(0, MAX_SCAN);

  console.log(`Scanning up to ${toScan.length} filings for TRS exhibits...`);

  const trsHits = [];
  let scanned = 0;

  for (const f of toScan) {
    const ticker = f.ticker || f.symbol || null;
    const cik = f.cik || f.cik10 || f.cik_str || null;
    const accession = f.accession || f.accessionNumber || f.accession_number || null;
    const filingDate = f.filingDate || f.filedAt || f.filing_date || null;
    const form = f.form || f.formType || f.form_type || null;

    if (!cik || !accession) continue;

    scanned++;
    const cikNz = cikNoZeros(cik);
    const accNoDash = accessionNoDashes(accession);

    const indexUrl = `https://data.sec.gov/Archives/edgar/data/${cikNz}/${accNoDash}/index.json`;

    try {
      const idx = await fetchJson(indexUrl);
      const items = idx?.directory?.item || [];

      if (!items.length) continue;

      const scored = items
        .map((it) => ({ ...it, _score: scoreTRSFile(it) }))
        .sort((a, b) => b._score - a._score);

      const best = scored[0];
      if (best && best._score >= 80) {
        const exhibitUrl = `https://www.sec.gov/Archives/edgar/data/${cikNz}/${accNoDash}/${best.name}`;
        trsHits.push({
          ticker,
          cik: String(cik).padStart(10, "0"),
          accession,
          filingDate,
          form,
          exhibit: {
            name: best.name,
            description: best.description || null,
            url: exhibitUrl,
            score: best._score
          }
        });
        console.log(`TRS ✅ ${ticker || ""} ${accession} -> ${best.name} (${best._score})`);
      }
    } catch (e) {
      // Don’t fail the whole job on a single filing
      console.log(`TRS scan error for ${ticker || ""} ${accession}: ${String(e?.message || e)}`);
    }

    // Throttle gently to be SEC-friendly
    await sleep(200);
  }

  const outPath = path.join(OUT_DIR, "trs_index.json");
  writeJson(outPath, {
    generatedAt: new Date().toISOString(),
    scanned,
    found: trsHits.length,
    items: trsHits,
  });

  console.log(`Done. Scanned ${scanned}. Found ${trsHits.length} TRS exhibits.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
