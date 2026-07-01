#!/usr/bin/env python3
"""Discover company website investor news and announcements for Minerlytics.

The script follows the same CI pattern as the other website sync jobs:
1. Load the miner universe from src/tickers.js.
2. Load curated/company homepage URLs from sync_company_homepages.py output.
3. Find likely investor news, press release, newsroom, and announcement pages.
4. Extract article/announcement links and lightweight context from each page.
5. Emit JSON plus Cloudflare D1 SQL that can be executed by Wrangler.
"""

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


DEFAULT_USER_AGENT = "Minerlytics/0.2 website-investor-news"

NEWS_TERMS = [
    "news",
    "news release",
    "news releases",
    "press release",
    "press releases",
    "announcement",
    "announcements",
    "media release",
    "investor news",
    "investors/news",
    "investor-relations/news",
    "financial news",
]

ARTICLE_TERMS = [
    "announces",
    "reports",
    "intersects",
    "discovers",
    "files",
    "appoints",
    "closes",
    "completes",
    "provides",
    "updates",
    "results",
    "production",
    "earnings",
    "drilling",
    "resource",
    "reserve",
    "feasibility",
]

GENERATED_NEWS_PATHS = [
    "/news/",
    "/news-releases/",
    "/press-releases/",
    "/media/news/",
    "/media/press-releases/",
    "/investors/news/",
    "/investors/news-releases/",
    "/investors/press-releases/",
    "/investor-relations/news/",
    "/investor-relations/news-releases/",
    "/investor-relations/press-releases/",
    "/English/news/default.aspx",
    "/English/news/news-releases/default.aspx",
    "/English/investors/news/default.aspx",
    "/English/investors/news-releases/default.aspx",
    "/investors/news/default.aspx",
    "/investors/news-releases/default.aspx",
    "/news/default.aspx",
    "/news-releases/default.aspx",
]

CURATED_NEWS_URLS = {
    "AEM": "https://www.agnicoeagle.com/English/investor-relations/news-and-events/news-releases/default.aspx",
    "AG": "https://www.firstmajestic.com/news/",
    "AGI": "https://www.alamosgold.com/news-and-media/news-releases/",
    "CDE": "https://www.coeur.com/news/default.aspx",
    "EGO": "https://www.eldoradogold.com/news-and-media/news-releases/",
    "FNV": "https://www.franco-nevada.com/news-releases/default.aspx",
    "GFI": "https://www.goldfields.com/news-and-media.php",
    "GOLD": "https://www.barrick.com/English/news/default.aspx",
    "HL": "https://www.hecla.com/news/",
    "HYMC": "https://hycroftmining.com/news/",
    "IAUX": "https://www.i80gold.com/investors/#news",
    "KGC": "https://www.kinross.com/news-and-investors/news-releases/default.aspx",
    "NEM": "https://www.newmont.com/investors/news-release/default.aspx",
    "PAAS": "https://www.panamericansilver.com/news/",
    "PZG": "https://paramountnevada.com/news/",
    "WPM": "https://www.wheatonpm.com/news-releases/default.aspx",
}

DATE_RE = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|"
    r"Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4}\b"
    r"|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b",
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
class NewsArticle:
    landing_url: str
    article_url: str
    article_title: str
    published_date: str
    summary_text: str
    evidence_text: str
    page_title: str
    retrieved_at: str
    confidence: float
    extraction_layer: str


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.links: list[Link] = []
        self.lines: list[str] = []
        self.meta: dict[str, str] = {}
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
        elif tag == "meta":
            key = attr.get("property") or attr.get("name")
            content = attr.get("content")
            if key and content:
                self.meta[key.lower()] = clean_text(content)
        elif tag == "a" and attr.get("href"):
            self._href = attr["href"]
            self._link_parts = []
        elif tag in {"h1", "h2", "h3", "h4", "p", "li", "div", "time", "br"} and not self._skip_depth:
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
        description="Discover website investor news and announcement pages for the Minerlytics universe."
    )
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols to process")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--homepages-json", help="JSON output from scripts/sync_company_homepages.py")
    parser.add_argument("--output-json", help="Optional JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL output path")
    parser.add_argument("--schema-sql", default="d1_website_investor_news.sql", help="Schema SQL to prepend")
    parser.add_argument("--limit", type=int, help="Limit number of companies processed")
    parser.add_argument("--max-articles", type=int, default=10, help="Maximum article rows per company")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between companies")
    parser.add_argument("--timeout", type=float, default=15.0, help="HTTP timeout")
    parser.add_argument("--parse-only", action="store_true", help="Only parse src/tickers.js and report companies")
    parser.add_argument("--dry-run", action="store_true", help="Print payload without writing output files")
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
    rows: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []

    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)
        homepage_url = homepages.get(company.symbol)
        try:
            landing_urls = candidate_news_urls(company, homepage_url, timeout=args.timeout, user_agent=args.user_agent)
            articles, errors = extract_news_articles(
                landing_urls,
                max_articles=args.max_articles,
                timeout=args.timeout,
                user_agent=args.user_agent,
            )
            if articles:
                for article in articles:
                    rows.append(row_for_article(company, homepage_url or "", article, status_code="found"))
                status = {
                    "symbol": company.symbol,
                    "status": "found",
                    "articles": len(articles),
                    "landing_urls": sorted({article.landing_url for article in articles}),
                }
            else:
                status = {
                    "symbol": company.symbol,
                    "status": "not_found",
                    "articles": 0,
                    "homepage_url": homepage_url,
                    "tried_urls": landing_urls[:15],
                    "errors": errors[:8],
                    "error_message": "No investor news or announcement articles found",
                }
                rows.append(row_for_status(company, homepage_url or "", status))
        except Exception as exc:
            status = {"symbol": company.symbol, "status": "failed", "articles": 0, "homepage_url": homepage_url, "error_message": str(exc)}
            rows.append(row_for_status(company, homepage_url or "", status))
        statuses.append(status)
        print(json.dumps(status, separators=(",", ":")), flush=True)

    payload = {"statuses": statuses, "articles": rows}
    if args.dry_run:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    if args.output_json:
        write_json(Path(args.output_json), payload)
    if args.output_sql:
        write_d1_sql(Path(args.output_sql), rows, schema_path=Path(args.schema_sql))
    found = sum(1 for row in rows if row.get("status_code") == "found")
    print(f"Processed {len(companies)} companies; extracted {found} investor news rows")
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
    if isinstance(rows, dict) and "items" in rows:
        rows = rows["items"]
    if isinstance(rows, dict) and "profiles" in rows:
        rows = rows["profiles"]
    return {
        str(row.get("symbol", "")).upper(): row["homepage_url"]
        for row in rows
        if row.get("symbol") and row.get("homepage_url") and row.get("status") == "found"
    }


def candidate_news_urls(company: Company, homepage_url: str | None, *, timeout: float, user_agent: str) -> list[str]:
    urls: list[str] = []
    if company.symbol in CURATED_NEWS_URLS:
        urls.append(CURATED_NEWS_URLS[company.symbol])
    if homepage_url:
        urls.extend(discover_news_links(homepage_url, timeout=timeout, user_agent=user_agent))
        urls.extend(generated_news_urls(homepage_url))
    return list(dict.fromkeys(url for url in urls if url))[:35]


def discover_news_links(homepage_url: str, *, timeout: float, user_agent: str) -> list[str]:
    try:
        page_html = fetch_html(homepage_url, timeout=timeout, user_agent=user_agent)
    except Exception:
        return []
    parser = parse_page(page_html)
    scored: list[tuple[int, str]] = []
    for link in parser.links:
        absolute = urllib.parse.urljoin(homepage_url, link.href)
        if not is_same_site(homepage_url, absolute) or unwanted_url(absolute):
            continue
        haystack = f"{link.text} {absolute}".lower()
        score = sum(4 for term in NEWS_TERMS if term in haystack)
        score += sum(1 for term in {"investor", "media", "events", "press", "release"} if term in haystack)
        if score:
            scored.append((score, strip_fragment(absolute)))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [url for _score, url in scored]


def generated_news_urls(homepage_url: str) -> list[str]:
    parsed = urllib.parse.urlparse(homepage_url)
    base = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    return [urllib.parse.urljoin(base, path) for path in GENERATED_NEWS_PATHS]


def extract_news_articles(
    landing_urls: list[str],
    *,
    max_articles: int,
    timeout: float,
    user_agent: str,
) -> tuple[list[NewsArticle], list[dict[str, str]]]:
    articles: list[NewsArticle] = []
    errors: list[dict[str, str]] = []
    seen_articles: set[str] = set()
    for landing_url in landing_urls:
        if len(articles) >= max_articles:
            break
        try:
            landing_html = fetch_html(landing_url, timeout=timeout, user_agent=user_agent)
            parser = parse_page(landing_html)
            candidate_links = article_links_from_landing(landing_url, parser)
            if not candidate_links and likely_news_page(parser, landing_url):
                article = article_from_page(landing_url, landing_url, landing_html, fallback_title=parser.title)
                if article:
                    articles.append(article)
                    seen_articles.add(strip_fragment(landing_url))
                    continue
            for link in candidate_links:
                article_url = strip_fragment(urllib.parse.urljoin(landing_url, link.href))
                if article_url in seen_articles or not is_same_site(landing_url, article_url) or unwanted_url(article_url):
                    continue
                seen_articles.add(article_url)
                try:
                    article_html = fetch_html(article_url, timeout=timeout, user_agent=user_agent)
                    article = article_from_page(landing_url, article_url, article_html, fallback_title=link.text)
                    if article:
                        articles.append(article)
                    if len(articles) >= max_articles:
                        break
                except Exception as exc:
                    errors.append({"url": article_url, "error": str(exc)})
        except Exception as exc:
            errors.append({"url": landing_url, "error": str(exc)})
    return dedupe_articles(articles)[:max_articles], errors


def article_links_from_landing(landing_url: str, parser: PageParser) -> list[Link]:
    scored: list[tuple[int, Link]] = []
    for link in parser.links:
        absolute = urllib.parse.urljoin(landing_url, link.href)
        haystack = f"{link.text} {absolute}".lower()
        if not link.text or len(link.text) < 8:
            continue
        score = 0
        score += sum(3 for term in ARTICLE_TERMS if term in haystack)
        score += sum(3 for term in NEWS_TERMS if term in haystack)
        score += 3 if DATE_RE.search(haystack) else 0
        score += 2 if re.search(r"/(?:news|press|release|releases|announcements?)/", absolute, re.I) else 0
        if any(term in haystack for term in {"subscribe", "contact", "privacy", "terms", "email alerts"}):
            score -= 4
        if score > 0:
            scored.append((score, Link(absolute, link.text)))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [link for _score, link in scored[:30]]


def article_from_page(landing_url: str, article_url: str, page_html: str, *, fallback_title: str) -> NewsArticle | None:
    parser = parse_page(page_html)
    lines = [line for line in (clean_text(item) for item in parser.lines) if line]
    page_text = clean_text(" ".join(lines))
    title = first_nonempty(
        parser.meta.get("og:title"),
        parser.meta.get("twitter:title"),
        heading_title(lines),
        fallback_title,
        parser.title,
    )
    if is_error_page(title, page_text):
        return None
    if not title or not likely_article_title(title, article_url, page_text):
        return None
    published_date = first_nonempty(
        parser.meta.get("article:published_time"),
        parser.meta.get("date"),
        parser.meta.get("dc.date"),
        extract_first(DATE_RE, page_text[:2000]),
    )
    summary = first_nonempty(
        parser.meta.get("og:description"),
        parser.meta.get("description"),
        summarize_article_text(lines, title),
    )
    evidence = clean_text(" ".join([title, published_date, summary, page_text[:900]]))[:1400]
    confidence = article_confidence(title, article_url, page_text, published_date)
    if confidence < 0.42:
        return None
    return NewsArticle(
        landing_url=landing_url,
        article_url=article_url,
        article_title=title[:500],
        published_date=published_date[:120],
        summary_text=summary[:1600],
        evidence_text=evidence,
        page_title=parser.title,
        retrieved_at=datetime.now(timezone.utc).isoformat(),
        confidence=round(confidence, 3),
        extraction_layer="website_news_page",
    )


def likely_news_page(parser: PageParser, url: str) -> bool:
    haystack = f"{parser.title} {url} {' '.join(parser.lines[:80])}".lower()
    return any(term in haystack for term in NEWS_TERMS)


def likely_article_title(title: str, url: str, page_text: str) -> bool:
    generic_titles = {
        "all rights reserved",
        "privacy policy",
        "page not found",
        "404",
        "corporate",
        "news",
        "news releases",
        "press releases",
        "announcements",
        "investor news",
    }
    if title.lower().strip() in generic_titles or any(term in title.lower() for term in {"all rights reserved", "privacy policy", "page not found", "404"}):
        return False
    haystack = f"{title} {url} {page_text[:1200]}".lower()
    if any(term in haystack for term in NEWS_TERMS + ARTICLE_TERMS):
        return True
    return bool(DATE_RE.search(haystack) and len(title) > 20)


def is_error_page(title: str, page_text: str) -> bool:
    haystack = f"{title} {page_text[:800]}".lower()
    return any(
        term in haystack
        for term in {
            "404",
            "page not found",
            "looks like you're lost",
            "the page you are looking for",
            "might have been moved",
        }
    )


def article_confidence(title: str, url: str, page_text: str, published_date: str) -> float:
    haystack = f"{title} {url} {page_text[:1400]}".lower()
    score = 0.28
    if any(term in haystack for term in NEWS_TERMS):
        score += 0.2
    if any(term in haystack for term in ARTICLE_TERMS):
        score += 0.18
    if published_date:
        score += 0.14
    if len(page_text) > 600:
        score += 0.1
    if re.search(r"/(?:news|press|release|releases|announcements?)/", url, re.I):
        score += 0.1
    return min(score, 0.99)


def summarize_article_text(lines: list[str], title: str) -> str:
    blocked = {title, "news", "investors", "contact", "subscribe"}
    chunks = []
    for line in lines:
        if line.lower() in blocked or len(line) < 45:
            continue
        if any(term in line.lower() for term in {"cookie", "privacy policy", "terms of use"}):
            continue
        chunks.append(line)
        if len(" ".join(chunks)) > 1200:
            break
    return clean_text(" ".join(chunks))


def heading_title(lines: list[str]) -> str:
    for line in lines[:20]:
        if 15 <= len(line) <= 220 and likely_article_title(line, "", ""):
            return line
    return ""


def row_for_article(company: Company, homepage_url: str, article: NewsArticle, *, status_code: str) -> dict[str, Any]:
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": homepage_url,
        "news_landing_url": article.landing_url,
        "article_url": article.article_url,
        "article_title": article.article_title,
        "published_date": article.published_date,
        "summary_text": article.summary_text,
        "page_title": article.page_title,
        "retrieved_at": article.retrieved_at,
        "evidence_text": article.evidence_text,
        "confidence": article.confidence,
        "extraction_layer": article.extraction_layer,
        "status_code": status_code,
        "error_message": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def row_for_status(company: Company, homepage_url: str, status: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": homepage_url,
        "news_landing_url": "",
        "article_url": "",
        "article_title": "",
        "published_date": "",
        "summary_text": "",
        "page_title": "",
        "retrieved_at": now,
        "evidence_text": json.dumps(status.get("tried_urls") or [], separators=(",", ":")),
        "confidence": 0,
        "extraction_layer": "status",
        "status_code": status["status"],
        "error_message": status.get("error_message") or "",
        "created_at": now,
    }


def dedupe_articles(articles: list[NewsArticle]) -> list[NewsArticle]:
    best: dict[str, NewsArticle] = {}
    for article in articles:
        key = strip_fragment(article.article_url).lower()
        existing = best.get(key)
        if existing is None or article.confidence > existing.confidence:
            best[key] = article
    return sorted(best.values(), key=lambda article: date_sort_key(article.published_date), reverse=True)


def date_sort_key(value: str) -> float:
    if not value:
        return 0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_d1_sql(path: Path, rows: list[dict[str, Any]], *, schema_path: Path) -> None:
    statements: list[str] = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())
    columns = [
        "symbol",
        "company_name",
        "short_name",
        "metal",
        "company_type",
        "homepage_url",
        "news_landing_url",
        "article_url",
        "article_title",
        "published_date",
        "summary_text",
        "page_title",
        "retrieved_at",
        "evidence_text",
        "confidence",
        "extraction_layer",
        "status_code",
        "error_message",
        "created_at",
    ]
    symbols = sorted({row["symbol"] for row in rows if row.get("symbol")})
    if symbols:
        statements.append(f"DELETE FROM website_investor_news WHERE symbol IN ({', '.join(sql_value(symbol) for symbol in symbols)});")
    for row in rows:
        values = ", ".join(sql_value(row.get(column)) for column in columns)
        statements.append(f"INSERT INTO website_investor_news ({', '.join(columns)}, updated_at) VALUES ({values}, CURRENT_TIMESTAMP);")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n\n".join(statements).strip() + "\n", encoding="utf-8")


def sql_value(value: Any) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def fetch_html(url: str, *, timeout: float, user_agent: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def parse_page(page_html: str) -> PageParser:
    parser = PageParser()
    parser.feed(page_html)
    return parser


def is_same_site(base_url: str, candidate_url: str) -> bool:
    base = urllib.parse.urlparse(base_url).netloc.lower().removeprefix("www.")
    candidate = urllib.parse.urlparse(candidate_url).netloc.lower().removeprefix("www.")
    return bool(base and candidate and (candidate == base or candidate.endswith("." + base)))


def unwanted_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    lower = url.lower()
    if parsed.scheme not in {"http", "https"}:
        return True
    if any(lower.endswith(ext) for ext in (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".zip", ".mp4", ".mp3")):
        return True
    return any(term in lower for term in ("mailto:", "javascript:", "tel:", "/privacy", "/terms", "cookie"))


def strip_fragment(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse(parsed._replace(fragment=""))


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def extract_first(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text)
    return clean_text(match.group(0)) if match else ""


def first_nonempty(*values: str | None) -> str:
    return next((clean_text(value or "") for value in values if clean_text(value or "")), "")


if __name__ == "__main__":
    raise SystemExit(main())
