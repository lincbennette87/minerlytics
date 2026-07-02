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


DEFAULT_USER_AGENT = "Minerlytics/0.2 website-about-us"
ABOUT_TEXT_PATTERNS = [
    "about us",
    "about",
    "who we are",
    "company",
    "corporate profile",
    "corporate overview",
    "overview",
]
ABOUT_URL_PATTERNS = [
    "/about",
    "/about-us",
    "/company",
    "/corporate",
    "/who-we-are",
    "/overview",
]
GENERATED_ABOUT_PATHS = [
    "/about/",
    "/about-us/",
    "/company/",
    "/company/about/",
    "/corporate/",
    "/corporate/about/",
    "/who-we-are/",
    "/overview/",
]
ABOUT_CONTEXT_TERMS = [
    "about us",
    "who we are",
    "company overview",
    "corporate profile",
    "corporate overview",
    "our company",
    "our business",
    "our story",
]
CURATED_HOMEPAGES = {
    "IAUX": "https://www.i80gold.com/",
    "PZG": "https://paramountnevada.com/",
}


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
class AboutResult:
    homepage_url: str | None
    about_url: str | None
    about_title: str | None
    about_text: str
    extraction_method: str
    status: str
    error_message: str | None = None

    @property
    def text_length(self) -> int:
        return len(self.about_text)


@dataclass(frozen=True)
class EnrichedAboutResult:
    source_url: str
    page_title: str
    retrieved_at: str
    about_text: str
    evidence_text: str
    confidence: float
    extraction_layer: str
    raw_json: str = ""

    @property
    def text_length(self) -> int:
        return len(self.about_text)


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[Link] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attr = dict(attrs)
        href = attr.get("href")
        if href:
            self._href = href
            self._text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href:
            text = clean_text(" ".join(self._text))
            self.links.append(Link(self._href, text))
            self._href = None
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._text.append(data)


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
        elif tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3", "br"} and not self._skip_depth:
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
        description="Extract About Us text from miner company websites and emit Cloudflare D1 SQL."
    )
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols to process")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--homepages-json", help="JSON output from scripts/sync_company_homepages.py")
    parser.add_argument("--output-json", help="Optional JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL output path")
    parser.add_argument("--schema-sql", default="d1_website_about_us.sql", help="Schema SQL to prepend")
    parser.add_argument("--limit", type=int, help="Limit number of companies processed")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between companies")
    parser.add_argument("--timeout", type=float, default=15.0, help="HTTP timeout in seconds")
    parser.add_argument("--homepage-url", help="Override homepage URL for a single symbol run")
    parser.add_argument(
        "--mode",
        choices=["combined", "legacy", "resilient"],
        default="combined",
        help="Extraction strategy. combined tries the existing About parser first, then resilient extraction.",
    )
    parser.add_argument("--min-confidence", type=float, default=0.55, help="Minimum confidence for resilient About text")
    parser.add_argument("--parse-only", action="store_true", help="Only parse src/tickers.js and report companies")
    parser.add_argument("--dry-run", action="store_true", help="Print rows without writing output files")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent")
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
    about_rows: list[dict[str, Any]] = []
    extraction_rows: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []

    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)
        homepage_url = args.homepage_url if len(companies) == 1 and args.homepage_url else homepages.get(company.symbol)
        if not homepage_url:
            homepage_url = CURATED_HOMEPAGES.get(company.symbol)
        result = AboutResult(homepage_url, None, None, "", "not_run", "not_found", "Extractor not run")
        enriched: EnrichedAboutResult | None = None
        try:
            if args.mode in {"combined", "legacy"}:
                result = extract_about_us(homepage_url, timeout=args.timeout, user_agent=args.user_agent)
            if result.status != "found" and args.mode in {"combined", "resilient"}:
                enriched = extract_about_us_resilient(
                    homepage_url,
                    timeout=args.timeout,
                    user_agent=args.user_agent,
                    min_confidence=args.min_confidence,
                )
                if enriched:
                    result = AboutResult(
                        homepage_url,
                        enriched.source_url,
                        enriched.page_title,
                        enriched.about_text,
                        f"resilient_{enriched.extraction_layer}",
                        "found",
                    )
            about_rows.append(row_for_about_result(company, result))
            if enriched:
                extraction_rows.append(row_for_enriched_about(company, homepage_url, enriched))
        except Exception as exc:
            result = AboutResult(homepage_url, None, None, "", "extractor_error", "failed", str(exc))
            about_rows.append(row_for_about_result(company, result))

        status = {
            "symbol": company.symbol,
            "status": result.status,
            "about_url": result.about_url or "",
            "text_length": result.text_length,
            "extraction_method": result.extraction_method,
            "error_message": result.error_message or "",
        }
        statuses.append(status)
        print(json.dumps(status, separators=(",", ":")), flush=True)

    if not args.dry_run:
        if args.output_json:
            write_json(Path(args.output_json), {"statuses": statuses, "about_rows": about_rows, "extractions": extraction_rows})
        if args.output_sql:
            write_d1_sql(Path(args.output_sql), about_rows, extraction_rows, schema_path=Path(args.schema_sql))
    print(
        "Processed "
        f"{len(companies)} companies; found {sum(1 for row in about_rows if row['status'] == 'found')} About Us rows"
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
    if isinstance(rows, dict) and "items" in rows:
        rows = rows["items"]
    if isinstance(rows, dict) and "profiles" in rows:
        rows = rows["profiles"]
    return {
        str(row.get("symbol", "")).upper(): row["homepage_url"]
        for row in rows
        if row.get("symbol") and row.get("homepage_url") and row.get("status") == "found"
    }


def extract_about_us(homepage_url: str | None, *, timeout: float, user_agent: str) -> AboutResult:
    if not homepage_url:
        return AboutResult(None, None, None, "", "homepage_missing", "not_found", "No homepage URL available")
    try:
        homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
        about_url = find_about_url(homepage_html, homepage_url)
        if not about_url:
            about_text, title = extract_text(homepage_html)
            fallback = extract_homepage_overview(about_text)
            if fallback:
                return AboutResult(homepage_url, homepage_url, title, fallback, "homepage_overview_fallback", "found")
            return AboutResult(homepage_url, None, None, "", "about_link_search", "not_found", "No About link found")

        about_html = fetch_html(about_url, timeout=timeout, user_agent=user_agent)
        about_text, title = extract_text(about_html)
        about_text = trim_about_text(about_text)
        if not about_text:
            return AboutResult(homepage_url, about_url, title, "", "about_page_text", "not_found", "About page had no extractable text")
        return AboutResult(homepage_url, about_url, title, about_text, "about_page_text", "found")
    except Exception as exc:
        return AboutResult(homepage_url, None, None, "", "http_fetch", "failed", str(exc))


def ensure_resilient_about_schema(db: Any) -> None:
    db.executescript(
        """
        create table if not exists Website_About_us_Extractions (
            id integer primary key autoincrement,
            symbol text not null references mining_companies(symbol),
            company_name text not null,
            homepage_url text,
            source_url text not null,
            page_title text not null default '',
            retrieved_at text not null,
            about_text text not null default '',
            text_length integer not null default 0,
            evidence_text text not null default '',
            confidence real not null,
            extraction_layer text not null,
            raw_json text not null default '',
            status text not null default 'found' check (status in ('found', 'not_found', 'failed')),
            error_message text,
            created_at text not null,
            updated_at text not null,
            unique(symbol, source_url, extraction_layer)
        );

        create index if not exists idx_website_about_us_extractions_symbol
            on Website_About_us_Extractions(symbol, confidence);
        """
    )


def extract_about_us_resilient(
    homepage_url: str | None,
    *,
    timeout: float,
    user_agent: str,
    min_confidence: float,
) -> EnrichedAboutResult | None:
    if not homepage_url:
        return None
    errors: list[str] = []
    for url in resilient_about_urls(homepage_url, timeout=timeout, user_agent=user_agent):
        try:
            page_html = fetch_html(url, timeout=timeout, user_agent=user_agent)
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            continue
        candidates = extract_resilient_about_candidates(page_html, url)
        candidates = [candidate for candidate in candidates if candidate.confidence >= min_confidence]
        if candidates:
            return sorted(candidates, key=about_quality, reverse=True)[0]
    return None


def resilient_about_urls(homepage_url: str, *, timeout: float, user_agent: str) -> list[str]:
    urls: list[str] = []
    try:
        homepage_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
        about_url = find_about_url(homepage_html, homepage_url)
        if about_url:
            urls.append(about_url)
    except Exception:
        pass
    urls.append(normalize_url(homepage_url))
    parsed = urllib.parse.urlparse(homepage_url)
    base_url = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    for path in GENERATED_ABOUT_PATHS:
        urls.append(normalize_url(urllib.parse.urljoin(base_url, path)))
    return list(dict.fromkeys(url for url in urls if url))


def extract_resilient_about_candidates(page_html: str, source_url: str) -> list[EnrichedAboutResult]:
    retrieved_at = datetime.now(UTC).isoformat()
    page_text, page_title = extract_text(page_html)
    candidates: list[EnrichedAboutResult] = []
    candidates.extend(extract_structured_about(page_html, source_url, page_title or "", retrieved_at))
    candidates.extend(extract_semantic_about(page_html, source_url, page_title or "", retrieved_at))
    context = extract_context_about(page_text)
    if context:
        candidates.append(
            make_enriched_about(
                source_url=source_url,
                page_title=page_title or "",
                retrieved_at=retrieved_at,
                about_text=context,
                evidence_text=context[:1800],
                extraction_layer="context_window",
            )
        )
    return [candidate for candidate in candidates if candidate]


def extract_structured_about(
    page_html: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
) -> list[EnrichedAboutResult]:
    results: list[EnrichedAboutResult] = []
    for script_text in re.findall(r"<script\b[^>]*>(?P<value>.*?)</script>", page_html, flags=re.I | re.S):
        for item in json_objects(script_text):
            for organization in walk_organization_objects(item):
                description = clean_text(
                    str(
                        organization.get("description")
                        or organization.get("about")
                        or organization.get("slogan")
                        or organization.get("disambiguatingDescription")
                        or ""
                    )
                )
                if not description:
                    continue
                raw = json.dumps(organization, ensure_ascii=False, sort_keys=True)
                results.append(
                    make_enriched_about(
                        source_url=source_url,
                        page_title=page_title,
                        retrieved_at=retrieved_at,
                        about_text=trim_about_text(description),
                        evidence_text=description,
                        extraction_layer="structured_data",
                        raw_json=raw,
                    )
                )
    return [result for result in results if result]


def json_objects(content: str) -> list[Any]:
    content = html.unescape(content.strip())
    if not content:
        return []
    objects: list[Any] = []
    try:
        objects.append(json.loads(content))
    except Exception:
        for match in re.finditer(r"({[^{}]{30,6000}})", content, flags=re.S):
            try:
                objects.append(json.loads(match.group(1)))
            except Exception:
                continue
    return objects


def walk_organization_objects(value: Any) -> list[dict[str, Any]]:
    organizations: list[dict[str, Any]] = []
    if isinstance(value, dict):
        value_type = value.get("@type") or value.get("type") or ""
        if isinstance(value_type, list):
            value_type = " ".join(str(part) for part in value_type)
        lowered_type = str(value_type).lower()
        if any(term in lowered_type for term in ["organization", "corporation", "localbusiness"]) or (
            "name" in value and any(key in value for key in ["description", "about", "slogan"])
        ):
            organizations.append(value)
        for nested in value.values():
            organizations.extend(walk_organization_objects(nested))
    elif isinstance(value, list):
        for item in value:
            organizations.extend(walk_organization_objects(item))
    return organizations


def extract_semantic_about(
    page_html: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
) -> list[EnrichedAboutResult]:
    results: list[EnrichedAboutResult] = []
    for block in about_blocks(page_html):
        text = trim_about_text(html_to_text(block))
        if len(text) < 180:
            continue
        results.append(
            make_enriched_about(
                source_url=source_url,
                page_title=page_title,
                retrieved_at=retrieved_at,
                about_text=text,
                evidence_text=text[:1800],
                extraction_layer="semantic_html",
            )
        )
    return [result for result in results if result]


def about_blocks(page_html: str) -> list[str]:
    blocks: list[str] = []
    for pattern in [
        r'<(?P<tag>section|article|div)\b(?P<attrs>[^>]*)class="[^"]*(?:about|overview|profile|company|who-we-are|intro|content)[^"]*"[^>]*>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
        r'<(?P<tag>section|article|div)\b(?P<attrs>[^>]*)id="[^"]*(?:about|overview|profile|company|who-we-are|intro)[^"]*"[^>]*>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
    ]:
        for match in re.finditer(pattern, page_html, flags=re.I | re.S):
            block = match.group(0)
            text = html_to_text(block)
            if 180 <= len(text) <= 8000 and about_context_score(text) >= 1:
                blocks.append(block)
    text = html_to_text(page_html)
    context = extract_context_about(text)
    if context:
        blocks.append(context)
    return list(dict.fromkeys(blocks))


def extract_context_about(text: str) -> str:
    text = remove_boilerplate(text)
    lowered = text.lower()
    starts = [lowered.find(term) for term in ABOUT_CONTEXT_TERMS if lowered.find(term) >= 0]
    if starts:
        start = max(0, min(starts) - 120)
        snippet = text[start : start + 4500]
    else:
        snippet = text[:3500]
    snippet = stop_at_boilerplate_boundary(snippet)
    return trim_about_text(snippet) if len(snippet) >= 220 and about_context_score(snippet) >= 1 else ""


def make_enriched_about(
    *,
    source_url: str,
    page_title: str,
    retrieved_at: str,
    about_text: str,
    evidence_text: str,
    extraction_layer: str,
    raw_json: str = "",
) -> EnrichedAboutResult | None:
    about_text = trim_about_text(about_text)
    evidence_text = clean_text(evidence_text)
    if len(about_text) < 120:
        return None
    confidence = about_confidence(about_text, evidence_text, extraction_layer)
    return EnrichedAboutResult(
        source_url=source_url,
        page_title=page_title,
        retrieved_at=retrieved_at,
        about_text=about_text,
        evidence_text=evidence_text[:1800],
        confidence=round(confidence, 3),
        extraction_layer=extraction_layer,
        raw_json=raw_json,
    )


def about_confidence(about_text: str, evidence_text: str, extraction_layer: str) -> float:
    score = 0.25
    if len(about_text) >= 220:
        score += 0.2
    if len(about_text) >= 700:
        score += 0.1
    if about_context_score(about_text) >= 1:
        score += 0.15
    if about_context_score(evidence_text) >= 2:
        score += 0.1
    if extraction_layer == "structured_data":
        score += 0.08
    elif extraction_layer == "semantic_html":
        score += 0.12
    return min(score, 0.98)


def about_context_score(text: str) -> int:
    lowered = text.lower()
    score = sum(1 for term in ABOUT_CONTEXT_TERMS if term in lowered)
    if re.search(r"\b(?:gold|silver|mining|mine|mineral|exploration|development|producer|royalty|streaming)\b", lowered):
        score += 1
    return score


def about_quality(result: EnrichedAboutResult) -> float:
    layer_bonus = {"semantic_html": 0.08, "structured_data": 0.06, "context_window": 0.03}.get(result.extraction_layer, 0)
    return result.confidence + min(result.text_length, 5000) / 20000 + layer_bonus


def fetch_html(url: str, *, timeout: float, user_agent: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,*/*",
        },
    )
    kwargs: dict[str, Any] = {}
    if "goldfields.com" in urllib.parse.urlparse(url).netloc.lower():
        kwargs["context"] = ssl._create_unverified_context()
    with urllib.request.urlopen(request, timeout=timeout, **kwargs) as response:
        content_type = response.headers.get("content-type", "")
        charset = response.headers.get_content_charset() or "utf-8"
        if "html" not in content_type and content_type:
            raise ValueError(f"Expected HTML but received {content_type}")
        return response.read().decode(charset, errors="replace")


def find_about_url(homepage_html: str, homepage_url: str) -> str | None:
    parser = LinkParser()
    parser.feed(homepage_html)
    base_domain = domain(homepage_url)
    candidates: list[tuple[int, str]] = []
    for link in parser.links:
        absolute_url = urllib.parse.urljoin(homepage_url, link.href)
        if domain(absolute_url) != base_domain:
            continue
        score = score_about_link(link, absolute_url)
        if score:
            candidates.append((score, normalize_url(absolute_url)))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (-item[0], len(item[1])))
    return candidates[0][1]


def score_about_link(link: Link, url: str) -> int:
    text = clean_text(link.text).lower()
    path = urllib.parse.urlparse(url).path.lower().rstrip("/")
    score = 0
    for index, pattern in enumerate(ABOUT_TEXT_PATTERNS):
        if text == pattern:
            score = max(score, 100 - index)
        elif pattern in text:
            score = max(score, 70 - index)
    for index, pattern in enumerate(ABOUT_URL_PATTERNS):
        if path == pattern:
            score = max(score, 90 - index)
        elif pattern in path:
            score = max(score, 60 - index)
    return score


def extract_text(page_html: str) -> tuple[str, str | None]:
    parser = TextParser()
    parser.feed(page_html)
    text = clean_text(" ".join(parser.parts))
    text = remove_boilerplate(text)
    return text, parser.title or None


def html_to_text(fragment: str) -> str:
    parser = TextParser()
    parser.feed(fragment)
    return remove_boilerplate(clean_text(" ".join(parser.parts)))


def trim_about_text(text: str) -> str:
    text = remove_boilerplate(text)
    if len(text) <= 6000:
        return text
    return text[:6000].rsplit(" ", 1)[0]


def extract_homepage_overview(text: str) -> str:
    lowered = text.lower()
    starts = [lowered.find(pattern) for pattern in ["about us", "who we are", "company overview", "corporate profile"]]
    starts = [start for start in starts if start >= 0]
    if not starts:
        return ""
    start = min(starts)
    snippet = text[start : start + 3000]
    return trim_about_text(snippet)


def remove_boilerplate(text: str) -> str:
    text = re.sub(r"\b(Customize Reject All Accept All|Necessary Cookies Always Active|Reject All Save My Preferences Accept All)\b.*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def stop_at_boilerplate_boundary(text: str) -> str:
    for marker in [
        "Latest News",
        "News Releases",
        "Investor Relations",
        "Contact Us",
        "Subscribe",
        "Privacy Policy",
        "Forward-Looking",
    ]:
        idx = text.lower().find(marker.lower())
        if idx > 500:
            return text[:idx]
    return text


def row_for_enriched_about(
    company: Company,
    homepage_url: str | None,
    result: EnrichedAboutResult,
) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    raw = result.raw_json or json.dumps(asdict(result), ensure_ascii=False, sort_keys=True)
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": homepage_url,
        "source_url": result.source_url,
        "page_title": result.page_title,
        "retrieved_at": result.retrieved_at,
        "about_text": result.about_text,
        "text_length": result.text_length,
        "evidence_text": result.evidence_text,
        "confidence": result.confidence,
        "extraction_layer": result.extraction_layer,
        "raw_json": raw,
        "status": "found",
        "error_message": None,
        "created_at": now,
    }


def row_for_about_result(company: Company, result: AboutResult) -> dict[str, Any]:
    now = datetime.now(UTC).isoformat()
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": result.homepage_url,
        "about_url": result.about_url,
        "about_title": result.about_title,
        "about_text": result.about_text,
        "text_length": result.text_length,
        "extraction_method": result.extraction_method,
        "status": result.status,
        "error_message": result.error_message,
        "checked_at": now,
        "created_at": now,
    }


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_d1_sql(
    path: Path,
    about_rows: list[dict[str, Any]],
    extraction_rows: list[dict[str, Any]],
    *,
    schema_path: Path,
) -> None:
    statements: list[str] = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())

    about_columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "about_url",
        "about_title",
        "about_text",
        "text_length",
        "extraction_method",
        "status",
        "error_message",
        "checked_at",
        "created_at",
    ]
    about_assignments = ",\n    ".join(
        f"{column} = excluded.{column}"
        for column in about_columns
        if column not in {"symbol", "created_at"}
    )
    for row in about_rows:
        values = ", ".join(sql_value(row.get(column)) for column in about_columns)
        statements.append(
            f"""INSERT INTO website_about_us ({", ".join(about_columns)}, updated_at)
VALUES ({values}, CURRENT_TIMESTAMP)
ON CONFLICT(symbol) DO UPDATE SET
    {about_assignments},
    updated_at = CURRENT_TIMESTAMP;"""
        )

    extraction_columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "source_url",
        "page_title",
        "retrieved_at",
        "about_text",
        "text_length",
        "evidence_text",
        "confidence",
        "extraction_layer",
        "raw_json",
        "status",
        "error_message",
        "created_at",
    ]
    extraction_assignments = ",\n    ".join(
        f"{column} = excluded.{column}"
        for column in extraction_columns
        if column not in {"symbol", "source_url", "extraction_layer", "created_at"}
    )
    for row in extraction_rows:
        values = ", ".join(sql_value(row.get(column)) for column in extraction_columns)
        statements.append(
            f"""INSERT INTO website_about_us_extractions ({", ".join(extraction_columns)}, updated_at)
VALUES ({values}, CURRENT_TIMESTAMP)
ON CONFLICT(symbol, source_url, extraction_layer) DO UPDATE SET
    {extraction_assignments},
    updated_at = CURRENT_TIMESTAMP;"""
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(statements).strip() + "\n", encoding="utf-8")


def sql_value(value: Any) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def domain(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")


def normalize_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path or "/"
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


if __name__ == "__main__":
    raise SystemExit(main())
