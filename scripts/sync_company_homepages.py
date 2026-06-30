#!/usr/bin/env python3
"""Build a deterministic company homepage dataset for CI workflows.

This script intentionally avoids live search calls. GitHub-hosted runners can be
blocked or rate-limited by search engines, so the workflow should still produce
a useful artifact from the Minerlytics universe and curated homepage mappings.
"""

from __future__ import annotations

import argparse
import json
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
    "AU": "https://www.anglogoldashanti.com/",
    "AYASF": "https://ayagoldsilver.com/",
    "BHP": "https://www.bhp.com/",
    "BTG": "https://www.b2gold.com/",
    "CCJ": "https://www.cameco.com/",
    "CDE": "https://www.coeur.com/",
    "CGAU": "https://www.centerragold.com/",
    "DNN": "https://www.denisonmines.com/",
    "DRD": "https://www.drdgold.com/",
    "EGO": "https://www.eldoradogold.com/",
    "EQX": "https://www.equinoxgold.com/",
    "FCX": "https://fcx.com/",
    "FSM": "https://fortunamining.com/",
    "GFI": "https://www.goldfields.com/",
    "GLDG": "https://www.goldmining.com/",
    "HL": "https://www.hecla.com/",
    "HYMC": "https://hycroftmining.com/",
    "IAG": "https://www.iamgold.com/",
    "KGC": "https://www.kinross.com/",
    "LAC": "https://www.lithiumamericas.com/",
    "LAR": "https://www.lithium-argentina.com/",
    "LUC": "https://lucaradiamond.com/",
    "MO": "https://themacoresource.com/",
    "MP": "https://mpmaterials.com/",
    "MUX": "https://www.mcewenmining.com/",
    "NEM": "https://www.newmont.com/",
    "NG": "https://www.novagold.com/",
    "PAAS": "https://www.panamericansilver.com/",
    "PZG": "https://paramountnevada.com/",
    "RIO": "https://www.riotinto.com/",
    "SBSW": "https://www.sibanyestillwater.com/",
    "SCCO": "https://southerncoppercorp.com/",
    "SKE": "https://skeenaresources.com/",
    "SSRM": "https://www.ssrmining.com/",
    "TMQ": "https://trilogymetals.com/",
    "UEC": "https://www.uraniumenergy.com/",
    "UUUU": "https://www.energyfuels.com/",
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
    parser.add_argument("--tickers-js", help="Accepted for legacy workflow compatibility")
    parser.add_argument("--debug-results", action="store_true", help="Accepted for legacy workflow compatibility")
    parser.add_argument("--user-agent", help="Accepted for legacy workflow compatibility")
    args = parser.parse_args()

    universe = load_universe(Path(args.universe))
    rows = build_rows(universe, args.symbols, all_miners=args.all_miners, limit=args.limit)
    found_count = sum(1 for row in rows if row["status"] == "found")

    if args.parse_only:
        print(f"Parsed {len(universe)} companies from {args.universe}")
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
