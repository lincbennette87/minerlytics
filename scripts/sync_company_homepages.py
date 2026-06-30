#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


DEFAULT_USER_AGENT = "Minerlytics/0.1 homepage-enrichment"
SEARCH_URL = "https://duckduckgo.com/html/"
BING_SEARCH_URL = "https://www.bing.com/search"
SEARCH_PROVIDER = "duckduckgo_html_or_bing_html"

BLOCKED_DOMAINS = {
    "bloomberg.com",
    "bing.com",
    "ca.finance.yahoo.com",
    "companiesmarketcap.com",
    "duckduckgo.com",
    "finance.yahoo.com",
    "google.com",
    "investing.com",
    "linkedin.com",
    "marketscreener.com",
    "nasdaq.com",
    "reuters.com",
    "sec.gov",
    "stockanalysis.com",
    "theglobeandmail.com",
    "tradingview.com",
    "wikipedia.org",
    "www.sec.gov",
    "yahoo.com",
}

COMPANY_STOPWORDS = {
    "and",
    "corp",
    "corporation",
    "company",
    "gold",
    "inc",
    "incorporated",
    "limited",
    "ltd",
    "mines",
    "mining",
    "plc",
    "resources",
    "silver",
    "the",
}

CURATED_HOMEPAGE_DOMAINS = {
    "AbraSilver Resource Corp.": "abrasilver.com",
    "AngloGold Ashanti plc": "anglogoldashanti.com",
    "Avino Silver & Gold Mines Ltd.": "avino.com",
    "B2Gold Corp.": "b2gold.com",
    "Caledonia Mining Corporation Plc": "caledoniamining.com",
    "DRDGOLD Limited": "drdgold.com",
    "Endeavour Silver Corp.": "edrsilver.com",
    "Fortuna Mining Corp.": "fortunamining.com",
    "GoldMining Inc.": "goldmining.com",
    "Gold Fields Limited": "goldfields.com",
    "IAMGOLD Corporation": "iamgold.com",
    "i-80 Gold Corp.": "i80gold.com",
    "Kinross Gold Corporation": "kinross.com",
    "Mako Mining Corp.": "makominingcorp.com",
    "Newmont Corporation": "newmont.com",
    "NovaGold Resources Inc.": "novagold.com",
    "OceanaGold Corporation": "oceanagold.com",
    "OR Royalties Inc.": "orroyalties.com",
    "Paramount Gold Nevada Corp.": "paramountnevada.com",
    "International Tower Hill Mines Ltd.": "ithmines.com",
    "U.S. Gold Corp.": "usgoldcorp.gold",
}

CURATED_HOMEPAGE_URLS = {
    "CMCL": "https://caledoniamining.com/",
    "GFI": "https://www.goldfields.com/",
    "IAUX": "https://www.i80gold.com/",
    "NG": "https://www.novagold.com/",
    "USAU": "https://www.usgoldcorp.gold/",
}


@dataclass(frozen=True)
class Company:
    symbol: str
    company_name: str
    short_name: str | None
    metal: str | None
    company_type: str | None


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str


@dataclass(frozen=True)
class HomepageMatch:
    url: str | None
    domain: str | None
    title: str | None
    snippet: str | None
    confidence: float
    status: str
    error_message: str | None = None


class _DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[SearchResult] = []
        self._in_title = False
        self._in_snippet = False
        self._current_url: str | None = None
        self._current_title: list[str] = []
        self._current_snippet: list[str] = []
        self._pending_result_index: int | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        classes = set((attr.get("class") or "").split())
        if tag == "a" and "result__a" in classes:
            self._in_title = True
            self._current_url = _unwrap_duckduckgo_url(attr.get("href") or "")
            self._current_title = []
            self._current_snippet = []
        elif "result__snippet" in classes and self.results:
            self._in_snippet = True
            self._pending_result_index = len(self.results) - 1
            self._current_snippet = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title:
            title = _clean_text(" ".join(self._current_title))
            if self._current_url and title:
                self.results.append(SearchResult(title=title, url=self._current_url, snippet=""))
            self._in_title = False
            self._current_url = None
            self._current_title = []
        elif self._in_snippet and tag in {"a", "div"}:
            snippet = _clean_text(" ".join(self._current_snippet))
            index = self._pending_result_index
            if index is not None and 0 <= index < len(self.results):
                result = self.results[index]
                self.results[index] = SearchResult(result.title, result.url, snippet)
            self._in_snippet = False
            self._pending_result_index = None
            self._current_snippet = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._current_title.append(data)
        elif self._in_snippet:
            self._current_snippet.append(data)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Search the web for official miner homepages from src/tickers.js and emit Cloudflare D1 upserts."
    )
    parser.add_argument("symbols", nargs="*", help="Ticker symbols to enrich, for example NEM AEM CDE")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to the miner universe JS file")
    parser.add_argument("--output-json", help="Optional JSON result file")
    parser.add_argument("--output-sql", help="Optional D1 SQL upsert file")
    parser.add_argument("--schema-sql", default="d1_company_homepages.sql", help="Schema SQL to prepend to --output-sql")
    parser.add_argument("--limit", type=int, help="Limit number of miners processed")
    parser.add_argument("--delay", type=float, default=1.0, help="Seconds to wait between searches")
    parser.add_argument("--dry-run", action="store_true", help="Print matches without writing output files")
    parser.add_argument("--parse-only", action="store_true", help="Only parse src/tickers.js and report the company count")
    parser.add_argument("--debug-results", action="store_true", help="Print parsed search results before ranking")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="HTTP User-Agent for search requests")
    args = parser.parse_args()

    tickers_path = Path(args.tickers_js)
    companies = load_ticker_universe(tickers_path)
    if args.symbols:
        requested = {symbol.upper() for symbol in args.symbols}
        companies = [company for company in companies if company.symbol in requested]
    if args.limit:
        companies = companies[: args.limit]

    if not companies:
        raise SystemExit("No companies matched the requested symbols.")
    if args.parse_only:
        print(f"Parsed {len(load_ticker_universe(tickers_path))} companies from {tickers_path}")
        for company in companies:
            print(json.dumps(company.__dict__, separators=(",", ":")))
        return 0

    rows: list[dict[str, Any]] = []
    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)

        curated_url = CURATED_HOMEPAGE_URLS.get(company.symbol)
        match = (
            curated_homepage_match(company.company_name, curated_url)
            if curated_url
            else find_homepage(
                company.company_name,
                user_agent=args.user_agent,
                debug_results=args.debug_results,
            )
        )
        row = row_for_match(company, match)
        rows.append(row)
        print(json.dumps(row, separators=(",", ":")), flush=True)

    if not args.dry_run:
        if args.output_json:
            write_json(Path(args.output_json), rows)
        if args.output_sql:
            write_d1_sql(Path(args.output_sql), rows, schema_path=Path(args.schema_sql))

    print(f"Processed {len(rows)} companies", flush=True)
    return 0


def load_ticker_universe(path: Path) -> list[Company]:
    source = path.read_text(encoding="utf-8")
    body_match = re.search(r"export\s+const\s+TICKERS\s*=\s*\{(?P<body>.*)\}\s*;?\s*$", source, re.DOTALL)
    if not body_match:
        raise ValueError(f"Could not find exported TICKERS object in {path}")

    companies: list[Company] = []
    for symbol, block in _iter_ticker_blocks(body_match.group("body")):
        companies.append(
            Company(
                symbol=symbol,
                company_name=_string_property(block, "company") or _string_property(block, "name") or symbol,
                short_name=_string_property(block, "name"),
                metal=_string_property(block, "metal"),
                company_type=_string_property(block, "type"),
            )
        )
    return companies


def _iter_ticker_blocks(body: str) -> list[tuple[str, str]]:
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


def _string_property(block: str, name: str) -> str | None:
    match = re.search(rf"\b{name}\s*:\s*(['\"])(.*?)\1", block, re.DOTALL)
    if not match:
        return None
    return bytes(match.group(2), "utf-8").decode("unicode_escape")


def find_homepage(
    company_name: str,
    *,
    user_agent: str = DEFAULT_USER_AGENT,
    debug_results: bool = False,
) -> HomepageMatch:
    query = search_query_for(company_name)
    try:
        results = search_web(query, user_agent=user_agent)
        if not any(_is_candidate_url(result.url) for result in results):
            results.extend(probe_company_domains(company_name, user_agent=user_agent))
    except Exception as exc:
        return HomepageMatch(None, None, None, None, 0, "failed", str(exc))

    if debug_results:
        for result in results[:10]:
            print(
                json.dumps(
                    {
                        "title": result.title,
                        "url": result.url,
                        "domain": _domain(result.url),
                        "score": round(_score_result(result, company_name), 3),
                    },
                    separators=(",", ":"),
                )
            )

    ranked = sorted(
        (
            (_score_result(result, company_name), result)
            for result in results
            if _is_candidate_url(result.url)
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    if not ranked or ranked[0][0] < 0.45:
        return HomepageMatch(None, None, None, None, 0, "not_found")

    score, result = ranked[0]
    return HomepageMatch(
        url=_canonical_homepage_url(result.url),
        domain=_domain(result.url),
        title=result.title,
        snippet=result.snippet,
        confidence=round(min(score, 0.99), 3),
        status="found",
    )


def curated_homepage_match(company_name: str, url: str) -> HomepageMatch:
    return HomepageMatch(
        url=url,
        domain=_domain(url),
        title=f"{company_name} official homepage",
        snippet="Curated homepage URL used for known miner universe company.",
        confidence=0.99,
        status="found",
    )


def search_duckduckgo(query: str, *, user_agent: str = DEFAULT_USER_AGENT) -> list[SearchResult]:
    url = f"{SEARCH_URL}?{urllib.parse.urlencode({'q': query})}"
    request = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml"})
    with urllib.request.urlopen(request, timeout=8) as response:
        body = response.read().decode("utf-8", errors="replace")
    parser = _DuckDuckGoParser()
    parser.feed(body)
    return parser.results


def search_bing(query: str, *, user_agent: str = DEFAULT_USER_AGENT) -> list[SearchResult]:
    url = f"{BING_SEARCH_URL}?{urllib.parse.urlencode({'q': query})}"
    request = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml"})
    with urllib.request.urlopen(request, timeout=8) as response:
        body = response.read().decode("utf-8", errors="replace")

    results: list[SearchResult] = []
    pattern = r"<h2[^>]*>\s*<a[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>"
    for match in re.finditer(pattern, body, re.IGNORECASE | re.DOTALL):
        url = html.unescape(match.group(1))
        title = _clean_text(re.sub(r"<[^>]+>", " ", match.group(2)))
        tail = body[match.end() : match.end() + 1500]
        snippet_match = re.search(r"<p[^>]*>(.*?)</p>", tail, re.IGNORECASE | re.DOTALL)
        snippet = _clean_text(re.sub(r"<[^>]+>", " ", snippet_match.group(1))) if snippet_match else ""
        if title and url:
            results.append(SearchResult(title=title, url=url, snippet=snippet))
    return results


def search_web(query: str, *, user_agent: str = DEFAULT_USER_AGENT) -> list[SearchResult]:
    try:
        results = search_duckduckgo(query, user_agent=user_agent)
    except Exception:
        results = []
    if results:
        return results
    try:
        return search_bing(query, user_agent=user_agent)
    except Exception:
        return []


def probe_company_domains(company_name: str, *, user_agent: str = DEFAULT_USER_AGENT) -> list[SearchResult]:
    tokens = _domain_tokens(company_name)
    candidates = _domain_guesses(tokens)
    curated_domain = CURATED_HOMEPAGE_DOMAINS.get(company_name)
    if curated_domain:
        candidates.insert(0, curated_domain)

    results: list[SearchResult] = []
    for domain in candidates:
        url = _first_responsive_url(domain, user_agent=user_agent)
        if url:
            results.append(
                SearchResult(
                    title=f"{company_name} homepage candidate",
                    url=url,
                    snippet="Responsive domain generated from company name after web-search fallback.",
                )
            )
    return results


def search_query_for(company_name: str) -> str:
    return f'"{company_name}" homepage'


def row_for_match(company: Company, match: HomepageMatch) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "homepage_url": match.url,
        "matched_domain": match.domain,
        "search_query": search_query_for(company.company_name),
        "search_provider": SEARCH_PROVIDER,
        "source_title": match.title,
        "source_snippet": match.snippet,
        "confidence": match.confidence,
        "status": match.status,
        "error_message": match.error_message,
        "checked_at": now,
    }


def write_json(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_d1_sql(path: Path, rows: list[dict[str, Any]], *, schema_path: Path) -> None:
    statements: list[str] = []
    if schema_path.exists():
        statements.append(schema_path.read_text(encoding="utf-8").strip())
    for row in rows:
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
        values = ", ".join(sql_value(row[column]) for column in columns)
        assignments = ",\n    ".join(
            f"{column} = excluded.{column}"
            for column in columns
            if column not in {"symbol"}
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


def sql_value(value: Any) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _score_result(result: SearchResult, company_name: str) -> float:
    domain = _domain(result.url)
    if _blocked_domain(domain):
        return 0
    haystack = f"{domain} {result.title} {result.snippet}".lower()
    tokens = _company_tokens(company_name)
    matches = sum(1 for token in tokens if token in haystack)
    score = matches / max(len(tokens), 1)
    title = result.title.lower()
    if "official" in title or "home" in title:
        score += 0.12
    if any(term in haystack for term in {"mining", "gold", "silver", "copper", "uranium", "lithium"}):
        score += 0.12
    if _domain_has_company_token(domain, tokens):
        score += 0.25
    if _looks_like_homepage(result.url):
        score += 0.1
    if any(token in haystack for token in {"investor relations", "tsx", "nyse", "nasdaq"}):
        score += 0.03
    if "generated from company name" in result.snippet.lower():
        score = min(score, 0.72)
    return score


def _company_tokens(company_name: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", company_name.lower().replace("&", " and "))
    return [word for word in words if len(word) > 2 and word not in COMPANY_STOPWORDS]


def _domain_tokens(company_name: str) -> list[str]:
    legal_words = {"and", "corp", "corporation", "company", "inc", "incorporated", "limited", "ltd", "plc", "the"}
    words = re.findall(r"[a-z0-9]+", company_name.lower().replace("&", " and "))
    return [word for word in words if len(word) > 2 and word not in legal_words]


def _domain_guesses(tokens: list[str]) -> list[str]:
    guesses: list[str] = []
    if len(tokens) >= 3:
        guesses.append(f"{tokens[0]}{tokens[1]}{tokens[2]}.com")
        guesses.append(f"{tokens[0]}-{tokens[1]}-{tokens[2]}.com")
    if len(tokens) >= 2:
        guesses.append(f"{tokens[0]}{tokens[1]}.com")
        guesses.append(f"{tokens[0]}-{tokens[1]}.com")
    return list(dict.fromkeys(guesses))


def _url_responds(url: str, *, user_agent: str = DEFAULT_USER_AGENT) -> bool:
    request = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            content_type = response.headers.get("content-type", "")
            return response.status < 400 and ("text/html" in content_type or not content_type)
    except Exception:
        return False


def _first_responsive_url(domain: str, *, user_agent: str = DEFAULT_USER_AGENT) -> str | None:
    for url in (
        f"https://{domain}/",
        f"https://www.{domain}/",
        f"http://{domain}/",
        f"http://www.{domain}/",
    ):
        if _url_responds(url, user_agent=user_agent):
            return url
    return None


def _domain_has_company_token(domain: str | None, tokens: list[str]) -> bool:
    compact = (domain or "").replace("-", "").replace(".", "")
    return any(token in compact for token in tokens)


def _is_candidate_url(url: str) -> bool:
    if not url.startswith(("http://", "https://")):
        return False
    domain = _domain(url)
    return bool(domain) and not _blocked_domain(domain)


def _blocked_domain(domain: str | None) -> bool:
    return any(domain == blocked or (domain or "").endswith(f".{blocked}") for blocked in BLOCKED_DOMAINS)


def _domain(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    return (parsed.netloc or "").lower().removeprefix("www.")


def _canonical_homepage_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if _looks_like_homepage(url):
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") or "/", "", "", ""))
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/", "", "", ""))


def _looks_like_homepage(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.strip("/").lower()
    return path in {"", "home", "en", "en-us", "company", "about", "investors"}


def _unwrap_duckduckgo_url(url: str) -> str:
    cleaned = html.unescape(url)
    parsed = urllib.parse.urlparse(cleaned)
    params = urllib.parse.parse_qs(parsed.query)
    if "uddg" in params:
        return params["uddg"][0]
    return cleaned


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


if __name__ == "__main__":
    raise SystemExit(main())
