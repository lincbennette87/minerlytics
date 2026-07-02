#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


DEFAULT_USER_AGENT = "Minerlytics/0.2 website-project-portfolio"

CURATED_HOMEPAGES = {
    "AG": "https://www.firstmajestic.com/",
    "ARIS": "https://aris-mining.com/",
    "CDE": "https://www.coeur.com/",
    "FNV": "https://www.franco-nevada.com/",
    "GFI": "https://www.goldfields.com/",
    "GOLD": "https://www.barrick.com/",
    "HYMC": "https://hycroftmining.com/",
    "IAUX": "https://www.i80gold.com/",
    "MAG": "https://magsilver.com/",
    "PZG": "https://paramountnevada.com/",
    "WPM": "https://www.wheatonpm.com/",
}

KNOWN_PROJECT_PATHS = {
    "GFI": [
        "/australia-operations.php",
        "/canada-operations.php",
        "/chile-operations.php",
        "/ghana-operations.php",
        "/peru-operations.php",
        "/south-africa-operations.php",
    ],
    "HYMC": ["/hycroft-mine/overview/"],
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
    "THM": ["/projects/livengold-gold-project/", "/projects/livengood-gold-project/"],
    "VGZ": ["/mt-todd/"],
    "VZLA": ["/panuco-project/"],
}

KNOWN_LANDING_PATHS = {
    "AG": ["/operations/"],
    "ARIS": ["/operations/"],
    "AUGO": ["/en/operations/", "/operacoes/"],
    "CDE": ["/operations/default.aspx"],
    "DRD": ["/our-business/"],
    "EQX": ["/operations/"],
    "FNV": ["/assets/portfolio/", "/our-assets/"],
    "GFI": ["/where-we-operate/"],
    "GOLD": ["/English/operations/default.aspx"],
    "HL": ["/operations/"],
    "HMY": ["/where-we-operate/", "/operations/"],
    "WPM": ["/portfolio/portfolio-overview/default.aspx"],
}

COMMON_LANDING_PATHS = [
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

PROJECT_LINK_TERMS = [
    "asset",
    "assets",
    "deposit",
    "development",
    "exploration",
    "gold",
    "mine",
    "mines",
    "operation",
    "operations",
    "portfolio",
    "project",
    "projects",
    "properties",
    "property",
    "silver",
]

PROJECT_NEGATIVE_TERMS = [
    "about",
    "careers",
    "contact",
    "cookie",
    "disclaimer",
    "governance",
    "investor",
    "media",
    "news",
    "privacy",
    "sedar",
    "sec-filings",
    "subscribe",
    "sustainability",
]

STATUS_RE = re.compile(r"\b(?:production|producing|operating|development|exploration|advanced exploration|permitting|feasibility|construction)\b", re.I)
MINING_STYLE_RE = re.compile(r"\b(?:open pit|underground|heap leach|milling|processing|placer|surface mine|bulk underground)\b", re.I)
OWNERSHIP_RE = re.compile(r"\b(?:\d{1,3}(?:\.\d+)?%|wholly owned|joint venture|owns?|ownership|stream|royalty)\b[^.]{0,180}", re.I)
RESOURCE_RE = re.compile(r"\b(?:measured and indicated|M&I|indicated|inferred)\b[^.]{0,240}", re.I)
LOCATION_RE = re.compile(
    r"\b(?:located|location|in|near)\b[^.]{0,120}\b(?:Nevada|Ontario|Quebec|British Columbia|Mexico|Peru|Chile|Ghana|"
    r"South Africa|Australia|Brazil|Argentina|Colombia|United States|Canada|Idaho|Alaska|Arizona|California|Colorado|"
    r"Montana|Nevada|New Mexico|Oregon|Utah|Washington|Wyoming)\b",
    re.I,
)


@dataclass(frozen=True)
class Company:
    symbol: str
    company_name: str
    short_name: str
    metal: str
    company_type: str


@dataclass(frozen=True)
class Link:
    href: str
    text: str


@dataclass(frozen=True)
class ProjectRow:
    symbol: str
    company_name: str
    short_name: str
    metal: str
    company_type: str
    project_name: str
    project_url: str
    source_url: str
    page_title: str
    retrieved_at: str
    description_text: str
    ownership: str
    location: str
    status: str
    mining_style: str
    measured_indicated_mineral_resources: str
    inferred_mineral_resources: str
    geology_text: str
    technical_report_names_json: str
    technical_report_urls_json: str
    evidence_text: str
    confidence: float
    extraction_layer: str
    status_code: str
    error_message: str


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.links: list[Link] = []
        self.lines: list[str] = []
        self._in_title = False
        self._title_parts: list[str] = []
        self._href: str | None = None
        self._link_parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
            self._title_parts = []
        elif tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        elif tag == "a" and attr.get("href"):
            self._href = attr["href"]
            self._link_parts = []
        elif tag in {"h1", "h2", "h3", "h4", "p", "li", "div", "br", "tr"} and not self._skip_depth:
            self.lines.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
            self.title = clean_text(" ".join(self._title_parts))
        elif tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "a" and self._href:
            self.links.append(Link(self._href, clean_text(" ".join(self._link_parts))))
            self._href = None
            self._link_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._href:
            self._link_parts.append(data)
        elif not self._skip_depth:
            text = clean_text(data)
            if text:
                self.lines.append(text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract mining project/property portfolio details from websites and emit Cloudflare D1 SQL."
    )
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols to process")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--homepages-json", help="JSON output from scripts/sync_company_homepages.py")
    parser.add_argument("--output-json", help="Optional JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL output path")
    parser.add_argument("--schema-sql", default="d1_website_project_portfolio.sql", help="Schema SQL to prepend")
    parser.add_argument("--limit", type=int, help="Limit number of companies processed")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between companies")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP timeout")
    parser.add_argument("--min-confidence", type=float, default=0.52, help="Minimum confidence to store")
    parser.add_argument("--parse-only", action="store_true", help="Only parse src/tickers.js and report companies")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without writing output files")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
    args = parser.parse_args()

    companies = load_ticker_universe(Path(args.tickers_js))
    if args.symbols:
        wanted = {symbol.strip().upper() for symbol in args.symbols}
        companies = [company for company in companies if company.symbol in wanted]
    if args.limit:
        companies = companies[: args.limit]
    if not companies:
        raise SystemExit("No companies matched the requested symbols.")
    if args.parse_only:
        print(f"Parsed {len(load_ticker_universe(Path(args.tickers_js)))} companies from {args.tickers_js}")
        for company in companies:
            print(json.dumps(company.__dict__, separators=(",", ":")))
        return 0

    homepages = load_homepages(Path(args.homepages_json)) if args.homepages_json else {}
    rows: list[ProjectRow] = []
    statuses: list[dict[str, Any]] = []
    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)
        homepage_url = CURATED_HOMEPAGES.get(company.symbol) or homepages.get(company.symbol)
        if not homepage_url:
            status = {"symbol": company.symbol, "status": "not_found", "projects": 0, "error_message": "No homepage URL available"}
            rows.append(status_row(company, "", "not_found", "No homepage URL available"))
            statuses.append(status)
            print(json.dumps(status, separators=(",", ":")), flush=True)
            continue
        try:
            projects = extract_company_projects(company, homepage_url, timeout=args.timeout, user_agent=args.user_agent)
            projects = [row for row in projects if row.confidence >= args.min_confidence]
            if projects:
                rows.extend(projects)
                status = {"symbol": company.symbol, "status": "found", "projects": len(projects), "homepage_url": homepage_url}
            else:
                rows.append(status_row(company, homepage_url, "not_found", "No portfolio project pages found"))
                status = {"symbol": company.symbol, "status": "not_found", "projects": 0, "homepage_url": homepage_url}
        except Exception as exc:
            rows.append(status_row(company, homepage_url, "failed", str(exc)))
            status = {"symbol": company.symbol, "status": "failed", "projects": 0, "homepage_url": homepage_url, "error_message": str(exc)}
        statuses.append(status)
        print(json.dumps(status, separators=(",", ":")), flush=True)

    if not args.dry_run:
        if args.output_json:
            write_json(Path(args.output_json), {"statuses": statuses, "projects": [row.__dict__ for row in rows]})
        if args.output_sql:
            write_d1_sql(Path(args.output_sql), rows, schema_path=Path(args.schema_sql))
    print(f"Processed {len(companies)} companies; extracted {sum(1 for row in rows if row.status_code == 'found')} project rows")
    return 0


def load_ticker_universe(path: Path) -> list[Company]:
    source = path.read_text(encoding="utf-8")
    body_match = re.search(r"export\s+const\s+TICKERS\s*=\s*\{(?P<body>.*)\}\s*;?\s*$", source, re.S)
    if not body_match:
        raise ValueError(f"Could not find exported TICKERS object in {path}")
    companies = []
    for symbol, block in iter_ticker_blocks(body_match.group("body")):
        companies.append(
            Company(
                symbol=symbol,
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


def load_homepages(path: Path) -> dict[str, str]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(rows, dict) and "profiles" in rows:
        rows = rows["profiles"]
    return {
        str(row.get("symbol", "")).upper(): row["homepage_url"]
        for row in rows
        if row.get("symbol") and row.get("homepage_url") and row.get("status") == "found"
    }


def extract_company_projects(company: Company, homepage_url: str, *, timeout: float, user_agent: str) -> list[ProjectRow]:
    homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
    urls = discover_project_urls(company.symbol, homepage_url, homepage_html, timeout=timeout, user_agent=user_agent)
    rows: list[ProjectRow] = []
    for url in urls:
        try:
            page_html = fetch_html(url, timeout=timeout, user_agent=user_agent)
        except Exception:
            continue
        rows.extend(extract_projects_from_page(company, url, page_html))
    return dedupe_project_rows(rows)[:40]


def discover_project_urls(symbol: str, homepage_url: str, homepage_html: str, *, timeout: float, user_agent: str) -> list[str]:
    urls: list[str] = []
    urls.extend(urls_for_paths(homepage_url, KNOWN_PROJECT_PATHS.get(symbol, [])))
    landing_paths = KNOWN_LANDING_PATHS.get(symbol, []) + COMMON_LANDING_PATHS
    landing_urls = urls_for_paths(homepage_url, landing_paths)
    urls.extend(landing_urls)
    urls.extend(project_links_from_html(homepage_url, homepage_html))
    for landing_url in list(dict.fromkeys(landing_urls))[:10]:
        try:
            landing_html = fetch_html(landing_url, timeout=timeout, user_agent=user_agent)
        except Exception:
            continue
        urls.extend(project_links_from_html(landing_url, landing_html))
    return list(dict.fromkeys(urls))[:55]


def urls_for_paths(base_url: str, paths: list[str]) -> list[str]:
    parsed = urllib.parse.urlparse(base_url)
    base = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    return [normalize_url(urllib.parse.urljoin(base, path)) for path in paths]


def project_links_from_html(base_url: str, page_html: str) -> list[str]:
    parser = parse_page(page_html)
    scored: list[tuple[int, str]] = []
    for link in parser.links:
        url = normalize_url(urllib.parse.urljoin(base_url, link.href))
        if not same_site(base_url, url) or unwanted_project_url(url):
            continue
        path = urllib.parse.urlparse(url).path.lower()
        haystack = f"{link.text} {path}".lower()
        score = sum(2 for term in PROJECT_LINK_TERMS if term in haystack)
        if re.search(r"\b(?:gold|silver|copper|mine|project|property|operation|deposit)\b", link.text, re.I):
            score += 4
        if score:
            scored.append((score, url))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [url for _score, url in scored]


def extract_projects_from_page(company: Company, source_url: str, page_html: str) -> list[ProjectRow]:
    parser = parse_page(page_html)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    text = "\n".join(line for line in parser.lines if clean_text(line))
    page_title = parser.title
    rows: list[ProjectRow] = []
    rows.extend(extract_project_cards(company, source_url, page_html, page_title, retrieved_at))
    if not rows:
        project_name = infer_project_name(source_url, page_title, text)
        if project_name and substantive_project_text(text):
            rows.append(build_project_row(company, project_name, source_url, source_url, page_title, retrieved_at, text, "page_context"))
    return rows


def extract_project_cards(company: Company, source_url: str, page_html: str, page_title: str, retrieved_at: str) -> list[ProjectRow]:
    rows: list[ProjectRow] = []
    block_re = re.compile(
        r'<(?P<tag>article|li|div|section)\b(?P<attrs>[^>]*)>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
        re.I | re.S,
    )
    for match in block_re.finditer(page_html):
        attrs = html.unescape(match.group("attrs"))
        block = match.group("body")
        block_text = html_to_text(block)
        if not likely_project_block(attrs, block_text):
            continue
        name = extract_project_name(block_text)
        if not name:
            continue
        rows.append(build_project_row(company, name, source_url, source_url, page_title, retrieved_at, block_text, "semantic_html"))
    return rows


def build_project_row(
    company: Company,
    project_name: str,
    project_url: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
    evidence: str,
    extraction_layer: str,
) -> ProjectRow:
    description = trim_text(description_from_text(evidence), 1800)
    ownership = extract_first(OWNERSHIP_RE, evidence)
    location = extract_first(LOCATION_RE, evidence)
    status = extract_first(STATUS_RE, evidence)
    mining_style = extract_first(MINING_STYLE_RE, evidence)
    measured_indicated = extract_resource_text(evidence, "measured")
    inferred = extract_resource_text(evidence, "inferred")
    geology = extract_geology_text(evidence)
    report_names, report_urls = extract_technical_reports(evidence)
    confidence = project_confidence(project_name, description, location, status, evidence, extraction_layer)
    return ProjectRow(
        symbol=company.symbol,
        company_name=company.company_name,
        short_name=company.short_name,
        metal=company.metal,
        company_type=company.company_type,
        project_name=clean_project_name(project_name),
        project_url=project_url,
        source_url=source_url,
        page_title=page_title,
        retrieved_at=retrieved_at,
        description_text=description,
        ownership=ownership,
        location=location,
        status=status,
        mining_style=mining_style,
        measured_indicated_mineral_resources=measured_indicated,
        inferred_mineral_resources=inferred,
        geology_text=geology,
        technical_report_names_json=json.dumps(report_names, separators=(",", ":")),
        technical_report_urls_json=json.dumps(report_urls, separators=(",", ":")),
        evidence_text=trim_text(evidence, 2400),
        confidence=round(confidence, 3),
        extraction_layer=extraction_layer,
        status_code="found",
        error_message="",
    )


def status_row(company: Company, homepage_url: str, status_code: str, error_message: str) -> ProjectRow:
    now = datetime.now(timezone.utc).isoformat()
    return ProjectRow(
        symbol=company.symbol,
        company_name=company.company_name,
        short_name=company.short_name,
        metal=company.metal,
        company_type=company.company_type,
        project_name="",
        project_url=homepage_url,
        source_url=homepage_url,
        page_title="",
        retrieved_at=now,
        description_text="",
        ownership="",
        location="",
        status="",
        mining_style="",
        measured_indicated_mineral_resources="",
        inferred_mineral_resources="",
        geology_text="",
        technical_report_names_json="[]",
        technical_report_urls_json="[]",
        evidence_text="",
        confidence=0,
        extraction_layer="status",
        status_code=status_code,
        error_message=error_message,
    )


def likely_project_block(attrs: str, text: str) -> bool:
    haystack = f"{attrs} {text}".lower()
    class_hit = bool(re.search(r"\b(?:project|property|portfolio|asset|operation|mine|card)\b", attrs, re.I))
    context_hit = sum(1 for term in PROJECT_LINK_TERMS if term in haystack)
    return class_hit and context_hit >= 2 and len(text) > 80


def extract_project_name(text: str) -> str:
    lines = split_text_lines(text)
    for line in lines[:10]:
        if 3 <= len(line) <= 90 and not generic_project_name(line):
            if re.search(r"\b(?:mine|project|property|deposit|operation|complex|district|stream|royalty)\b", line, re.I):
                return line
    for line in lines[:6]:
        if 3 <= len(line) <= 70 and not generic_project_name(line):
            return line
    return ""


def infer_project_name(source_url: str, page_title: str, text: str) -> str:
    title = clean_project_name(page_title.split("|")[0].split("-")[0])
    if title and not generic_project_name(title):
        return title
    path = urllib.parse.urlparse(source_url).path.strip("/").split("/")[-1]
    name = clean_project_name(path.replace("-", " ").replace("_", " "))
    if name and not generic_project_name(name):
        return name
    return extract_project_name(text)


def clean_project_name(value: str) -> str:
    cleaned = clean_text(value)
    cleaned = re.sub(r"\b(?:overview|operations|portfolio|projects|properties|assets)\b$", "", cleaned, flags=re.I).strip(" -|")
    return cleaned[:120]


def generic_project_name(value: str) -> bool:
    lowered = value.lower().strip()
    if lowered in {"overview", "operations", "projects", "properties", "portfolio", "assets", "our assets", "where we operate"}:
        return True
    return bool(re.search(r"\b(?:404|error|not found|privacy|contact|news|investors|home)\b", lowered))


def substantive_project_text(text: str) -> bool:
    lowered = text.lower()
    return len(text) > 250 and any(term in lowered for term in PROJECT_LINK_TERMS)


def description_from_text(text: str) -> str:
    lines = [line for line in split_text_lines(text) if len(line) > 45]
    return " ".join(lines[:8])


def extract_resource_text(text: str, kind: str) -> str:
    matches = RESOURCE_RE.findall(text)
    if kind == "inferred":
        matches = [match for match in matches if "inferred" in match.lower()]
    else:
        matches = [match for match in matches if "measured" in match.lower() or "indicated" in match.lower() or "m&i" in match.lower()]
    return trim_text(" ".join(matches[:3]), 500)


def extract_geology_text(text: str) -> str:
    sentences = re.split(r"(?<=[.!?])\s+", clean_text(text))
    geology = [s for s in sentences if re.search(r"\b(?:geology|geological|mineralization|mineralisation|deposit|vein|orebody|hosted)\b", s, re.I)]
    return trim_text(" ".join(geology[:5]), 900)


def extract_technical_reports(text: str) -> tuple[list[str], list[str]]:
    names = re.findall(r"[^.\n]{0,80}\b(?:NI 43-101|SK-1300|technical report|feasibility study|PEA|preliminary economic assessment)\b[^.\n]{0,120}", text, re.I)
    urls = re.findall(r"https?://[^\s\"')<>]+", text)
    report_urls = [url for url in urls if re.search(r"\b(?:pdf|technical|report|43-101|sk-1300|feasibility|pea)\b", url, re.I)]
    return unique([clean_text(name) for name in names])[:10], unique(report_urls)[:10]


def project_confidence(project_name: str, description: str, location: str, status: str, evidence: str, extraction_layer: str) -> float:
    score = 0.42
    if project_name:
        score += 0.18
    if description:
        score += 0.12
    if location:
        score += 0.08
    if status:
        score += 0.06
    if re.search(r"\b(?:resource|reserve|geology|ownership|technical report)\b", evidence, re.I):
        score += 0.08
    if extraction_layer == "semantic_html":
        score += 0.06
    return min(score, 0.98)


def dedupe_project_rows(rows: list[ProjectRow]) -> list[ProjectRow]:
    best: dict[tuple[str, str], ProjectRow] = {}
    for row in rows:
        key = (row.symbol, row.project_name.lower())
        existing = best.get(key)
        row_score = row.confidence + len(row.description_text) / 10000
        existing_score = existing.confidence + len(existing.description_text) / 10000 if existing else -1
        if existing is None or row_score > existing_score:
            best[key] = row
    return sorted(best.values(), key=lambda row: (row.symbol, row.project_name))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_d1_sql(path: Path, rows: list[ProjectRow], *, schema_path: Path) -> None:
    statements: list[str] = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())
    symbols = sorted({row.symbol for row in rows if row.symbol})
    if symbols:
        statements.append(f"DELETE FROM website_project_portfolio WHERE symbol IN ({', '.join(sql_value(symbol) for symbol in symbols)});")
    columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
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
        "extraction_layer",
        "status_code",
        "error_message",
    ]
    for row in rows:
        payload = row.__dict__
        values = ", ".join(sql_value(payload[column]) for column in columns)
        statements.append(f"INSERT INTO website_project_portfolio ({', '.join(columns)}, created_at, updated_at) VALUES ({values}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(statements).strip() + "\n", encoding="utf-8")


def sql_value(value: Any) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def fetch_html(url: str, *, timeout: float, user_agent: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_page(page_html: str) -> PageParser:
    parser = PageParser()
    parser.feed(page_html)
    return parser


def html_to_text(value: str) -> str:
    parser = parse_page(value)
    return "\n".join(clean_text(line) for line in parser.lines if clean_text(line))


def split_text_lines(text: str) -> list[str]:
    return [clean_text(line) for line in re.split(r"[\n\r]+| {2,}", text) if clean_text(line)]


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "").replace("\xa0", " ")).strip()


def trim_text(value: str, max_length: int) -> str:
    cleaned = clean_text(value)
    if len(cleaned) <= max_length:
        return cleaned
    return cleaned[:max_length].rsplit(" ", 1)[0]


def extract_first(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text)
    return trim_text(match.group(0), 500) if match else ""


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(clean_text(value) for value in values if clean_text(value)))


def normalize_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse((parsed.scheme or "https", parsed.netloc, parsed.path or "/", "", parsed.query, ""))


def same_site(base_url: str, candidate_url: str) -> bool:
    base = urllib.parse.urlparse(base_url).netloc.lower().removeprefix("www.")
    candidate = urllib.parse.urlparse(candidate_url).netloc.lower().removeprefix("www.")
    return bool(base and candidate) and (candidate == base or candidate.endswith(f".{base}") or base.endswith(f".{candidate}"))


def unwanted_project_url(url: str) -> bool:
    lowered = url.lower()
    if any(term in lowered for term in PROJECT_NEGATIVE_TERMS):
        return True
    return bool(re.search(r"\.(jpg|jpeg|png|gif|webp|zip|docx?|xlsx?)($|\?)", lowered))


if __name__ == "__main__":
    raise SystemExit(main())
