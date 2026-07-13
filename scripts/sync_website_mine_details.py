#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import ssl
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

try:
    from sync_company_homepages import CURATED_HOMEPAGES as CURATED_COMPANY_HOMEPAGES
except Exception:
    CURATED_COMPANY_HOMEPAGES = {}


DEFAULT_USER_AGENT = "Minerlytics/0.3 website-mine-details"
CURATED_HOMEPAGES = {
    **CURATED_COMPANY_HOMEPAGES,
    "AG": "https://www.firstmajestic.com/",
    "ARIS": "https://aris-mining.com/",
    "B": "https://www.barrick.com/",
    "CDE": "https://www.coeur.com/",
    "DSVSF": "https://dsvmining.com/",
    "FNV": "https://www.franco-nevada.com/",
    "GFI": "https://www.goldfields.com/",
    "HYMC": "https://hycroftmining.com/",
    "IAUX": "https://www.i80gold.com/",
    "MAG": "https://magsilver.com/",
    "PALAF": "https://www.paladinenergy.com/",
    "PZG": "https://paramountnevada.com/",
    "SKE": "https://skeenagoldsilver.com/",
    "WPM": "https://www.wheatonpm.com/",
}
KNOWN_PORTFOLIO_PATHS = {
    "DSVSF": [
        "/English/operations/cordero-project-minera-titan/default.aspx",
        "/English/operations/porcupine-operations/default.aspx",
        "/English/operations/kidd-operations/default.aspx",
    ],
    "HYMC": [
        "/hycroft-mine/overview/",
    ],
    "HBM": [
        "/peru/default.aspx",
        "/canada/default.aspx",
        "/united-states/default.aspx",
    ],
    "IAUX": [
        "/granite-creek-underground/",
        "/ruby-hill-complex-archimedes-underground/",
        "/cove-2/",
        "/granite-creek/",
        "/ruby-hill/",
        "/lone-tree/",
        "/fad-project/",
    ],
    "PZG": [
        "/PageBuilder/Grassy-Mountain-Gold",
        "/PageBuilder/Sleeper-Gold-Project",
        "/PageBuilder/Bald-Peak",
        "/PageBuilder/Non-core-Assets",
    ],
    "LAC": [
        "/thacker-pass/overview/default.aspx",
    ],
    "MP": [
        "/",
    ],
    "PALAF": [
        "/langer-heinrich-mine/",
        "/pls/",
        "/michelin-preliminary-economic-assessment/",
    ],
    "SKE": [
        "/eskay-creek/",
        "/eskay-creek/technical-details/",
        "/eskay-creek/snip-deposit/",
    ],
    "GFI": [
        "/australia-operations.php",
        "/canada-operations.php",
        "/chile-operations.php",
        "/ghana-operations.php",
        "/peru-operations.php",
        "/south-africa-operations.php",
    ],
    "THM": [
        "/projects/livengood-gold-project/",
    ],
    "TMQ": [
        "/properties/arctic/",
    ],
    "VGZ": [
        "/mt-todd/",
    ],
    "VZLA": [
        "/panuco-project/",
    ],
}
KNOWN_PORTFOLIO_LANDING_PATHS = {
    "AG": [
        "/operations/",
    ],
    "ARIS": [
        "/operations/",
    ],
    "AUGO": [
        "/en/operations/",
        "/operacoes/",
    ],
    "B": [
        "/English/operations/default.aspx",
    ],
    "CDE": [
        "/operations/default.aspx",
    ],
    "DC": [
        "/projects/",
    ],
    "DRD": [
        "/our-business/",
    ],
    "EQX": [
        "/operations/",
    ],
    "FNV": [
        "/assets/portfolio/",
        "/our-assets/",
    ],
    "GFI": [
        "/where-we-operate/",
    ],
    "HL": [
        "/operations/",
    ],
    "HMY": [
        "/where-we-operate/",
        "/operations/",
    ],
    "IDR": [
        "/projects/",
    ],
    "WPM": [
        "/portfolio/portfolio-overview/default.aspx",
    ],
}
COMMON_PORTFOLIO_LANDING_PATHS = [
    "/operations/",
    "/operations/default.aspx",
    "/portfolio/",
    "/portfolio/default.aspx",
    "/projects/",
    "/projects/default.aspx",
    "/assets/",
    "/assets/default.aspx",
    "/properties/",
    "/mines/",
    "/exploration/",
    "/development-projects/",
    "/our-assets/",
    "/our-business/",
    "/where-we-operate/",
]
CURATED_HOST_ALIASES = {
    "arismining.com": ["aris-mining.com", "www.aris-mining.com"],
    "auraminerals.com": ["www.auraminerals.com"],
    "barrickmining.com": ["barrick.com", "www.barrick.com"],
    "coeurmining.com": ["coeur.com", "www.coeur.com"],
    "franconevada.com": ["franco-nevada.com", "www.franco-nevada.com"],
    "magsilver.com": ["www.magsilver.com"],
    "wheatonpreciousmetals.com": ["wheatonpm.com", "www.wheatonpm.com"],
}
PROJECT_LINK_HINTS = [
    "granite-creek-underground",
    "ruby-hill-complex-archimedes-underground",
    "cove-2",
    "granite-creek",
    "ruby-hill",
    "lone-tree",
    "fad-project",
    "grassy-mountain-gold",
    "sleeper-gold-project",
    "bald-peak",
    "non-core-assets",
    "project",
    "projects",
    "property",
    "properties",
    "portfolio",
    "operations",
    "assets",
    "mines",
    "mine",
    "development",
    "exploration",
    "gold",
    "silver",
]
PROJECT_LANDING_HINTS = [
    "projects",
    "properties",
    "portfolio",
    "operations",
    "assets",
    "mines",
    "exploration",
    "development",
]
RESILIENT_PROJECT_CONTEXT_TERMS = [
    "project",
    "projects",
    "property",
    "properties",
    "mine",
    "mines",
    "portfolio",
    "operations",
    "development",
    "exploration",
    "ownership",
    "location",
    "mineral resources",
    "measured and indicated",
    "inferred",
    "geology",
    "technical report",
]
PROJECT_NEGATIVE_HINTS = [
    "about",
    "careers",
    "contact",
    "disclaimer",
    "governance",
    "investor",
    "media",
    "media-insights",
    "media-releases",
    "news",
    "photos",
    "privacy",
    "reserves-resources",
    "sedar",
    "sec-filings",
    "supplier",
    "stock",
    "team",
    "technical-report",
    "technical-report-summaries",
]
FIELD_LABELS = [
    "OWNERSHIP",
    "LOCATION",
    "STATUS",
    "M&I MINERAL RESOURCES",
    "MEASURED & INDICATED MINERAL RESOURCES",
    "INDICATED MINERAL RESOURCES",
    "INFERRED MINERAL RESOURCES",
    "MINING STYLE",
    "NEXT UPDATE",
    "RECENT UPDATE",
    "TECHNICAL REPORTS",
    "GEOLOGY",
]
RESOURCE_VALUE_TERMS = [
    "oz",
    "koz",
    "moz",
    "ounces",
    "tonnes",
    "tons",
    "kt",
    "mt",
    "g/t",
    "gram",
    "%",
    "au",
    "ag",
    "cu",
    "lb",
    "lbs",
    "mlb",
    "pb",
    "zn",
    "u3o8",
    "nio",
    "ree",
]
RESOURCE_BOUNDARY_LABELS = [
    "Proven",
    "Probable",
    "Measured",
    "Measured & Indicated",
    "Measured and Indicated",
    "M&I",
    "Indicated",
    "Inferred",
    "Mineral Reserves",
    "Mineral Reserve",
    "Mineral Resources",
    "Mineral Resource",
    "Resources",
    "Reserves",
    "Geology",
    "Technical Reports",
    "Technical Report",
    "Documents and Downloads",
    "Documents",
    "Quick Links",
    "Stay informed",
    "Subscribe",
    "News",
    "Project Background",
    "Highlights",
    "Initial Assessment",
    "Feasibility Study",
    "Permitting",
    "Permitting Status",
    "Development Strategy",
    "Exploration Upside",
    "Ownership",
    "Location",
    "Status",
    "Mining Style",
    "Mine Type",
    "Production",
    "Guidance",
    "Contact",
]
NON_OPERATING_COMPANY_TYPES = {"etf", "fund", "trust"}


@dataclass(frozen=True)
class Link:
    url: str
    text: str


@dataclass(frozen=True)
class Company:
    symbol: str
    company_name: str
    short_name: str
    metal: str
    company_type: str


@dataclass(frozen=True)
class ProjectPortfolioRow:
    project_name: str
    project_url: str
    description_text: str
    ownership: str
    location: str
    status: str
    mining_style: str
    measured_indicated_mineral_resources: str
    inferred_mineral_resources: str
    geology_text: str
    technical_report_names: list[str]
    technical_report_urls: list[str]


@dataclass(frozen=True)
class EnrichedProjectPortfolioRow:
    project: ProjectPortfolioRow
    source_url: str
    page_title: str
    retrieved_at: str
    evidence_text: str
    confidence: float
    extraction_layer: str


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[Link] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self._href = href
                self._text = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href:
            self.links.append(Link(self._href, clean_text(" ".join(self._text))))
            self._href = None
            self._text = []


class TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg", "form", "button", "nav", "footer"}:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in {"h1", "h2", "h3", "p", "div", "li", "section", "article", "table", "tr", "th", "td", "br"} and not self._skip_depth:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg", "form", "button", "nav", "footer"} and self._skip_depth:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = clean_text(data)
        if not text:
            return
        if self._in_title:
            self.title = clean_text(f"{self.title} {text}")
        else:
            self.parts.append(text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract mine/project details from company websites and emit Cloudflare D1 SQL."
    )
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols to process")
    parser.add_argument("--symbol", help="Single ticker symbol to process")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--homepages-json", help="JSON output from scripts/sync_company_homepages.py")
    parser.add_argument("--output-json", help="Optional JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL output path")
    parser.add_argument("--schema-sql", default="d1_website_mine_details.sql", help="Schema SQL to prepend")
    parser.add_argument("--limit", type=int, help="Limit number of companies processed")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between companies")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout in seconds")
    parser.add_argument("--homepage-url", help="Override homepage URL for a single-symbol run")
    parser.add_argument(
        "--mode",
        choices=["combined", "legacy", "resilient"],
        default="combined",
        help="Extraction strategy. combined tries known project parsers first, then resilient extraction.",
    )
    parser.add_argument("--min-confidence", type=float, default=0.55, help="Minimum confidence for resilient project rows")
    parser.add_argument("--parse-only", action="store_true", help="Only parse the ticker universe and report companies")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without writing output files")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent")
    args = parser.parse_args()

    symbols = list(args.symbols)
    if args.symbol:
        symbols.append(args.symbol)

    homepage_rows = load_homepage_rows(Path(args.homepages_json)) if args.homepages_json else {}
    tickers_path = Path(args.tickers_js)
    if tickers_path.exists():
        companies = load_ticker_universe(tickers_path)
    elif homepage_rows:
        companies = companies_from_homepage_rows(homepage_rows)
    else:
        raise SystemExit(f"Ticker universe not found at {tickers_path}")

    companies = filter_companies(companies, symbols=symbols, limit=args.limit)
    if not companies:
        raise SystemExit("No companies matched the requested symbols.")

    if args.parse_only:
        source = str(tickers_path) if tickers_path.exists() else str(args.homepages_json)
        print(f"Parsed {len(companies)} companies from {source}")
        for company in companies:
            print(json.dumps(company.__dict__, separators=(",", ":")))
        return 0

    mine_rows: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []
    found = not_found = failed = total_projects = 0

    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)
        homepage_url = choose_homepage(company, homepage_rows, args.homepage_url if len(companies) == 1 else None)
        if is_non_operating_vehicle(company):
            row = status_row(company, homepage_url or "", "not_found", "Ticker is a fund, ETF, or trust rather than an operating mine owner.")
            mine_rows.append(row)
            statuses.append(status_for_row(row, 0))
            not_found += 1
            print(json.dumps(statuses[-1], separators=(",", ":")), flush=True)
            continue
        try:
            if not homepage_url:
                row = status_row(company, "", "not_found", "No homepage URL available")
                mine_rows.append(row)
                statuses.append(status_for_row(row, 0))
                not_found += 1
                print(json.dumps(statuses[-1], separators=(",", ":")), flush=True)
                continue

            rows: list[ProjectPortfolioRow] = []
            enriched_rows: list[EnrichedProjectPortfolioRow] = []
            if args.mode in {"combined", "legacy"}:
                rows = extract_company_portfolio(company.symbol, homepage_url, timeout=args.timeout, user_agent=args.user_agent)
            if not rows and args.mode in {"combined", "resilient"}:
                enriched_rows = extract_company_portfolio_resilient(
                    company.symbol,
                    homepage_url,
                    timeout=args.timeout,
                    user_agent=args.user_agent,
                    min_confidence=args.min_confidence,
                )
                rows = [row.project for row in enriched_rows]

            if not rows:
                row = status_row(company, homepage_url, "not_found", "No mine or project pages found")
                mine_rows.append(row)
                statuses.append(status_for_row(row, 0))
                not_found += 1
                print(json.dumps(statuses[-1], separators=(",", ":")), flush=True)
                continue

            if enriched_rows:
                company_rows = [row_for_enriched_project(company, homepage_url, enriched) for enriched in enriched_rows]
            else:
                company_rows = [row_for_project(company, homepage_url, row) for row in rows]
            mine_rows.extend(company_rows)
            total_projects += len(company_rows)
            found += 1
            statuses.append(status_for_row(company_rows[0], len(company_rows)))
            print(json.dumps(statuses[-1], separators=(",", ":")), flush=True)
        except Exception as exc:
            row = status_row(company, homepage_url or "", "failed", str(exc))
            mine_rows.append(row)
            statuses.append(status_for_row(row, 0))
            failed += 1
            print(json.dumps(statuses[-1], separators=(",", ":")), flush=True)

    payload = {
        "generated_at": datetime.now(UTC).isoformat(),
        "source": "scripts/sync_website_mine_details.py",
        "statuses": statuses,
        "mine_rows": mine_rows,
    }

    if args.dry_run:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    if args.output_json:
        write_json(Path(args.output_json), payload)
    if args.output_sql:
        write_d1_sql(Path(args.output_sql), mine_rows, schema_path=Path(args.schema_sql))

    print(
        "Summary: "
        f"companies_found={found} not_found={not_found} failed={failed} "
        f"mine_detail_rows={total_projects}",
        flush=True,
    )
    return 0


def load_ticker_universe(path: Path) -> list[Company]:
    source = path.read_text(encoding="utf-8")
    body_match = re.search(r"export\s+const\s+TICKERS\s*=\s*\{(?P<body>.*)\}\s*;?\s*$", source, re.S)
    if not body_match:
        raise ValueError(f"Could not find exported TICKERS object in {path}")
    companies: list[Company] = []
    for symbol, block in iter_ticker_blocks(body_match.group("body")):
        companies.append(
            Company(
                symbol=normalize_symbol(symbol),
                company_name=string_property(block, "company") or string_property(block, "name") or symbol,
                short_name=string_property(block, "name") or symbol,
                metal=string_property(block, "metal") or "",
                company_type=string_property(block, "type") or "",
            )
        )
    return companies


def iter_ticker_blocks(body: str) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    index = 0
    while True:
        match = re.search(r"(?:(['\"])([A-Z0-9.:-]+)\1|([A-Z][A-Z0-9.:-]*))\s*:\s*\{", body[index:])
        if not match:
            return blocks
        symbol = match.group(2) or match.group(3)
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
            elif char in {"'", '"', "`"}:
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


def load_homepage_rows(path: Path) -> dict[str, dict[str, Any]]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(rows, dict) and "items" in rows:
        rows = rows["items"]
    if isinstance(rows, dict) and "profiles" in rows:
        rows = rows["profiles"]
    if not isinstance(rows, list):
        raise ValueError(f"Unsupported homepage JSON format in {path}")
    return {
        normalize_symbol(row.get("symbol", "")): row
        for row in rows
        if row.get("symbol")
    }


def companies_from_homepage_rows(rows: dict[str, dict[str, Any]]) -> list[Company]:
    companies: list[Company] = []
    for symbol, row in sorted(rows.items()):
        name = row.get("company_name") or row.get("name") or row.get("short_name") or symbol
        companies.append(
            Company(
                symbol=symbol,
                company_name=name,
                short_name=row.get("short_name") or row.get("name") or name,
                metal=row.get("metal") or "",
                company_type=row.get("company_type") or row.get("type") or "",
            )
        )
    return companies


def filter_companies(companies: list[Company], *, symbols: list[str], limit: int | None) -> list[Company]:
    if symbols:
        wanted = {normalize_symbol(symbol) for symbol in symbols if symbol.strip()}
        companies = [company for company in companies if company.symbol in wanted]
    companies = sorted(companies, key=lambda company: company.symbol)
    return companies[:limit] if limit else companies


def choose_homepage(company: Company, homepage_rows: dict[str, dict[str, Any]], override: str | None) -> str | None:
    if override:
        return override
    if company.symbol in CURATED_HOMEPAGES:
        return CURATED_HOMEPAGES[company.symbol]
    row = homepage_rows.get(company.symbol) or {}
    homepage_url = row.get("homepage_url") if row.get("status") in {None, "", "found"} else None
    return homepage_url


def is_non_operating_vehicle(company: Company) -> bool:
    company_type = str(company.company_type or "").strip().lower()
    return company_type in NON_OPERATING_COMPANY_TYPES


def normalize_symbol(value: Any) -> str:
    symbol = str(value or "").strip().upper()
    return "IAUX" if symbol == "AIUX" else symbol


def row_for_project(
    company: Company,
    homepage_url: str,
    project: ProjectPortfolioRow,
    *,
    source_url: str | None = None,
    page_title: str = "",
    retrieved_at: str | None = None,
    evidence_text: str = "",
    confidence: float | None = None,
    extraction_layer: str = "website_project_portfolio_page",
    raw_json: str = "",
) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    full_text = " ".join(
        value
        for value in [
            project.description_text,
            project.location,
            project.status,
            project.mining_style,
            project.measured_indicated_mineral_resources,
            project.inferred_mineral_resources,
            project.geology_text,
        ]
        if value
    )
    if confidence is None:
        confidence = round(project_confidence(project, full_text, extraction_layer), 3)
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": homepage_url,
        "mine_name": project.project_name,
        "project_name": project.project_name,
        "project_url": project.project_url,
        "source_url": source_url or project.project_url,
        "page_title": page_title,
        "retrieved_at": retrieved_at or now,
        "description_text": project.description_text,
        "ownership": project.ownership,
        "location": project.location,
        "status": project.status,
        "mining_style": project.mining_style,
        "measured_indicated_mineral_resources": project.measured_indicated_mineral_resources,
        "inferred_mineral_resources": project.inferred_mineral_resources,
        "geology_text": project.geology_text,
        "technical_report_names_json": json.dumps(project.technical_report_names, ensure_ascii=False),
        "technical_report_urls_json": json.dumps(project.technical_report_urls, ensure_ascii=False),
        "evidence_text": evidence_text or trim_text(full_text, 1800),
        "confidence": confidence,
        "extraction_method": "website_mine_details",
        "extraction_layer": extraction_layer,
        "raw_json": raw_json or json.dumps({"project": asdict(project)}, ensure_ascii=False, sort_keys=True),
        "status_code": "found",
        "error_message": None,
        "checked_at": now,
        "created_at": now,
    }


def row_for_enriched_project(company: Company, homepage_url: str, enriched: EnrichedProjectPortfolioRow) -> dict[str, Any]:
    return row_for_project(
        company,
        homepage_url,
        enriched.project,
        source_url=enriched.source_url,
        page_title=enriched.page_title,
        retrieved_at=enriched.retrieved_at,
        evidence_text=enriched.evidence_text,
        confidence=enriched.confidence,
        extraction_layer=f"resilient_{enriched.extraction_layer}",
        raw_json=json.dumps(asdict(enriched), ensure_ascii=False, sort_keys=True),
    )


def status_row(company: Company, homepage_url: str, status_code: str, error_message: str) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": homepage_url,
        "mine_name": "",
        "project_name": "",
        "project_url": homepage_url,
        "source_url": homepage_url or f"missing-homepage:{company.symbol}",
        "page_title": "",
        "retrieved_at": now,
        "description_text": "",
        "ownership": "",
        "location": "",
        "status": "",
        "mining_style": "",
        "measured_indicated_mineral_resources": "",
        "inferred_mineral_resources": "",
        "geology_text": "",
        "technical_report_names_json": "[]",
        "technical_report_urls_json": "[]",
        "evidence_text": "",
        "confidence": 0,
        "extraction_method": "website_mine_details",
        "extraction_layer": "status",
        "raw_json": "",
        "status_code": status_code,
        "error_message": error_message,
        "checked_at": now,
        "created_at": now,
    }


def status_for_row(row: dict[str, Any], project_count: int) -> dict[str, Any]:
    return {
        "symbol": row["symbol"],
        "status": row["status_code"],
        "homepage_url": row.get("homepage_url") or "",
        "project_count": project_count,
        "error_message": row.get("error_message") or "",
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_d1_sql(path: Path, mine_rows: list[dict[str, Any]], *, schema_path: Path) -> None:
    statements: list[str] = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())
    symbols = sorted({str(row.get("symbol", "")).upper() for row in mine_rows if row.get("symbol")})
    if symbols:
        statements.append(f"DELETE FROM Website_mine_details WHERE symbol IN ({', '.join(sql_value(symbol) for symbol in symbols)});")

    columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "mine_name",
        "project_name",
        "project_url",
        "source_url",
        "page_title",
        "retrieved_at",
        "description_text",
        "ownership",
        "location",
        "status",
        "mining_style",
        "measured_indicated_mineral_resources",
        "inferred_mineral_resources",
        "geology_text",
        "technical_report_names_json",
        "technical_report_urls_json",
        "evidence_text",
        "confidence",
        "extraction_method",
        "extraction_layer",
        "raw_json",
        "status_code",
        "error_message",
        "checked_at",
        "created_at",
    ]
    assignments = ",\n    ".join(
        f"{column} = excluded.{column}"
        for column in columns
        if column not in {"symbol", "source_url", "project_name", "extraction_layer", "created_at"}
    )
    for row in mine_rows:
        values = ", ".join(sql_value(row.get(column)) for column in columns)
        statements.append(
            f"""INSERT INTO Website_mine_details ({", ".join(columns)}, updated_at)
VALUES ({values}, CURRENT_TIMESTAMP)
ON CONFLICT(symbol, source_url, project_name, extraction_layer) DO UPDATE SET
    {assignments},
    updated_at = CURRENT_TIMESTAMP;"""
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(statement for statement in statements if statement).strip() + "\n", encoding="utf-8")


def sql_value(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def extract_company_portfolio(symbol: str, homepage_url: str, *, timeout: float, user_agent: str) -> list[ProjectPortfolioRow]:
    homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
    project_urls = discover_project_urls(symbol, homepage_url, homepage_html, timeout=timeout, user_agent=user_agent)
    rows: list[ProjectPortfolioRow] = []
    for project_url in project_urls:
        try:
            page_html = fetch_html(project_url, timeout=timeout, user_agent=user_agent)
        except Exception:
            continue
        row = parse_project_page(symbol, project_url, page_html)
        if project_row_is_substantive(row):
            rows.append(row)
    return dedupe_project_rows(rows)


def ensure_resilient_project_schema(db: Any) -> None:
    db.executescript(
        """
        create table if not exists Website_Project_Portfolio_Extractions (
            id integer primary key autoincrement,
            symbol text not null references mining_companies(symbol),
            company_name text not null,
            project_name text not null,
            project_url text not null,
            source_url text not null,
            page_title text not null default '',
            retrieved_at text not null,
            description_text text not null default '',
            ownership text not null default '',
            location text not null default '',
            status text not null default '',
            mining_style text not null default '',
            measured_indicated_mineral_resources text not null default '',
            inferred_mineral_resources text not null default '',
            geology_text text not null default '',
            technical_report_names text not null default '[]',
            technical_report_urls text not null default '[]',
            evidence_text text not null default '',
            confidence real not null,
            extraction_layer text not null,
            raw_json text not null default '',
            status_code text not null default 'found' check (status_code in ('found', 'not_found', 'failed')),
            error_message text,
            created_at text not null,
            updated_at text not null,
            unique(symbol, source_url, project_name, extraction_layer)
        );

        create index if not exists idx_website_project_portfolio_extractions_symbol
            on Website_Project_Portfolio_Extractions(symbol, project_name, confidence);
        """
    )


def extract_company_portfolio_resilient(
    symbol: str,
    homepage_url: str,
    *,
    timeout: float,
    user_agent: str,
    min_confidence: float,
) -> list[EnrichedProjectPortfolioRow]:
    homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
    urls = discover_resilient_project_urls(symbol, homepage_url, homepage_html, timeout=timeout, user_agent=user_agent)
    rows: list[EnrichedProjectPortfolioRow] = []
    for url in urls:
        try:
            page_html = fetch_html(url, timeout=timeout, user_agent=user_agent)
        except Exception:
            continue
        rows.extend(extract_resilient_project_rows(symbol, url, page_html))
    rows = [row for row in rows if row.confidence >= min_confidence]
    return dedupe_enriched_project_rows(rows)[:30]


def discover_resilient_project_urls(
    symbol: str,
    homepage_url: str,
    homepage_html: str,
    *,
    timeout: float,
    user_agent: str,
) -> list[str]:
    urls = discover_project_urls(symbol, homepage_url, homepage_html, timeout=timeout, user_agent=user_agent)
    parser = LinkParser()
    parser.feed(homepage_html)
    landing_urls: list[str] = []
    for link in parser.links:
        absolute = normalize_url(urllib.parse.urljoin(homepage_url, link.url))
        if not same_or_alias_domain(homepage_url, absolute) or is_unwanted_project_url(absolute):
            continue
        haystack = f"{link.text} {urllib.parse.urlparse(absolute).path}".lower()
        if any(term in haystack for term in ["project", "projects", "property", "properties", "portfolio", "operations", "assets", "mine", "mines"]):
            landing_urls.append(absolute)
    for landing_url in list(dict.fromkeys(landing_urls))[:8]:
        urls.append(landing_url)
        try:
            landing_html = fetch_html(landing_url, timeout=timeout, user_agent=user_agent)
        except Exception:
            continue
        landing_parser = LinkParser()
        landing_parser.feed(landing_html)
        for link in landing_parser.links:
            absolute = normalize_url(urllib.parse.urljoin(landing_url, link.url))
            if not same_or_alias_domain(homepage_url, absolute) or is_unwanted_project_url(absolute):
                continue
            haystack = f"{link.text} {urllib.parse.urlparse(absolute).path}".lower()
            if any(term in haystack for term in ["project", "property", "mine", "deposit", "gold", "silver", "development", "exploration"]):
                urls.append(absolute)
    return list(dict.fromkeys(urls))[:35]


def extract_resilient_project_rows(symbol: str, source_url: str, page_html: str) -> list[EnrichedProjectPortfolioRow]:
    retrieved_at = datetime.now(UTC).isoformat()
    text, title = extract_text(page_html)
    rows: list[EnrichedProjectPortfolioRow] = []
    rows.extend(extract_structured_project_rows(symbol, source_url, page_html, title, retrieved_at))
    rows.extend(extract_semantic_project_rows(symbol, source_url, page_html, title, retrieved_at))
    context_row = extract_context_project_row(symbol, source_url, text, title, page_html, retrieved_at)
    if context_row:
        rows.append(context_row)
    return rows


def extract_structured_project_rows(
    symbol: str,
    source_url: str,
    page_html: str,
    page_title: str,
    retrieved_at: str,
) -> list[EnrichedProjectPortfolioRow]:
    rows: list[EnrichedProjectPortfolioRow] = []
    for script_text in re.findall(r"<script\b[^>]*>(?P<value>.*?)</script>", page_html, flags=re.I | re.S):
        for item in json_objects(script_text):
            for project in walk_project_like_objects(item):
                name = clean_text(str(project.get("name") or project.get("headline") or ""))
                description = clean_text(str(project.get("description") or project.get("about") or ""))
                if not name or len(description) < 80:
                    continue
                raw = json.dumps(project, ensure_ascii=False, sort_keys=True)
                row = make_enriched_project_row(
                    symbol=symbol,
                    source_url=source_url,
                    page_title=page_title,
                    retrieved_at=retrieved_at,
                    project_name=name,
                    description_text=description,
                    full_text=description,
                    page_html=page_html,
                    extraction_layer="structured_data",
                    raw_json=raw,
                )
                if row:
                    rows.append(row)
    return rows


def json_objects(content: str) -> list[Any]:
    content = html.unescape(content.strip())
    if not content:
        return []
    objects: list[Any] = []
    try:
        objects.append(json.loads(content))
    except Exception:
        for match in re.finditer(r"({[^{}]{30,7000}})", content, flags=re.S):
            try:
                objects.append(json.loads(match.group(1)))
            except Exception:
                continue
    return objects


def walk_project_like_objects(value: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if isinstance(value, dict):
        name = str(value.get("name") or value.get("headline") or "")
        description = str(value.get("description") or value.get("about") or "")
        haystack = f"{name} {description}".lower()
        if any(term in haystack for term in ["project", "property", "mine", "deposit", "gold", "silver", "mineral"]):
            rows.append(value)
        for nested in value.values():
            rows.extend(walk_project_like_objects(nested))
    elif isinstance(value, list):
        for item in value:
            rows.extend(walk_project_like_objects(item))
    return rows


def extract_semantic_project_rows(
    symbol: str,
    source_url: str,
    page_html: str,
    page_title: str,
    retrieved_at: str,
) -> list[EnrichedProjectPortfolioRow]:
    rows: list[EnrichedProjectPortfolioRow] = []
    for block in project_blocks(page_html):
        block_text = html_to_text(block)
        if project_context_score(block_text) < 2:
            continue
        name = project_name_from_block(block, block_text, source_url)
        description = resilient_description(block_text, name)
        row = make_enriched_project_row(
            symbol=symbol,
            source_url=source_url,
            page_title=page_title,
            retrieved_at=retrieved_at,
            project_name=name,
            description_text=description,
            full_text=block_text,
            page_html=block,
            extraction_layer="semantic_html",
        )
        if row:
            rows.append(row)
    return rows


def project_blocks(page_html: str) -> list[str]:
    blocks: list[str] = []
    for pattern in [
        r'<(?P<tag>section|article|div|li)\b(?P<attrs>[^>]*)class="[^"]*(?:project|property|portfolio|asset|operation|mine|card)[^"]*"[^>]*>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
        r'<(?P<tag>section|article|div)\b(?P<attrs>[^>]*)id="[^"]*(?:project|property|portfolio|asset|operation|mine)[^"]*"[^>]*>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
    ]:
        for match in re.finditer(pattern, page_html, flags=re.I | re.S):
            block = match.group(0)
            text = html_to_text(block)
            if 120 <= len(text) <= 9000:
                blocks.append(block)
    return list(dict.fromkeys(blocks))


def extract_context_project_row(
    symbol: str,
    source_url: str,
    text: str,
    page_title: str,
    page_html: str,
    retrieved_at: str,
) -> EnrichedProjectPortfolioRow | None:
    if project_context_score(text) < 2:
        return None
    name = project_name_from_title(page_title, source_url)
    description = resilient_description(text, name)
    return make_enriched_project_row(
        symbol=symbol,
        source_url=source_url,
        page_title=page_title,
        retrieved_at=retrieved_at,
        project_name=name,
        description_text=description,
        full_text=text,
        page_html=page_html,
        extraction_layer="context_window",
    )


def make_enriched_project_row(
    *,
    symbol: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
    project_name: str,
    description_text: str,
    full_text: str,
    page_html: str,
    extraction_layer: str,
    raw_json: str = "",
) -> EnrichedProjectPortfolioRow | None:
    project_name = clean_project_name(project_name)
    description_text = trim_text(description_text, 1800)
    full_text = remove_boilerplate(full_text)
    if not project_name or len(description_text) < 80:
        return None
    if not looks_like_project_name(project_name):
        return None
    report_links = technical_report_links(source_url, page_html)
    project = ProjectPortfolioRow(
        project_name=project_name,
        project_url=source_url,
        description_text=description_text,
        ownership=generic_field(full_text, ["Ownership", "Interest"]),
        location=generic_location(full_text),
        status=generic_status(full_text),
        mining_style=generic_mining_style(full_text),
        measured_indicated_mineral_resources=resource_value(full_text, "measured_indicated"),
        inferred_mineral_resources=resource_value(full_text, "inferred"),
        geology_text=trim_text(generic_geology(full_text), 5000),
        technical_report_names=[name for name, _url in report_links],
        technical_report_urls=[url for _name, url in report_links],
    )
    confidence = project_confidence(project, full_text, extraction_layer)
    return EnrichedProjectPortfolioRow(
        project=project,
        source_url=source_url,
        page_title=page_title,
        retrieved_at=retrieved_at,
        evidence_text=trim_text(full_text, 1800),
        confidence=round(confidence, 3),
        extraction_layer=extraction_layer,
    )


def project_name_from_block(block: str, text: str, source_url: str) -> str:
    for pattern in [
        r"<h[1-4][^>]*>(?P<value>.*?)</h[1-4]>",
        r'<[^>]+class="[^"]*(?:title|name|heading)[^"]*"[^>]*>(?P<value>.*?)</[^>]+>',
    ]:
        for match in re.finditer(pattern, block, flags=re.I | re.S):
            name = clean_project_name(html_to_text(match.group("value")))
            if looks_like_project_name(name):
                return name
    first_line = next((line for line in text.split(".") if clean_text(line)), "")
    return clean_project_name(first_line) or project_name_from_title("", source_url)


def resilient_description(text: str, project_name: str) -> str:
    text = remove_boilerplate(text)
    if project_name and project_name.lower() in text.lower():
        idx = text.lower().find(project_name.lower())
        text = text[idx + len(project_name) :]
    return trim_text(text, 1800)


def clean_project_name(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"\b(?:overview|quick facts|project highlights|technical reports|resources)\b.*", "", value, flags=re.I)
    return clean_text(value.strip(" -–|:"))


def looks_like_project_name(value: str) -> bool:
    if not value or len(value) > 110:
        return False
    if re.search(r"\b(?:home|contact|privacy|investor|news|subscribe|download|presentation)\b", value, flags=re.I):
        return False
    return bool(re.search(r"\b(?:project|property|mine|deposit|gold|silver|creek|hill|lake|mountain|complex|district|zone)\b", value, flags=re.I)) or len(value.split()) <= 5


def project_context_score(text: str) -> int:
    lowered = text.lower()
    score = sum(1 for term in RESILIENT_PROJECT_CONTEXT_TERMS if term in lowered)
    if re.search(r"\b(?:gold|silver|mineral|resource|exploration|development|production)\b", lowered):
        score += 1
    return score


def project_confidence(project: ProjectPortfolioRow, full_text: str, extraction_layer: str) -> float:
    score = 0.25
    if project.project_name:
        score += 0.15
    if len(project.description_text) >= 120:
        score += 0.15
    if project.location:
        score += 0.08
    if project.status:
        score += 0.06
    if project.measured_indicated_mineral_resources or project.inferred_mineral_resources:
        score += 0.08
    if project.geology_text:
        score += 0.05
    if project.technical_report_urls:
        score += 0.06
    if project_context_score(full_text) >= 3:
        score += 0.1
    if extraction_layer == "semantic_html":
        score += 0.08
    elif extraction_layer == "structured_data":
        score += 0.06
    return min(score, 0.98)


def dedupe_enriched_project_rows(rows: list[EnrichedProjectPortfolioRow]) -> list[EnrichedProjectPortfolioRow]:
    by_key: dict[tuple[str, str], EnrichedProjectPortfolioRow] = {}
    for row in rows:
        key = (row.project.project_name.lower(), normalize_url(row.project.project_url))
        existing = by_key.get(key)
        if not existing or row.confidence > existing.confidence:
            by_key[key] = row
    return sorted(by_key.values(), key=lambda item: (-item.confidence, item.project.project_name))


def discover_project_urls(
    symbol: str,
    homepage_url: str,
    homepage_html: str,
    *,
    timeout: float,
    user_agent: str,
) -> list[str]:
    known_urls: list[str] = []
    urls: list[str] = []
    landing_urls: list[str] = []
    for base in generated_base_urls(homepage_url):
        for path in KNOWN_PORTFOLIO_PATHS.get(symbol, []):
            known_urls.append(urllib.parse.urljoin(base, path))
        for path in KNOWN_PORTFOLIO_LANDING_PATHS.get(symbol, []):
            landing_urls.append(urllib.parse.urljoin(base, path))
        if symbol not in KNOWN_PORTFOLIO_PATHS and symbol not in KNOWN_PORTFOLIO_LANDING_PATHS:
            for path in COMMON_PORTFOLIO_LANDING_PATHS:
                landing_urls.append(urllib.parse.urljoin(base, path))

    parser = LinkParser()
    parser.feed(homepage_html)
    for link in parser.links:
        absolute = normalize_url(urllib.parse.urljoin(homepage_url, link.url))
        path = urllib.parse.urlparse(absolute).path.lower()
        if not same_or_alias_domain(homepage_url, absolute) or is_unwanted_project_url(absolute):
            continue
        if score_project_link(link, absolute) >= 80:
            urls.append(absolute)
        elif score_project_link(link, absolute, landing=True) >= 60:
            landing_urls.append(absolute)

    for landing_url in list(dict.fromkeys(landing_urls))[:5]:
        try:
            landing_html = fetch_html(landing_url, timeout=timeout, user_agent=user_agent)
        except Exception:
            continue
        landing_parser = LinkParser()
        landing_parser.feed(landing_html)
        for link in landing_parser.links:
            absolute = normalize_url(urllib.parse.urljoin(landing_url, link.url))
            if not same_or_alias_domain(homepage_url, absolute) or is_unwanted_project_url(absolute):
                continue
            if score_project_link(link, absolute) >= 55:
                urls.append(absolute)

    urls = [url for url in urls if not is_unwanted_project_url(url)]
    # Cap generic discovery so a single website cannot explode the crawl.
    return list(dict.fromkeys(known_urls + urls))[:20]


def generated_base_urls(homepage_url: str) -> list[str]:
    parsed = urllib.parse.urlparse(homepage_url)
    if not parsed.netloc:
        return []
    scheme = parsed.scheme or "https"
    host = parsed.netloc.lower()
    host_without_www = host.removeprefix("www.")
    host_variants = [host_without_www, f"www.{host_without_www}"]
    host_variants.extend(CURATED_HOST_ALIASES.get(host_without_www, []))
    if host_without_www.endswith("mining.com"):
        shortened = f"{host_without_www.removesuffix('mining.com')}.com"
        host_variants.extend([shortened, f"www.{shortened}"])
    bases: list[str] = []
    for variant in dict.fromkeys(host_variants):
        bases.append(f"{scheme}://{variant}")
        if scheme != "https":
            bases.append(f"https://{variant}")
    return list(dict.fromkeys(bases))


def same_domain(left: str, right: str) -> bool:
    return urllib.parse.urlparse(left).netloc.lower().removeprefix("www.") == urllib.parse.urlparse(right).netloc.lower().removeprefix("www.")


def same_or_alias_domain(left: str, right: str) -> bool:
    left_host = urllib.parse.urlparse(left).netloc.lower().removeprefix("www.")
    right_host = urllib.parse.urlparse(right).netloc.lower().removeprefix("www.")
    if left_host == right_host:
        return True
    aliases = {host.removeprefix("www.") for host in CURATED_HOST_ALIASES.get(left_host, [])}
    return right_host in aliases


def is_unwanted_project_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lower().strip("/")
    if not path:
        return True
    if path == "asset":
        return True
    if "portfolio-overview" in path:
        return True
    if parsed.path.lower().endswith((".pdf", ".jpg", ".jpeg", ".png", ".gif", ".zip")):
        return True
    return any(hint in path for hint in PROJECT_NEGATIVE_HINTS)


def score_project_link(link: Link, url: str, *, landing: bool = False) -> int:
    text = clean_text(link.text).lower()
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path.lower()).strip("/")
    haystack = f"{text} {path}"
    score = 0
    hints = PROJECT_LANDING_HINTS if landing else PROJECT_LINK_HINTS
    for hint in hints:
        if hint in haystack:
            score += 35 if hint in {"project", "projects", "properties", "operations", "portfolio", "assets"} else 18
    if re.search(r"\b(gold|silver|mine|deposit|project|property)\b", text):
        score += 25
    if len(path.split("/")) >= 2 and any(hint in path for hint in PROJECT_LANDING_HINTS):
        score += 20
    if any(hint in path for hint in PROJECT_NEGATIVE_HINTS):
        score -= 100
    return score


def parse_project_page(symbol: str, project_url: str, page_html: str) -> ProjectPortfolioRow:
    text, title = extract_text(page_html)
    project_name = project_name_from_title(title, project_url)
    quick_facts = text_after(text, "QUICK FACTS")
    if symbol == "PZG" or "paramountnevada.com" in urllib.parse.urlparse(project_url).netloc.lower():
        return parse_paramount_project_page(project_url, text, project_name, page_html)
    if symbol == "WPM" or "wheatonpm.com" in urllib.parse.urlparse(project_url).netloc.lower():
        return parse_wpm_project_page(project_url, text, project_name, page_html)
    description = description_from_text(text, project_name) or generic_description(text, project_name)
    ownership = field_between(quick_facts, "OWNERSHIP") or generic_field(text, ["Ownership", "Interest"])
    location = field_between(quick_facts, "LOCATION") or generic_location(text)
    status = field_between(quick_facts, "STATUS") or generic_status(text)
    mining_style = field_between(quick_facts, "MINING STYLE") or generic_mining_style(text)
    measured_indicated = (
        clean_resource_field(field_between(quick_facts, "M&I MINERAL RESOURCES"))
        or clean_resource_field(field_between(quick_facts, "MEASURED & INDICATED MINERAL RESOURCES"))
        or clean_resource_field(field_between(quick_facts, "INDICATED MINERAL RESOURCES"))
        or resource_value(text, "measured_indicated")
    )
    inferred = clean_resource_field(field_between(quick_facts, "INFERRED MINERAL RESOURCES")) or resource_value(text, "inferred")
    geology = trim_text(text_after(quick_facts, "GEOLOGY"), 5000) or generic_geology(text)
    technical_report_text = field_between(quick_facts, "TECHNICAL REPORTS")
    report_links = technical_report_links(project_url, page_html)
    report_names = [name for name, _url in report_links]
    report_urls = [url for _name, url in report_links]
    if technical_report_text and not report_names:
        report_names = split_report_names(technical_report_text)
    return ProjectPortfolioRow(
        project_name=project_name,
        project_url=project_url,
        description_text=description,
        ownership=ownership,
        location=location,
        status=status,
        mining_style=mining_style,
        measured_indicated_mineral_resources=measured_indicated,
        inferred_mineral_resources=inferred,
        geology_text=geology,
        technical_report_names=report_names,
        technical_report_urls=report_urls,
    )


def project_row_is_substantive(row: ProjectPortfolioRow) -> bool:
    if not row.project_name or not looks_like_project_name(row.project_name):
        return False
    if re.search(r"\b(?:404|error|not found|portfolio|operations|assets|projects|properties|reserves|resources|overview)\b", row.project_name, flags=re.I):
        return False
    if len(row.description_text) >= 80:
        return True
    populated_fields = sum(
        bool(value)
        for value in [
            row.location,
            row.status,
            row.mining_style,
            row.measured_indicated_mineral_resources,
            row.inferred_mineral_resources,
            row.geology_text,
        ]
    )
    return populated_fields >= 2


def dedupe_project_rows(rows: list[ProjectPortfolioRow]) -> list[ProjectPortfolioRow]:
    by_key: dict[str, ProjectPortfolioRow] = {}
    for row in rows:
        key = clean_project_name(row.project_name).lower()
        existing = by_key.get(key)
        if not existing or project_row_quality(row) > project_row_quality(existing):
            by_key[key] = row
    return sorted(by_key.values(), key=lambda row: row.project_name)


def project_row_quality(row: ProjectPortfolioRow) -> int:
    return (
        len(row.description_text)
        + 100 * bool(row.location)
        + 75 * bool(row.status)
        + 60 * bool(row.mining_style)
        + 60 * bool(row.measured_indicated_mineral_resources)
        + 60 * bool(row.inferred_mineral_resources)
        + 40 * bool(row.technical_report_urls)
        + (10 if "www." in urllib.parse.urlparse(row.project_url).netloc.lower() else 0)
    )


def parse_wpm_project_page(project_url: str, text: str, project_name: str, page_html: str) -> ProjectPortfolioRow:
    overview_idx = text.lower().find("project overview")
    facts_text = text[:overview_idx] if overview_idx >= 0 else text
    location = wpm_field_between(facts_text, "Location", ["Stream", "Royalty", "Primary Metal", "Project Overview"])
    project_name = clean_wpm_project_name(project_name, location)
    operator = wpm_field_between(facts_text, "Operator", ["Location", "Stream", "Royalty", "Primary Metal", "Project Overview"])
    stream = wpm_field_between(facts_text, "Stream", ["Primary Metal", "Project Overview"])
    royalty = wpm_field_between(facts_text, "Royalty", ["Primary Metal", "Project Overview"])
    primary_metal = wpm_field_between(facts_text, "Primary Metal", ["Project Overview"])
    overview = section_between(
        text,
        ["Project Overview"],
        ["Stream Details", "For more information", "Search query", "Connect with us", "Affiliations"],
    )
    stream_details = section_between(
        text,
        ["Stream Details"],
        ["For more information", "Search query", "Connect with us", "Affiliations"],
    )
    status = "production" if "/operating-mines/" in project_url.lower() else "development"
    metadata_parts = []
    if operator:
        metadata_parts.append(f"Operator: {operator}")
    if stream:
        metadata_parts.append(f"Stream: {stream}")
    if royalty:
        metadata_parts.append(f"Royalty: {royalty}")
    if primary_metal:
        metadata_parts.append(f"Primary metal: {primary_metal}")
    report_links = technical_report_links(project_url, page_html)
    return ProjectPortfolioRow(
        project_name=project_name,
        project_url=project_url,
        description_text=trim_text(overview, 1800),
        ownership="; ".join(metadata_parts),
        location=location,
        status=status,
        mining_style=generic_mining_style(overview),
        measured_indicated_mineral_resources="",
        inferred_mineral_resources="",
        geology_text=trim_text(generic_geology(overview) or overview, 5000),
        technical_report_names=[name for name, _url in report_links],
        technical_report_urls=[url for _name, url in report_links],
    )


def wpm_field_between(text: str, label: str, end_labels: list[str]) -> str:
    lower = text.lower()
    start = lower.find(label.lower())
    if start < 0:
        return ""
    body_start = start + len(label)
    end = len(text)
    for end_label in end_labels:
        idx = lower.find(end_label.lower(), body_start)
        if idx >= 0:
            end = min(end, idx)
    return trim_text(text[body_start:end], 300)


def clean_wpm_project_name(project_name: str, location: str) -> str:
    name = clean_text(project_name)
    if location:
        name = re.sub(rf"\s+{re.escape(location)}$", "", name, flags=re.I)
    return clean_text(name)


def parse_paramount_project_page(
    project_url: str,
    text: str,
    project_name: str,
    page_html: str,
) -> ProjectPortfolioRow:
    overview = section_between(
        text,
        ["Overview", "OVERVIEW"],
        ["PROJECT HIGHLIGHTS", "Project Highlights", "Feasibility Study", "Initial Assessment", "Technical Reports", "Resources", "General Inquires"],
    )
    if not overview and project_name.lower() in text.lower():
        overview = section_between(
            text,
            [project_name],
            ["PROJECT HIGHLIGHTS", "Project Highlights", "Feasibility Study", "Initial Assessment", "Technical Reports", "Resources", "General Inquires"],
        )
    highlights = section_between(
        text,
        ["PROJECT HIGHLIGHTS", "Project Highlights"],
        ["Feasibility Study", "Initial Assessment", "Technical Reports", "Resources", "Mineral Resources", "General Inquires"],
    )
    resources = section_between(
        text,
        ["Mineral Reserve and Mineral Resource Estimates", "Mineral Resources", "Resources"],
        ["Permitting Status", "Development Strategy", "Exploration Upside", "Geology", "Geology & MINERALIZATION", "General Inquires"],
    )
    geology = section_between(
        text,
        ["Geology & MINERALIZATION", "Geology and Mineralization", "Geology"],
        ["General Inquires", "Phone", "Head office"],
    )
    report_links = technical_report_links(project_url, page_html)
    report_names = [name for name, _url in report_links]
    report_urls = [url for _name, url in report_links]
    measured_indicated = paramount_resource(resources, "measured_indicated") or paramount_resource(text, "measured_indicated")
    inferred = paramount_resource(resources, "inferred") or paramount_resource(text, "inferred")
    return ProjectPortfolioRow(
        project_name=project_name,
        project_url=project_url,
        description_text=trim_text(overview, 1800),
        ownership=paramount_ownership(text),
        location=paramount_location(text, project_name),
        status=paramount_status(text, highlights),
        mining_style=paramount_mining_style(text),
        measured_indicated_mineral_resources=measured_indicated,
        inferred_mineral_resources=inferred,
        geology_text=trim_text(geology, 5000),
        technical_report_names=report_names,
        technical_report_urls=report_urls,
    )


def section_between(text: str, starts: list[str], ends: list[str]) -> str:
    lower = text.lower()
    start_idx = -1
    start_len = 0
    for label in starts:
        idx = lower.find(label.lower())
        if idx >= 0 and (start_idx < 0 or idx < start_idx):
            start_idx = idx
            start_len = len(label)
    if start_idx < 0:
        return ""
    body_start = start_idx + start_len
    end_idx = len(text)
    for label in ends:
        idx = lower.find(label.lower(), body_start)
        if idx >= 0:
            end_idx = min(end_idx, idx)
    return trim_text(text[body_start:end_idx], 5000)


def paramount_ownership(text: str) -> str:
    match = re.search(r"\b100%[-\s]*owned\b", text, flags=re.IGNORECASE)
    return "100% owned" if match else ""


def paramount_location(text: str, project_name: str) -> str:
    if "Non-core Assets" in project_name:
        match = re.search(r"(?:Mill Creek|claims totals).*?located in ([^.]+)\.", text, flags=re.IGNORECASE)
        if match:
            return clean_text(match.group(1))
    location_patterns = [
        r"located in ([^.]+?\b(?:Oregon|Nevada|USA|United States)[^.]*)\.",
        r"situated in ([^.]+?\b(?:Oregon|Nevada|USA|United States)[^.]*)\.",
        r"([A-Z][A-Za-z ]+,\s*(?:Oregon|Nevada),\s*USA)",
    ]
    for pattern in location_patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return clean_text(match.group(1))
    after_name = text_after(text, project_name)
    before_overview = section_between(after_name, [""], ["Overview"])
    return clean_text(before_overview)


def paramount_status(text: str, highlights: str) -> str:
    haystack = f"{highlights} {text}"
    if re.search(r"advanced-stage.*development|final stages of state permitting|Feasibility Study", haystack, re.IGNORECASE):
        return "advanced-stage development"
    if re.search(r"Initial Assessment|early-stage development|past-producing", haystack, re.IGNORECASE):
        return "development"
    if re.search(r"early-stage.*exploration|never previously been drilled", haystack, re.IGNORECASE):
        return "exploration"
    if re.search(r"not currently a material property|no current exploratory work", haystack, re.IGNORECASE):
        return "non-core exploration"
    return ""


def paramount_mining_style(text: str) -> str:
    lower = text.lower()
    styles: list[str] = []
    if "underground" in lower:
        styles.append("underground")
    if "open-pit" in lower or "open pit" in lower:
        styles.append("open-pit")
    if "heap-leach" in lower or "heap leach" in lower:
        styles.append("heap-leach")
    return ", ".join(dict.fromkeys(styles))


def paramount_resource(text: str, classification: str) -> str:
    return resource_value(text, classification, max_length=700)


def fetch_html(url: str, *, timeout: float, user_agent: str) -> str:
    errors: list[str] = []
    for candidate in fetch_url_candidates(url):
        contexts: list[ssl.SSLContext | None] = [None]
        if urllib.parse.urlparse(candidate).scheme == "https":
            contexts.append(ssl._create_unverified_context())
        for context in contexts:
            request = urllib.request.Request(
                candidate,
                headers={"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml,*/*"},
            )
            kwargs: dict[str, Any] = {}
            if context is not None:
                kwargs["context"] = context
            try:
                with urllib.request.urlopen(request, timeout=timeout, **kwargs) as response:
                    charset = response.headers.get_content_charset() or "utf-8"
                    return response.read().decode(charset, errors="replace")
            except Exception as exc:
                errors.append(f"{candidate}: {exc}")
                continue
    raise RuntimeError("; ".join(errors[-4:]) or f"Could not fetch {url}")


def fetch_url_candidates(url: str) -> list[str]:
    parsed = urllib.parse.urlparse(url if re.match(r"^https?://", url, flags=re.I) else f"https://{url}")
    if not parsed.netloc:
        return [url]
    hosts = [parsed.netloc]
    bare_host = parsed.netloc.removeprefix("www.")
    if parsed.netloc.startswith("www."):
        hosts.append(bare_host)
    else:
        hosts.append(f"www.{bare_host}")
    schemes = [parsed.scheme or "https"]
    if "https" not in schemes:
        schemes.append("https")
    if "http" not in schemes:
        schemes.append("http")
    candidates: list[str] = []
    for scheme in schemes:
        for host in hosts:
            candidates.append(urllib.parse.urlunparse((scheme, host, parsed.path or "/", "", parsed.query, "")))
    return list(dict.fromkeys(candidates))


def extract_text(page_html: str) -> tuple[str, str]:
    parser = TextParser()
    parser.feed(page_html)
    text = clean_text(" ".join(parser.parts))
    if not text:
        text = fallback_html_text(page_html)
    return remove_boilerplate(text), clean_text(parser.title)


def html_to_text(fragment: str) -> str:
    parser = TextParser()
    parser.feed(fragment)
    text = clean_text(" ".join(parser.parts))
    if not text:
        text = fallback_html_text(fragment)
    return remove_boilerplate(text)


def fallback_html_text(fragment: str) -> str:
    cleaned = re.sub(r"<(script|style|noscript|svg)\b[^>]*>.*?</\1>", " ", fragment, flags=re.I | re.S)
    cleaned = re.sub(r"<br\s*/?>", "\n", cleaned, flags=re.I)
    cleaned = re.sub(r"</(?:p|div|section|article|li|h[1-6]|tr)>", "\n", cleaned, flags=re.I)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    return clean_text(cleaned)


def project_name_from_title(title: str, url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if "dsvmining.com" in host or "discoverysilver.com" in host:
        if "cordero-project" in path:
            return "Cordero Project"
        if "porcupine-operations" in path:
            return "Porcupine Operations"
        if "kidd-operations" in path:
            return "Kidd Operations"
    if "hudbayminerals.com" in host:
        if "/peru/" in path:
            return "Constancia"
        if "/canada/" in path:
            return "Copper Mountain and Snow Lake"
        if "/united-states/" in path:
            return "Copper World and Mason"
    if "lithiumamericas.com" in host and "thacker-pass" in path:
        return "Thacker Pass"
    if "mpmaterials.com" in host:
        return "Mountain Pass"
    if "skeenagoldsilver.com" in host and "eskay-creek" in path:
        return "Eskay Creek"
    if "trilogymetals.com" in host and "/properties/arctic" in path:
        return "Arctic"
    path = urllib.parse.urlparse(url).path.lower()
    if "hycroft-mine" in path:
        return "Hycroft Mine"
    if "orlamining.com" in urllib.parse.urlparse(url).netloc.lower():
        segments = [segment for segment in path.strip("/").split("/") if segment]
        if len(segments) >= 2 and segments[0] == "asset":
            if len(segments) >= 3 and segments[1] == "south-carlin-complex" and segments[2] == "south-railroad-project":
                return "South Railroad Project"
            return clean_text(segments[1].replace("-", " ").title())
    if "coeur.com" in urllib.parse.urlparse(url).netloc.lower():
        segments = [segment for segment in path.strip("/").split("/") if segment and segment != "default.aspx"]
        if len(segments) >= 2 and segments[0] == "operations-projects":
            return clean_text(re.sub(r"\b(?:ak|bc|mx|nv|on|sd)\b$", "", segments[1].replace("-", " ").title(), flags=re.I))
    if title:
        if re.match(r"^\s*Paramount Nevada\s*[-–|]", title, flags=re.IGNORECASE):
            name = re.split(r"\s*[-–|]\s*", title, maxsplit=1)[-1]
        elif re.search(r"\bHycroft Mining\s*[-–|]\s*Overview\b", title, flags=re.IGNORECASE):
            return "Hycroft Mine"
        elif re.search(r"\bWheaton Precious Metals\b", title, flags=re.IGNORECASE):
            name = re.split(r"\s*[|–-]\s*", title)[-1]
        elif "|" in title:
            parts = [clean_text(part) for part in re.split(r"\s*\|\s*", title) if clean_text(part)]
            candidates = [part for part in parts if not re.search(r"\b(?:corp|corporation|inc|ltd|limited|mining|gold|silver)\b", part, flags=re.I)]
            name = candidates[0] if candidates else parts[0]
        elif " - " in title and re.search(r"\b(?:corp|corporation|inc|ltd|limited|mining|gold|silver|substitute)\b", title, flags=re.I):
            name = re.split(r"\s+-\s+", title)[-1]
        else:
            name = re.split(r"\s*[|–-]\s*i80Gold", title, flags=re.IGNORECASE)[0]
        name = re.sub(r"\s*\([^)]*\)\s*", " ", name)
        name = clean_text(name)
        name = re.sub(r"^Operations\s*[-–]\s*", "", name, flags=re.I)
        name = re.sub(r"^SSR Mining\s*[|–-]\s*", "", name, flags=re.I)
        if name:
            return name
    slug = urllib.parse.urlparse(url).path.strip("/").split("/")[-1]
    return clean_text(slug.replace("-", " ").title())


def description_from_text(text: str, project_name: str) -> str:
    quick_index = text.upper().find("QUICK FACTS")
    if quick_index < 0:
        return ""
    prefix = text[:quick_index]
    name_index = prefix.lower().rfind(project_name.lower())
    if name_index >= 0:
        prefix = prefix[name_index + len(project_name) :]
    return trim_text(prefix, 1800)


def generic_description(text: str, project_name: str) -> str:
    stripped = text
    name_index = stripped.lower().find(project_name.lower())
    if name_index >= 0:
        stripped = stripped[name_index + len(project_name) :]
    stop_labels = [
        "Overview",
        "Highlights",
        "Location",
        "Ownership",
        "Mineral Resources",
        "Resources",
        "Geology",
        "Technical Reports",
        "News",
    ]
    overview = section_between(text, ["Overview", "Project Overview"], stop_labels[2:])
    return trim_text(overview or stripped, 1800)


def generic_field(text: str, labels: list[str]) -> str:
    for label in labels:
        match = re.search(rf"\b{re.escape(label)}\b\s*:?\s*([^.|\n]{{1,300}})", text, flags=re.IGNORECASE)
        if match:
            return clean_text(match.group(1))
    return ""


def generic_location(text: str) -> str:
    match = re.search(
        r"(?:located|situated)\s+(?:in|within|on)\s+([^.]{1,240}?\b(?:Nevada|Oregon|Idaho|Arizona|Utah|California|Colorado|Alaska|Canada|Mexico|Peru|Chile|Argentina|Brazil|Ghana|Mali|Burkina Faso|South Africa|Australia)\b[^.]*)\.",
        text,
        flags=re.IGNORECASE,
    )
    return clean_text(match.group(1)) if match else generic_field(text, ["Location"])


def generic_status(text: str) -> str:
    lower = text.lower()
    if any(token in lower for token in ["operating mine", "in production", "producing mine", "commercial production"]):
        return "production"
    if any(token in lower for token in ["construction", "development", "feasibility", "permitting", "pea", "pre-feasibility", "prefeasibility"]):
        return "development"
    if any(token in lower for token in ["exploration", "drill program", "drilling", "discovery"]):
        return "exploration"
    return generic_field(text, ["Status"])


def generic_mining_style(text: str) -> str:
    lower = text.lower()
    styles: list[str] = []
    if "underground" in lower:
        styles.append("underground")
    if "open-pit" in lower or "open pit" in lower:
        styles.append("open-pit")
    if "heap leach" in lower or "heap-leach" in lower:
        styles.append("heap-leach")
    return ", ".join(dict.fromkeys(styles))


def generic_resource(text: str, pattern: str) -> str:
    classification = "inferred" if "inferred" in pattern.lower() else "measured_indicated"
    return resource_value(text, classification)


def resource_value(text: str, classification: str, *, max_length: int = 700) -> str:
    text = resource_search_text(text)
    if not text:
        return ""

    label_pattern = resource_label_pattern(classification)
    candidates: list[str] = []
    for haystack in resource_haystacks(text):
        for match in re.finditer(label_pattern, haystack, flags=re.IGNORECASE):
            window = resource_window(haystack, match.start(), match.end(), classification, max_length=max_length)
            if resource_window_has_value(window):
                candidates.append(window)

    if not candidates:
        return ""
    return select_resource_candidate(candidates, classification, max_length=max_length)


def resource_search_text(text: str) -> str:
    text = remove_boilerplate(text)
    text = re.sub(r"</?[a-z][^>]*>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:contained|containing)\s+metal\b", "contained metal", text, flags=re.IGNORECASE)
    return clean_text(text)


def resource_haystacks(text: str) -> list[str]:
    sections = [
        section_between(
            text,
            ["Mineral Reserves & Mineral Resources", "Mineral Reserve and Mineral Resource Estimates", "Mineral Resources", "Resources"],
            ["Geology", "Technical Reports", "Documents and Downloads", "Quick Links", "Stay informed", "Subscribe", "News", "Contact"],
        ),
        text,
    ]
    return [section for section in dict.fromkeys(sections) if section]


def resource_label_pattern(classification: str) -> str:
    if classification == "inferred":
        return r"\bInferred(?:\s+Mineral\s+Resource(?:s| Estimate)?|\s+Resources?|\s+category)?\b"
    return (
        r"\b(?:"
        r"Measured\s*(?:&|\+|and)\s*Indicated"
        r"|M\s*&\s*I"
        r"|M&I"
        r"|Indicated(?:\s+Mineral\s+Resource(?:s| Estimate)?|\s+Resources?|\s+category)?"
        r")\b"
    )


def resource_window(text: str, start: int, label_end: int, classification: str, *, max_length: int) -> str:
    lower_bound = label_end + 18
    end = min(len(text), start + max_length * 2)
    boundary_pattern = resource_boundary_pattern(classification)
    for match in re.finditer(boundary_pattern, text[label_end:], flags=re.IGNORECASE):
        absolute = label_end + match.start()
        if absolute < lower_bound:
            continue
        end = min(end, absolute)
        break
    value = text[start:end]
    value = re.sub(r"\s+(?:NOTE|NOTES)\b.*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+(?:Documents and Downloads|Quick Links|Stay informed|Subscribe|Contact)\b.*$", "", value, flags=re.IGNORECASE)
    return trim_text(value.strip(" -:;,.|"), max_length)


def resource_boundary_pattern(classification: str) -> str:
    labels = RESOURCE_BOUNDARY_LABELS
    if classification == "inferred":
        labels = [label for label in labels if label.lower() != "inferred"]
    else:
        labels = [label for label in labels if not re.search(r"^(measured|m&i|indicated)", label, flags=re.IGNORECASE)]
    escaped = [re.escape(label).replace(r"\ ", r"\s+") for label in labels]
    year_heading = r"20[2-9]\d\s+(?:Performance|Guidance)"
    return r"\b(?:" + "|".join(escaped + [year_heading]) + r")\b"


def resource_window_has_value(value: str) -> bool:
    lowered = value.lower()
    if not re.search(r"\d", value):
        return False
    if any(term in lowered for term in RESOURCE_VALUE_TERMS):
        return True
    if "mineral resource" in lowered and len(re.findall(r"\d[\d,]*(?:\.\d+)?", value)) >= 3:
        return True
    return bool(re.search(r"\b(?:million|thousand|billion)\b", lowered))


def select_resource_candidate(candidates: list[str], classification: str, *, max_length: int) -> str:
    def score(value: str) -> tuple[int, int]:
        lowered = value.lower()
        unit_score = sum(1 for term in RESOURCE_VALUE_TERMS if term in lowered)
        metal_score = len(re.findall(r"\b(?:au|ag|cu|pb|zn|u3o8|nio|ree)\b", lowered))
        number_score = min(len(re.findall(r"\d", value)), 12)
        length_penalty = max(0, len(value) - max_length)
        classification_score = 4 if (
            ("inferred" in lowered and classification == "inferred")
            or (classification != "inferred" and re.search(r"\b(?:measured|indicated|m&i)\b", lowered))
        ) else 0
        return (classification_score + unit_score * 3 + metal_score * 2 + number_score - length_penalty, -len(value))

    best = sorted((clean_resource_value(candidate) for candidate in candidates), key=score, reverse=True)[0]
    return trim_text(best, max_length)


def clean_resource_value(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"\s+(?:related NEWS|PROJECT BACKGROUND|HIGHLIGHTS|Initial Assessment|Feasibility Study|Permitting Status)\b.*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+\*?\s*As at\b", " *As at", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+\((?:see|refer to)[^)]+\)", "", value, flags=re.IGNORECASE)
    return value.strip(" -:;,.|•")


def clean_resource_field(value: str, *, max_length: int = 700) -> str:
    if not value:
        return ""
    return trim_text(clean_resource_value(value), max_length)


def generic_geology(text: str) -> str:
    return section_between(
        text,
        ["Geology", "Geology and Mineralization", "Mineralization"],
        ["Technical Reports", "Mineral Resources", "Resources", "Exploration", "News", "Contact"],
    )


def field_between(text: str, label: str) -> str:
    upper = text.upper()
    start = upper.find(label.upper())
    if start < 0:
        return ""
    start += len(label)
    end = len(text)
    for other in FIELD_LABELS:
        if other.upper() == label.upper():
            continue
        idx = upper.find(other.upper(), start)
        if idx >= 0:
            end = min(end, idx)
    return trim_text(text[start:end], 1500)


def text_after(text: str, label: str) -> str:
    idx = text.upper().find(label.upper())
    return text[idx + len(label) :] if idx >= 0 else ""


def technical_report_links(project_url: str, page_html: str) -> list[tuple[str, str]]:
    parser = LinkParser()
    parser.feed(page_html)
    links: list[tuple[str, str]] = []
    for link in parser.links:
        absolute = normalize_url(urllib.parse.urljoin(project_url, link.url))
        if absolute == normalize_url(project_url):
            continue
        haystack = f"{link.text} {absolute}".lower()
        if not any(token in haystack for token in ["technical", "43-101", "1300", "report", "assessment", "feasibility", "biooxidation", "pressure-oxidation", "trs"]):
            continue
        if "mineral-resource-estimate-as-at" in haystack and link.text.lower() == "mineral resource estimate":
            continue
        if any(token in haystack for token in ["claim", "aeromag", "cortez"]) and not any(
            token in haystack for token in ["technical", "43-101", "1300", "report"]
        ):
            continue
        filename = urllib.parse.unquote(absolute.rsplit("/", 1)[-1])
        name = filename if link.text.lower() in {"download pdf", "pdf", "download"} else link.text or filename
        if not name:
            continue
        links.append((clean_text(name), absolute))
    deduped: dict[str, str] = {}
    for name, url in links:
        deduped[url] = name
    return [(name, url) for url, name in deduped.items()]


def split_report_names(text: str) -> list[str]:
    matches = re.findall(r"((?:NI\s*43-101|S-K\s*1300)[^.]+?(?:\(\w+\s+\d{4}\)))", text, flags=re.IGNORECASE)
    return [clean_text(match) for match in matches]


def store_project_rows(db: Any, company: Any, rows: list[ProjectPortfolioRow]) -> None:
    now = datetime.now(UTC).isoformat()
    with db:
        for row in rows:
            existing = db.execute(
                "select created_at from Website_Project_Portfolio where symbol = ? and project_url = ?",
                (company["symbol"], row.project_url),
            ).fetchone()
            created_at = existing["created_at"] if existing else now
            db.execute(
                """
                insert into Website_Project_Portfolio
                    (
                        symbol, company_name, project_name, project_url, description_text,
                        ownership, location, status, mining_style,
                        measured_indicated_mineral_resources, inferred_mineral_resources,
                        geology_text, technical_report_names, technical_report_urls,
                        extraction_method, status_code, error_message,
                        checked_at, created_at, updated_at
                    )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'website_project_portfolio_page', 'found', null, ?, ?, ?)
                on conflict(symbol, project_url)
                do update set
                    company_name = excluded.company_name,
                    project_name = excluded.project_name,
                    description_text = excluded.description_text,
                    ownership = excluded.ownership,
                    location = excluded.location,
                    status = excluded.status,
                    mining_style = excluded.mining_style,
                    measured_indicated_mineral_resources = excluded.measured_indicated_mineral_resources,
                    inferred_mineral_resources = excluded.inferred_mineral_resources,
                    geology_text = excluded.geology_text,
                    technical_report_names = excluded.technical_report_names,
                    technical_report_urls = excluded.technical_report_urls,
                    extraction_method = excluded.extraction_method,
                    status_code = excluded.status_code,
                    error_message = excluded.error_message,
                    checked_at = excluded.checked_at,
                    updated_at = excluded.updated_at
                """,
                (
                    company["symbol"],
                    company["company_name"],
                    row.project_name,
                    row.project_url,
                    row.description_text,
                    row.ownership,
                    row.location,
                    row.status,
                    row.mining_style,
                    row.measured_indicated_mineral_resources,
                    row.inferred_mineral_resources,
                    row.geology_text,
                    json.dumps(row.technical_report_names),
                    json.dumps(row.technical_report_urls),
                    now,
                    created_at,
                    now,
                ),
            )


def store_enriched_project_rows(db: Any, company: Any, rows: list[EnrichedProjectPortfolioRow]) -> None:
    now = datetime.now(UTC).isoformat()
    with db:
        for enriched in rows:
            row = enriched.project
            existing = db.execute(
                """
                select created_at from Website_Project_Portfolio_Extractions
                where symbol = ? and source_url = ? and project_name = ? and extraction_layer = ?
                """,
                (company["symbol"], enriched.source_url, row.project_name, enriched.extraction_layer),
            ).fetchone()
            created_at = existing["created_at"] if existing else now
            raw = json.dumps(asdict(enriched), ensure_ascii=False, sort_keys=True)
            db.execute(
                """
                insert into Website_Project_Portfolio_Extractions (
                    symbol, company_name, project_name, project_url, source_url, page_title,
                    retrieved_at, description_text, ownership, location, status, mining_style,
                    measured_indicated_mineral_resources, inferred_mineral_resources, geology_text,
                    technical_report_names, technical_report_urls, evidence_text, confidence,
                    extraction_layer, raw_json, status_code, error_message, created_at, updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'found', null, ?, ?)
                on conflict(symbol, source_url, project_name, extraction_layer)
                do update set
                    company_name = excluded.company_name,
                    project_url = excluded.project_url,
                    page_title = excluded.page_title,
                    retrieved_at = excluded.retrieved_at,
                    description_text = excluded.description_text,
                    ownership = excluded.ownership,
                    location = excluded.location,
                    status = excluded.status,
                    mining_style = excluded.mining_style,
                    measured_indicated_mineral_resources = excluded.measured_indicated_mineral_resources,
                    inferred_mineral_resources = excluded.inferred_mineral_resources,
                    geology_text = excluded.geology_text,
                    technical_report_names = excluded.technical_report_names,
                    technical_report_urls = excluded.technical_report_urls,
                    evidence_text = excluded.evidence_text,
                    confidence = excluded.confidence,
                    raw_json = excluded.raw_json,
                    status_code = excluded.status_code,
                    error_message = excluded.error_message,
                    updated_at = excluded.updated_at
                """,
                (
                    company["symbol"],
                    company["company_name"],
                    row.project_name,
                    row.project_url,
                    enriched.source_url,
                    enriched.page_title,
                    enriched.retrieved_at,
                    row.description_text,
                    row.ownership,
                    row.location,
                    row.status,
                    row.mining_style,
                    row.measured_indicated_mineral_resources,
                    row.inferred_mineral_resources,
                    row.geology_text,
                    json.dumps(row.technical_report_names),
                    json.dumps(row.technical_report_urls),
                    enriched.evidence_text,
                    enriched.confidence,
                    enriched.extraction_layer,
                    raw,
                    created_at,
                    now,
                ),
            )


def store_status_row(db: Any, company: Any, project_url: str, status_code: str, error_message: str) -> None:
    now = datetime.now(UTC).isoformat()
    with db:
        db.execute(
            """
            insert into Website_Project_Portfolio
                (
                    symbol, company_name, project_name, project_url, extraction_method,
                    status_code, error_message, checked_at, created_at, updated_at
                )
            values (?, ?, '', ?, 'website_project_portfolio_page', ?, ?, ?, ?, ?)
            on conflict(symbol, project_url)
            do update set
                status_code = excluded.status_code,
                error_message = excluded.error_message,
                checked_at = excluded.checked_at,
                updated_at = excluded.updated_at
            """,
            (company["symbol"], company["company_name"], project_url, status_code, error_message, now, now, now),
        )


def delete_existing(db: Any, symbol: str) -> None:
    with db:
        db.execute("delete from Website_Project_Portfolio where symbol = ?", (symbol,))


def delete_resilient_existing(db: Any, symbol: str) -> None:
    with db:
        db.execute("delete from Website_Project_Portfolio_Extractions where symbol = ?", (symbol,))


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "").replace("\xa0", " ")).strip()


def trim_text(value: str, max_length: int) -> str:
    cleaned = remove_boilerplate(clean_text(value))
    if len(cleaned) <= max_length:
        return cleaned
    return cleaned[:max_length].rsplit(" ", 1)[0]


def remove_boilerplate(text: str) -> str:
    text = re.sub(r"IAU\s*:\s*TSX.*?Contact", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"This website and documents found within may contain.*", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"General Inquires Phone.*", " ", text, flags=re.IGNORECASE)
    return clean_text(text)


def normalize_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path or "/"
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


if __name__ == "__main__":
    raise SystemExit(main())
