import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const UNIVERSE_FILE = path.join(ROOT, "data", "universe.json");
const OUTPUT_DIR = path.join(ROOT, "public", "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "detailed_balance_sheets.json");

const USER_AGENT =
  process.env.SEC_USER_AGENT || "Minerlytics your-email@example.com";

/**
 * For standard concepts, we map directly to known US GAAP / IFRS tags.
 * For issuer-specific concepts, we try fuzzy label/concept matching
 * across ALL facts in the companyfacts payload.
 */
const FIELD_DEFS = [
  {
    key: "assets",
    label: "Assets",
    exactTags: [
      { taxonomy: "us-gaap", tag: "Assets" },
      { taxonomy: "ifrs-full", tag: "Assets" },
    ],
  },
  {
    key: "current_assets",
    label: "Current Assets",
    exactTags: [
      { taxonomy: "us-gaap", tag: "AssetsCurrent" },
      { taxonomy: "ifrs-full", tag: "CurrentAssets" },
    ],
  },
  {
    key: "cash_and_cash_equivalents",
    label: "Cash and cash equivalents",
    exactTags: [
      { taxonomy: "us-gaap", tag: "CashAndCashEquivalentsAtCarryingValue" },
      { taxonomy: "ifrs-full", tag: "CashAndCashEquivalents" },
    ],
  },
  {
    key: "prepaid_expenses_and_deposits",
    label: "Prepaid expenses and deposits",
    fuzzy: [
      "prepaid expenses and deposits",
      "prepaids and deposits",
      "prepaid expenses",
      "prepaid and other",
    ],
  },
  {
    key: "total_current_assets",
    label: "Total Current Assets",
    exactTags: [
      { taxonomy: "us-gaap", tag: "AssetsCurrent" },
      { taxonomy: "ifrs-full", tag: "CurrentAssets" },
    ],
  },
  {
    key: "non_current_assets",
    label: "Non-Current Assets",
    derivedGroup: ["mineral_properties", "reclamation_bonds", "property_and_equipment"],
  },
  {
    key: "mineral_properties",
    label: "Mineral properties",
    fuzzy: [
      "mineral properties",
      "mineral property",
      "mining properties",
      "mining property",
      "properties and mineral rights",
    ],
  },
  {
    key: "reclamation_bonds",
    label: "Reclamation bonds",
    fuzzy: [
      "reclamation bonds",
      "reclamation bond",
      "surety bonds",
      "bond deposits",
    ],
  },
  {
    key: "property_and_equipment",
    label: "Property and equipment",
    exactTags: [
      { taxonomy: "us-gaap", tag: "PropertyPlantAndEquipmentNet" },
      { taxonomy: "ifrs-full", tag: "PropertyPlantAndEquipment" },
    ],
    fuzzy: [
      "property and equipment",
      "property plant and equipment",
      "pp&e",
    ],
  },
  {
    key: "total_non_current_assets",
    label: "Total Non-Current Assets",
    exactTags: [
      { taxonomy: "us-gaap", tag: "AssetsNoncurrent" },
      { taxonomy: "ifrs-full", tag: "NoncurrentAssets" },
    ],
  },
  {
    key: "total_assets",
    label: "Total Assets",
    exactTags: [
      { taxonomy: "us-gaap", tag: "Assets" },
      { taxonomy: "ifrs-full", tag: "Assets" },
    ],
  },

  {
    key: "liabilities",
    label: "Liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "Liabilities" },
      { taxonomy: "ifrs-full", tag: "Liabilities" },
    ],
  },
  {
    key: "current_liabilities",
    label: "Current Liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "LiabilitiesCurrent" },
      { taxonomy: "ifrs-full", tag: "CurrentLiabilities" },
    ],
  },
  {
    key: "accounts_payable_and_accrued_liabilities",
    label: "Accounts payable and accrued liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "AccountsPayableAndAccruedLiabilitiesCurrentAndNoncurrent" },
      { taxonomy: "us-gaap", tag: "AccountsPayableCurrent" },
      { taxonomy: "us-gaap", tag: "AccruedLiabilitiesCurrent" },
    ],
    fuzzy: [
      "accounts payable and accrued liabilities",
      "accounts payable and accrued",
      "accounts payable",
      "accrued liabilities",
    ],
  },
  {
    key: "reclamation_obligation_current",
    label: "Reclamation and environmental obligation, current portion",
    fuzzy: [
      "reclamation and environmental obligation current",
      "reclamation obligation current",
      "asset retirement obligation current",
      "environmental obligation current",
      "reclamation and environmental obligation, current portion",
    ],
  },
  {
    key: "total_current_liabilities",
    label: "Total Current Liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "LiabilitiesCurrent" },
      { taxonomy: "ifrs-full", tag: "CurrentLiabilities" },
    ],
  },
  {
    key: "non_current_liabilities",
    label: "Non-Current Liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "LiabilitiesNoncurrent" },
      { taxonomy: "ifrs-full", tag: "NoncurrentLiabilities" },
    ],
  },
  {
    key: "debt_liability_convertible_debenture_net",
    label: "Debt liability of royalty convertible debenture, net",
    fuzzy: [
      "debt liability of royalty convertible debenture net",
      "convertible debenture net",
      "royalty convertible debenture net",
      "debt liability convertible debenture",
    ],
  },
  {
    key: "derivative_liability_convertible_debenture",
    label: "Derivative liability of royalty convertible debenture",
    fuzzy: [
      "derivative liability of royalty convertible debenture",
      "derivative liability convertible debenture",
      "derivative liability",
    ],
  },
  {
    key: "deferred_tax_liability",
    label: "Deferred tax liability",
    exactTags: [
      { taxonomy: "us-gaap", tag: "DeferredTaxLiabilitiesNetNoncurrent" },
      { taxonomy: "us-gaap", tag: "DeferredTaxLiabilitiesNoncurrent" },
      { taxonomy: "ifrs-full", tag: "DeferredTaxLiabilities" },
    ],
    fuzzy: [
      "deferred tax liability",
      "deferred income tax liability",
    ],
  },
  {
    key: "reclamation_obligation_non_current",
    label: "Reclamation and environmental obligation, non-current portion",
    fuzzy: [
      "reclamation and environmental obligation non current",
      "reclamation and environmental obligation, non-current portion",
      "reclamation obligation non current",
      "asset retirement obligation noncurrent",
      "environmental obligation non current",
    ],
  },
  {
    key: "total_non_current_liabilities",
    label: "Total Non-Current Liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "LiabilitiesNoncurrent" },
      { taxonomy: "ifrs-full", tag: "NoncurrentLiabilities" },
    ],
  },
  {
    key: "total_liabilities",
    label: "Total Liabilities",
    exactTags: [
      { taxonomy: "us-gaap", tag: "Liabilities" },
      { taxonomy: "ifrs-full", tag: "Liabilities" },
    ],
  },

  {
    key: "common_stock",
    label: "Common stock",
    exactTags: [
      { taxonomy: "us-gaap", tag: "CommonStocksIncludingAdditionalPaidInCapital" },
      { taxonomy: "us-gaap", tag: "CommonStockValue" },
      { taxonomy: "us-gaap", tag: "CommonStocksIncludingAdditionalPaidInCapitalNetOfTax" },
    ],
    fuzzy: [
      "common stock",
      "common shares",
    ],
  },
  {
    key: "additional_paid_in_capital",
    label: "Additional paid in capital",
    exactTags: [
      { taxonomy: "us-gaap", tag: "AdditionalPaidInCapital" },
      { taxonomy: "ifrs-full", tag: "SharePremium" },
    ],
    fuzzy: [
      "additional paid in capital",
      "share premium",
      "apic",
    ],
  },
  {
    key: "accumulated_deficit",
    label: "Accumulated deficit",
    exactTags: [
      { taxonomy: "us-gaap", tag: "RetainedEarningsAccumulatedDeficit" },
    ],
    fuzzy: [
      "accumulated deficit",
      "deficit",
      "retained earnings accumulated deficit",
    ],
  },
  {
    key: "total_stockholders_equity",
    label: "Total Stockholders' Equity",
    exactTags: [
      { taxonomy: "us-gaap", tag: "StockholdersEquity" },
      { taxonomy: "ifrs-full", tag: "Equity" },
    ],
    fuzzy: [
      "total stockholders equity",
      "stockholders equity",
      "shareholders equity",
      "equity",
    ],
  },
  {
    key: "total_liabilities_and_stockholders_equity",
    label: "Total Liabilities and Stockholders' Equity",
    fuzzy: [
      "total liabilities and stockholders equity",
      "total liabilities and shareholders equity",
    ],
    derivedCheck: ["total_liabilities", "total_stockholders_equity"],
  },
];

function zeroPadCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
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

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }

  return res.json();
}

function chooseBestFact(units = []) {
  if (!Array.isArray(units) || !units.length) return null;

  const annualForms = new Set(["10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"]);
  const quarterlyForms = new Set(["10-Q", "10-Q/A"]);

  const cleaned = units
    .filter((x) => x && x.val != null && (x.end || x.filed))
    .map((x) => ({
      val: x.val,
      end: x.end || null,
      start: x.start || null,
      filed: x.filed || null,
      fy: x.fy || null,
      fp: x.fp || null,
      form: x.form || null,
      frame: x.frame || null,
      unit: x.uom || x.unit || null,
    }));

  const score = (x) => {
    let s = 0;
    if (annualForms.has(x.form) || x.fp === "FY") s += 100;
    else if (quarterlyForms.has(x.form) || /^Q[1-4]$/i.test(x.fp || "")) s += 80;
    if (x.filed) s += 10;
    if (x.end) s += 10;
    return s;
  };

  cleaned.sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    const aDate = new Date(a.end || a.filed || 0).getTime();
    const bDate = new Date(b.end || b.filed || 0).getTime();
    return bDate - aDate;
  });

  return cleaned[0] || null;
}

function extractExactFact(companyFacts, taxonomy, tag) {
  const node = companyFacts?.facts?.[taxonomy]?.[tag];
  if (!node?.units) return null;

  const preferred = ["USD"];
  for (const unitKey of preferred) {
    if (node.units[unitKey]) {
      const fact = chooseBestFact(node.units[unitKey]);
      if (fact) {
        return {
          ...fact,
          taxonomy,
          tag,
          conceptLabel: node.label || tag,
        };
      }
    }
  }

  for (const unitKey of Object.keys(node.units)) {
    const fact = chooseBestFact(node.units[unitKey]);
    if (fact) {
      return {
        ...fact,
        taxonomy,
        tag,
        conceptLabel: node.label || tag,
      };
    }
  }

  return null;
}

function collectAllFacts(companyFacts) {
  const out = [];

  for (const [taxonomy, concepts] of Object.entries(companyFacts?.facts || {})) {
    for (const [tag, node] of Object.entries(concepts || {})) {
      if (!node?.units) continue;

      const label = node.label || tag;
      const conceptNorm = normalizeText(`${taxonomy} ${tag} ${label}`);

      for (const [unitKey, arr] of Object.entries(node.units)) {
        const chosen = chooseBestFact(arr);
        if (!chosen) continue;

        out.push({
          taxonomy,
          tag,
          conceptLabel: label,
          conceptNorm,
          unitKey,
          ...chosen,
        });
      }
    }
  }

  return out;
}

function fuzzyFindFact(allFacts, terms) {
  const normalizedTerms = terms.map(normalizeText);

  const candidates = allFacts.filter((fact) => {
    return normalizedTerms.some((term) => fact.conceptNorm.includes(term));
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aDate = new Date(a.end || a.filed || 0).getTime();
    const bDate = new Date(b.end || b.filed || 0).getTime();
    return bDate - aDate;
  });

  return candidates[0];
}

function addValues(a, b) {
  if (a == null && b == null) return null;
  return Number(a || 0) + Number(b || 0);
}

async function loadUniverse() {
  const raw = await readJson(UNIVERSE_FILE);
  if (Array.isArray(raw)) return raw;

  return Object.entries(raw).map(([ticker, value]) => ({
    ticker,
    ...value,
  }));
}

function getTicker(item) {
  return item.ticker || item.symbol || item.code || item.Ticker || null;
}

function getCik(item) {
  return item.cik || item.CIK || item.company_cik || null;
}

function formatFact(def, fact, source = "xbrl") {
  if (!fact) return null;

  return {
    label: def.label,
    value: fact.val,
    end: fact.end,
    start: fact.start,
    filed: fact.filed,
    form: fact.form,
    fy: fact.fy,
    fp: fact.fp,
    unit: fact.unit || fact.unitKey || null,
    taxonomy: fact.taxonomy || null,
    tag: fact.tag || null,
    conceptLabel: fact.conceptLabel || null,
    source,
  };
}

async function run() {
  const universe = await loadUniverse();
  const results = [];

  for (const item of universe) {
    const ticker = getTicker(item);
    const cik = getCik(item);

    if (!ticker || !cik) {
      console.warn("Skipping missing ticker/cik:", item);
      continue;
    }

    const cik10 = zeroPadCik(cik);
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;

    console.log(`Fetching ${ticker} (${cik10})`);

    try {
      const companyFacts = await fetchJson(url);
      const allFacts = collectAllFacts(companyFacts);
      const extracted = {};

      for (const def of FIELD_DEFS) {
        let found = null;

        if (def.exactTags) {
          for (const ref of def.exactTags) {
            found = extractExactFact(companyFacts, ref.taxonomy, ref.tag);
            if (found) {
              extracted[def.key] = formatFact(def, found, "exact_xbrl");
              break;
            }
          }
        }

        if (!extracted[def.key] && def.fuzzy) {
          found = fuzzyFindFact(allFacts, def.fuzzy);
          if (found) {
            extracted[def.key] = formatFact(def, found, "fuzzy_xbrl");
          }
        }
      }

      // Derived values where direct fact missing
      if (!extracted.non_current_assets) {
        const mp = extracted.mineral_properties?.value ?? null;
        const rb = extracted.reclamation_bonds?.value ?? null;
        const ppe = extracted.property_and_equipment?.value ?? null;
        const total = [mp, rb, ppe].every((v) => v == null)
          ? null
          : addValues(addValues(mp, rb), ppe);

        if (total != null) {
          extracted.non_current_assets = {
            label: "Non-Current Assets",
            value: total,
            source: "derived",
          };
        }
      }

      if (!extracted.total_liabilities_and_stockholders_equity) {
        const tl = extracted.total_liabilities?.value ?? null;
        const te = extracted.total_stockholders_equity?.value ?? null;
        const total = tl != null && te != null ? tl + te : null;

        if (total != null) {
          extracted.total_liabilities_and_stockholders_equity = {
            label: "Total Liabilities and Stockholders' Equity",
            value: total,
            source: "derived",
          };
        }
      }

      results.push({
        ticker,
        cik: cik10,
        entityName: companyFacts.entityName || ticker,
        extractedAt: new Date().toISOString(),
        balanceSheet: extracted,
      });
    } catch (err) {
      console.error(`Failed for ${ticker}: ${err.message}`);
      results.push({
        ticker,
        cik: cik10,
        error: err.message,
      });
    }
  }

  await writeJson(OUTPUT_FILE, results);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
