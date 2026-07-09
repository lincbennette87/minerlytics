#!/usr/bin/env python3
"""Build a deterministic company homepage dataset for CI workflows.

This script intentionally avoids live search calls. GitHub-hosted runners can be
blocked or rate-limited by search engines, so the workflow should still produce
a useful artifact from the Minerlytics universe and curated homepage mappings.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_UNIVERSE_PATH = ROOT / "data" / "universe.json"
DEFAULT_OUTPUT_PATH = ROOT / "public" / "data" / "company_homepages.json"

CURATED_HOMEPAGES = {
    "AEM": "https://www.agnicoeagle.com/",
    "AG": "https://www.firstmajestic.com/",
    "AGI": "https://www.alamosgold.com/",
    "ALB": "https://www.albemarle.com/",
    "ANFGF": "https://www.antofagasta.co.uk/",
    "AU": "https://www.anglogoldashanti.com/",
    "AYASF": "https://ayagoldsilver.com/",
    "BHP": "https://www.bhp.com/",
    "BTG": "https://www.b2gold.com/",
    "CCJ": "https://www.cameco.com/",
    "CDE": "https://www.coeur.com/",
    "CGAU": "https://www.centerragold.com/",
    "COPX": "https://www.globalxetfs.com/funds/copx/",
    "CPG": "https://www.centamin.com/",
    "CSFFF": "https://capstonecopper.com/",
    "DNN": "https://www.denisonmines.com/",
    "DRD": "https://www.drdgold.com/",
    "DSVSF": "https://discoverysilver.com/",
    "EDVMF": "https://www.endeavourmining.com/",
    "EGO": "https://www.eldoradogold.com/",
    "EQX": "https://www.equinoxgold.com/",
    "EXK": "https://edrsilver.com/",
    "FCX": "https://fcx.com/",
    "FNV": "https://www.franco-nevada.com/",
    "FQVLF": "https://www.first-quantum.com/",
    "FSM": "https://fortunamining.com/",
    "GATO": "https://gatossilver.com/",
    "GAYMF": "https://www.galianogold.com/",
    "GDX": "https://www.vaneck.com/us/en/investments/gold-miners-etf-gdx/",
    "GDXJ": "https://www.vaneck.com/us/en/investments/junior-gold-miners-etf-gdxj/",
    "GFI": "https://www.goldfields.com/",
    "GLDG": "https://www.goldmining.com/",
    "GLNCY": "https://www.glencore.com/",
    "GOLD": "https://www.barrick.com/",
    "HL": "https://www.hecla.com/",
    "HBM": "https://hudbayminerals.com/",
    "HMY": "https://www.harmony.co.za/",
    "HYMC": "https://hycroftmining.com/",
    "IAG": "https://www.iamgold.com/",
    "IMPUY": "https://www.implats.co.za/",
    "IVPAF": "https://ivanhoemines.com/",
    "KGC": "https://www.kinross.com/",
    "LAC": "https://www.lithiumamericas.com/",
    "LAAC": "https://www.lithium-argentina.com/",
    "LAR": "https://www.lithium-argentina.com/",
    "LUCRF": "https://lucaradiamond.com/",
    "LUC": "https://lucaradiamond.com/",
    "LUG": "https://lundingold.com/",
    "LUNMF": "https://lundinmining.com/",
    "LYSCF": "https://lynasrareearths.com/",
    "MAG": "https://magsilver.com/",
    "MO": "https://themacoresource.com/",
    "MP": "https://mpmaterials.com/",
    "MPVDF": "https://www.mountainprovince.com/",
    "MUX": "https://www.mcewenmining.com/",
    "NEM": "https://www.newmont.com/",
    "NGD": "https://www.newgold.com/",
    "NGLOY": "https://www.angloamerican.com/",
    "NG": "https://www.novagold.com/",
    "NXE": "https://www.nexgenenergy.ca/",
    "OR": "https://osiskogr.com/",
    "ORLA": "https://orlamining.com/",
    "PAAS": "https://www.panamericansilver.com/",
    "PALAF": "https://www.paladinenergy.com.au/",
    "PICK": "https://www.ishares.com/us/products/239655/ishares-msci-global-metals-mining-producers-etf",
    "PILBF": "https://pilbaraminerals.com.au/",
    "PSLV": "https://sprott.com/investment-strategies/physical-bullion-trusts/silver/",
    "PZG": "https://paramountnevada.com/",
    "RGLD": "https://www.royalgold.com/",
    "RIO": "https://www.riotinto.com/",
    "SAND": "https://www.sandstormgold.com/",
    "SBSW": "https://www.sibanyestillwater.com/",
    "SCCO": "https://southerncoppercorp.com/",
    "SGML": "https://www.sigmalithiumresources.com/",
    "SIL": "https://www.globalxetfs.com/funds/sil/",
    "SILJ": "https://amplifyetfs.com/silj/",
    "SILV": "https://silvercrestmetals.com/",
    "SIVR": "https://www.abrdn.com/en-us/investor/fund-centre/etf/sivr",
    "SKE": "https://skeenaresources.com/",
    "SLV": "https://www.ishares.com/us/products/239855/ishares-silver-trust-fund",
    "SQM": "https://www.sqm.com/",
    "SSRM": "https://www.ssrmining.com/",
    "SVM": "https://www.silvercorpmetals.com/",
    "TECK": "https://www.teck.com/",
    "TGB": "https://www.tasekomines.com/",
    "TMQ": "https://trilogymetals.com/",
    "TRQ": "https://www.riotinto.com/en/canada/turquoise-hill-resources",
    "UEC": "https://www.uraniumenergy.com/",
    "URNM": "https://sprottetfs.com/urnm-sprott-uranium-miners-etf/",
    "UUUU": "https://www.energyfuels.com/",
    "VALE": "https://www.vale.com/",
    "WPM": "https://www.wheatonpm.com/",
}


def load_universe(path: Path) -> dict[str, dict]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return {
            str(item.get("symbol", "")).upper(): {
                "name": item.get("name") or item.get("companyName") or item.get("symbol"),
                "metal": item.get("metal") or item.get("metalFocus") or "unknown",
                **item,
            }
            for item in data["items"]
            if item.get("symbol")
        }
    if isinstance(data, dict):
        return {str(symbol).upper(): info for symbol, info in data.items()}
    raise ValueError(f"Unsupported universe format in {path}")


def load_tickers_js_universe(path: Path) -> dict[str, dict]:
    source = path.read_text(encoding="utf-8")
    body_match = re.search(r"export\s+const\s+TICKERS\s*=\s*\{(?P<body>.*)\}\s*;?\s*$", source, re.S)
    if not body_match:
        raise ValueError(f"Could not find exported TICKERS object in {path}")
    universe: dict[str, dict] = {}
    for symbol, block in iter_ticker_blocks(body_match.group("body")):
        name = string_property(block, "name") or symbol
        universe[symbol] = {
            "symbol": symbol,
            "name": name,
            "companyName": string_property(block, "company") or name,
            "metal": string_property(block, "metal") or "unknown",
            "metalFocus": string_property(block, "metal") or "unknown",
            "type": string_property(block, "type") or None,
            "companyType": string_property(block, "type") or None,
        }
    return universe


def iter_ticker_blocks(body: str) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    index = 0
    while True:
        match = re.search(r"([A-Z0-9]+):\s*\{", body[index:])
        if not match:
            return blocks
        symbol = match.group(1)
        start = index + match.end()
        depth = 1
        cursor = start
        quote: str | None = None
        escape = False
        while cursor < len(body):
            char = body[cursor]
            if quote:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == quote:
                    quote = None
            elif char in {"'", '"'}:
                quote = char
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    blocks.append((symbol, body[start:cursor]))
                    index = cursor + 1
                    break
            cursor += 1
        else:
            raise ValueError(f"Unclosed ticker block for {symbol}")


def string_property(block: str, name: str) -> str | None:
    match = re.search(rf"\b{name}\s*:\s*(['\"])(.*?)\1", block, re.S)
    if not match:
        return None
    return bytes(match.group(2), "utf-8").decode("unicode_escape")


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme:
        url = f"https://{url}"
        parsed = urlparse(url)
    path = parsed.path if parsed.path and parsed.path != "/" else "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def homepage_domain(url: str | None) -> str | None:
    if not url:
        return None
    return urlparse(url).netloc.removeprefix("www.")


def build_rows(universe: dict[str, dict], symbols: list[str], *, all_miners: bool, limit: int | None) -> list[dict]:
    selected = sorted(universe) if all_miners or not symbols else [symbol.upper() for symbol in symbols]
    if limit:
        selected = selected[:limit]

    generated_at = datetime.now(timezone.utc).isoformat()
    rows = []
    for symbol in selected:
        info = universe.get(symbol)
        if not info:
            rows.append(
                {
                    "symbol": symbol,
                    "status": "not_in_universe",
                    "homepage_url": None,
                    "homepage_domain": None,
                    "confidence": 0,
                    "generated_at": generated_at,
                }
            )
            continue

        url = CURATED_HOMEPAGES.get(symbol)
        normalized_url = normalize_url(url) if url else None
        name = info.get("name") or info.get("companyName") or symbol
        metal = info.get("metal") or info.get("metalFocus") or "unknown"
        status = "found" if normalized_url else "not_found"
        rows.append(
            {
                "symbol": symbol,
                "company_name": name,
                "name": name,
                "short_name": name,
                "metal": metal,
                "company_type": info.get("companyType") or info.get("type") or None,
                "homepage_url": normalized_url,
                "matched_domain": homepage_domain(normalized_url),
                "homepage_domain": homepage_domain(normalized_url),
                "confidence": 0.98 if normalized_url else 0,
                "status": status,
                "match_method": "curated" if normalized_url else "missing_curated_url",
                "source": "curated_minerlytics_homepage_map" if normalized_url else "minerlytics_universe",
                "source_title": f"{name} official homepage" if normalized_url else None,
                "source_snippet": "Curated Minerlytics homepage URL." if normalized_url else None,
                "search_query": f"{name} official homepage",
                "search_provider": "curated_minerlytics_homepage_map",
                "error_message": None if normalized_url else "No curated homepage URL available.",
                "checked_at": generated_at,
                "generated_at": generated_at,
            }
        )
    return rows


def sql_value(value) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def write_d1_sql(path: Path, rows: list[dict], *, schema_path: Path) -> None:
    columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "matched_domain",
        "search_query",
        "search_provider",
        "source_title",
        "source_snippet",
        "confidence",
        "status",
        "error_message",
        "checked_at",
    ]
    statements = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())
    for row in rows:
        values = ", ".join(sql_value(row.get(column)) for column in columns)
        assignments = ",\n    ".join(
            f"{column} = excluded.{column}"
            for column in columns
            if column != "symbol"
        )
        statements.append(
            f"""INSERT INTO company_homepages ({", ".join(columns)}, created_at, updated_at)
VALUES ({values}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(symbol) DO UPDATE SET
    {assignments},
    updated_at = CURRENT_TIMESTAMP;"""
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(statements).strip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build company homepage coverage from the Minerlytics universe.")
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols, for example AEM NEM CDE")
    parser.add_argument("--all-miners", action="store_true", help="Process every ticker in data/universe.json")
    parser.add_argument("--universe", default=str(DEFAULT_UNIVERSE_PATH), help="Path to universe JSON")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_PATH), help="Output JSON path")
    parser.add_argument("--output-json", help="Legacy-compatible JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL upsert output path")
    parser.add_argument("--schema-sql", default="d1_company_homepages.sql", help="Schema SQL to prepend to --output-sql")
    parser.add_argument("--limit", type=int, help="Limit number of symbols processed")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without writing output")
    parser.add_argument("--parse-only", action="store_true", help="Only parse universe data and report companies")
    parser.add_argument("--force", action="store_true", help="Accepted for workflow compatibility")
    parser.add_argument("--delay", type=float, default=0, help="Accepted for workflow compatibility")
    parser.add_argument("--db-path", help="Accepted for legacy workflow compatibility")
    parser.add_argument("--tickers-js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--debug-results", action="store_true", help="Accepted for legacy workflow compatibility")
    parser.add_argument("--user-agent", help="Accepted for legacy workflow compatibility")
    args = parser.parse_args()

    universe = load_tickers_js_universe(Path(args.tickers_js)) if args.tickers_js else load_universe(Path(args.universe))
    rows = build_rows(universe, args.symbols, all_miners=args.all_miners, limit=args.limit)
    found_count = sum(1 for row in rows if row["status"] == "found")

    if args.parse_only:
        source_path = args.tickers_js or args.universe
        print(f"Parsed {len(universe)} companies from {source_path}")
        for row in rows:
            print(json.dumps(row, separators=(",", ":")))
        return 0

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "scripts/sync_company_homepages.py",
        "total": len(rows),
        "found": found_count,
        "missing": len(rows) - found_count,
        "items": rows,
    }

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    output_path = Path(args.output_json or args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} company homepage rows to {output_path}")
    if args.output_sql:
        write_d1_sql(Path(args.output_sql), rows, schema_path=Path(args.schema_sql))
        print(f"Wrote D1 company homepage SQL to {args.output_sql}")
    print(f"Curated homepage matches: {found_count}; missing curated URLs: {len(rows) - found_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
