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


DEFAULT_USER_AGENT = "Minerlytics/0.2 website-management-team"

CURATED_MANAGEMENT_URLS = {
    "AAUC": "https://alliedgold.com/about/executive-management/default.aspx",
    "AG": "https://www.firstmajestic.com/corporate/leadership/",
    "ARIS": "https://aris-mining.com/about-us/management/",
    "ASM": "https://www.avino.com/leadership",
    "ATCX": "https://www.atlascriticalminerals.com/our-team/management/",
    "AUGO": "https://www.auraminerals.com/en/who-are-we/#nossas-liderancas",
    "AUST": "https://austin.gold/corporate/management-and-directors/",
    "CDE": "https://www.coeur.com/about/leadership/default.aspx",
    "FNV": "https://www.franco-nevada.com/about-us/board-of-directors/default.aspx",
    "GOLD": "https://www.barrick.com/English/about/executive-team/default.aspx",
    "IAUX": "https://www.i80gold.com/about/",
    "NFGC": "https://newfoundgold.ca/about/leadership/",
    "ODV": "https://osiskodev.com/about-us/#leadership",
    "PZG": "https://paramountnevada.com/PageBuilder/Management-%26-Consultants",
    "WPM": "https://www.wheatonpm.com/about/leadership/default.aspx",
}

MANAGEMENT_TERMS = [
    "management",
    "leadership",
    "executive team",
    "executive management",
    "senior management",
    "board of directors",
    "directors and officers",
    "officers and directors",
    "our team",
    "our people",
    "who we are",
]

GENERATED_PATHS = [
    "/about/leadership/default.aspx",
    "/about/executive-team/default.aspx",
    "/about/executive-management/default.aspx",
    "/about/management/default.aspx",
    "/about/leadership/",
    "/about/management/",
    "/about/executive-team/",
    "/about/executive-management/",
    "/about-us/leadership/default.aspx",
    "/about-us/management/default.aspx",
    "/about-us/leadership/",
    "/about-us/management/",
    "/corporate/leadership/default.aspx",
    "/corporate/management/default.aspx",
    "/corporate/leadership/",
    "/corporate/management/",
    "/corporate/management-and-directors/",
    "/our-team/management/",
    "/our-team/",
    "/leadership/",
    "/management/",
    "/management-team/",
    "/executive-team/",
    "/executive-management/",
    "/senior-management/",
    "/who-we-are/",
]

TITLE_RE = re.compile(
    r"\b(?:"
    r"president|chief executive officer|chief financial officer|chief operating officer|chief technical officer|"
    r"chief development officer|chief administrative officer|chief legal officer|ceo|cfo|coo|cto|cao|"
    r"general counsel|corporate secretary|vice president|senior vice president|executive vice president|"
    r"vp|svp|evp|director|chair|chairman|founder|advisor|adviser|consultant|manager|geologist|engineer"
    r")\b",
    re.I,
)
NAME_RE = re.compile(r"^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4}$")
COMMITTEE_RE = re.compile(
    r"\b(?:Audit|Risk|Technical|Nominating|Compensation|Governance|Sustainability|Finance|Disclosure|"
    r"Safety|Environmental|ESG|Operations|Investment)(?:\s+(?:and|&)\s+"
    r"(?:Audit|Risk|Technical|Nominating|Compensation|Governance|Sustainability|Finance|Disclosure|"
    r"Safety|Environmental|ESG|Operations|Investment))?\s+Committee\b",
    re.I,
)
APPOINTMENT_RE = re.compile(r"\b(?:appointed|joined|director since|served since|became)\b[^.]{0,140}", re.I)


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
class Profile:
    person_name: str
    title: str
    biography: str
    appointment_date: str
    board_roles: list[str]
    committee_roles: list[str]
    source_url: str
    page_title: str
    retrieved_at: str
    evidence_text: str
    profile_image_url: str
    confidence: float
    extraction_layer: str


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.links: list[Link] = []
        self.images: list[str] = []
        self.scripts: list[tuple[str, str]] = []
        self.lines: list[str] = []
        self._in_title = False
        self._title_parts: list[str] = []
        self._href: str | None = None
        self._link_parts: list[str] = []
        self._in_script = False
        self._script_type = ""
        self._script_parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
            self._title_parts = []
        elif tag == "script":
            self._in_script = True
            self._script_type = attr.get("type", "")
            self._script_parts = []
            self._skip_depth += 1
        elif tag in {"style", "noscript", "svg"}:
            self._skip_depth += 1
        elif tag == "a" and attr.get("href"):
            self._href = attr["href"]
            self._link_parts = []
        elif tag == "img" and attr.get("src"):
            self.images.append(attr["src"])
        elif tag in {"h1", "h2", "h3", "h4", "p", "li", "div", "br"} and not self._skip_depth:
            self.lines.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
            self.title = clean_text(" ".join(self._title_parts))
        elif tag == "script" and self._in_script:
            self._in_script = False
            self.scripts.append((self._script_type, "\n".join(self._script_parts)))
            self._script_type = ""
            self._script_parts = []
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in {"style", "noscript", "svg"}:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "a" and self._href:
            self.links.append(Link(self._href, clean_text(" ".join(self._link_parts))))
            self._href = None
            self._link_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._in_script:
            self._script_parts.append(data)
        elif self._href:
            self._link_parts.append(data)
        elif not self._skip_depth:
            text = clean_text(data)
            if text:
                self.lines.append(text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract mining company management profiles from website pages and emit Cloudflare D1 upserts."
    )
    parser.add_argument("symbols", nargs="*", help="Optional ticker symbols to process")
    parser.add_argument("--tickers-js", default="src/tickers.js", help="Path to src/tickers.js miner universe")
    parser.add_argument("--homepages-json", help="JSON output from scripts/sync_company_homepages.py")
    parser.add_argument("--output-json", help="Optional JSON output path")
    parser.add_argument("--output-sql", help="Optional D1 SQL output path")
    parser.add_argument("--schema-sql", default="d1_website_management_team.sql", help="Schema SQL to prepend")
    parser.add_argument("--limit", type=int, help="Limit number of companies processed")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds to wait between companies")
    parser.add_argument("--timeout", type=float, default=15.0, help="HTTP timeout")
    parser.add_argument("--min-confidence", type=float, default=0.55, help="Minimum confidence to store")
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
    rows: list[dict[str, Any]] = []
    statuses: list[dict[str, Any]] = []

    for index, company in enumerate(companies):
        if index and args.delay > 0:
            time.sleep(args.delay)
        homepage_url = homepages.get(company.symbol)
        try:
            urls = candidate_management_urls(company, homepage_url, timeout=args.timeout, user_agent=args.user_agent)
            profiles, source_url, errors = extract_first_profile_set(
                urls,
                timeout=args.timeout,
                user_agent=args.user_agent,
                min_confidence=args.min_confidence,
            )
            if profiles:
                for profile in profiles:
                    row = row_for_profile(company, profile, status="found")
                    rows.append(row)
                status = {"symbol": company.symbol, "status": "found", "profiles": len(profiles), "source_url": source_url}
            else:
                status = {
                    "symbol": company.symbol,
                    "status": "not_found",
                    "profiles": 0,
                    "source_url": source_url,
                    "error_message": "No management profiles found",
                    "tried_urls": urls[:10],
                    "errors": errors[:5],
                }
                rows.append(row_for_status(company, status))
        except Exception as exc:
            status = {"symbol": company.symbol, "status": "failed", "profiles": 0, "error_message": str(exc)}
            rows.append(row_for_status(company, status))
        statuses.append(status)
        print(json.dumps(status, separators=(",", ":")), flush=True)

    if not args.dry_run:
        if args.output_json:
            write_json(Path(args.output_json), {"statuses": statuses, "profiles": rows})
        if args.output_sql:
            write_d1_sql(Path(args.output_sql), rows, schema_path=Path(args.schema_sql))
    print(f"Processed {len(companies)} companies; extracted {sum(1 for row in rows if row['status'] == 'found')} profile rows")
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


def candidate_management_urls(company: Company, homepage_url: str | None, *, timeout: float, user_agent: str) -> list[str]:
    urls: list[str] = []
    if company.symbol in CURATED_MANAGEMENT_URLS:
        urls.append(CURATED_MANAGEMENT_URLS[company.symbol])
    if homepage_url:
        urls.extend(discover_management_links(homepage_url, timeout=timeout, user_agent=user_agent))
        urls.extend(generated_management_urls(homepage_url))
    return list(dict.fromkeys(url for url in urls if url))[:35]


def discover_management_links(homepage_url: str, *, timeout: float, user_agent: str) -> list[str]:
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
        score = sum(3 for term in MANAGEMENT_TERMS if term in haystack)
        score += sum(1 for term in {"about", "corporate", "team", "people", "directors"} if term in haystack)
        if score:
            scored.append((score, absolute))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [url for _score, url in scored]


def generated_management_urls(homepage_url: str) -> list[str]:
    parsed = urllib.parse.urlparse(homepage_url)
    base = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    return [urllib.parse.urljoin(base, path) for path in GENERATED_PATHS]


def extract_first_profile_set(
    urls: list[str],
    *,
    timeout: float,
    user_agent: str,
    min_confidence: float,
) -> tuple[list[Profile], str, list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    for url in urls:
        try:
            page_html = fetch_html(url, timeout=timeout, user_agent=user_agent)
            profiles = extract_profiles(page_html, url)
            profiles = [profile for profile in profiles if profile.confidence >= min_confidence]
            if profiles:
                return profiles, url, errors
            errors.append({"url": url, "error": "no profiles found"})
        except Exception as exc:
            errors.append({"url": url, "error": str(exc)})
    return [], urls[0] if urls else "", errors


def extract_profiles(page_html: str, source_url: str) -> list[Profile]:
    parser = parse_page(page_html)
    retrieved_at = datetime.now(timezone.utc).isoformat()
    profiles: list[Profile] = []
    profiles.extend(extract_jsonld_profiles(parser, source_url, parser.title, retrieved_at))
    profiles.extend(extract_semantic_profiles(page_html, source_url, parser.title, retrieved_at, parser.images))
    profiles.extend(extract_line_profiles(parser.lines, source_url, parser.title, retrieved_at))
    return dedupe_profiles(profiles)


def extract_jsonld_profiles(parser: PageParser, source_url: str, page_title: str, retrieved_at: str) -> list[Profile]:
    profiles: list[Profile] = []
    for script_type, text in parser.scripts:
        if "ld+json" not in script_type and '"@type"' not in text:
            continue
        for obj in json_objects(text):
            for person in walk_json_people(obj):
                name = clean_text(str(person.get("name") or ""))
                title = clean_text(str(person.get("jobTitle") or person.get("title") or ""))
                bio = clean_text(str(person.get("description") or ""))
                if valid_profile(name, title, bio):
                    evidence = clean_text(" ".join(value for value in [name, title, bio] if value))[:900]
                    profiles.append(
                        make_profile(
                            name,
                            title,
                            bio,
                            source_url,
                            page_title,
                            retrieved_at,
                            evidence,
                            str(person.get("image") or ""),
                            0.88,
                            "json_ld",
                        )
                    )
    return profiles


def json_objects(text: str) -> list[Any]:
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, list) else [obj]
    except Exception:
        return []


def walk_json_people(obj: Any) -> list[dict[str, Any]]:
    people: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        if str(obj.get("@type", "")).lower() == "person" or obj.get("jobTitle"):
            people.append(obj)
        for value in obj.values():
            people.extend(walk_json_people(value))
    elif isinstance(obj, list):
        for item in obj:
            people.extend(walk_json_people(item))
    return people


def extract_semantic_profiles(
    page_html: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
    images: list[str],
) -> list[Profile]:
    profiles: list[Profile] = []
    block_re = re.compile(
        r'<(?P<tag>article|li|div|section)\b(?P<attrs>[^>]*)>(?P<body>.*?)(?=</(?P=tag)>)</(?P=tag)>',
        re.I | re.S,
    )
    for match in block_re.finditer(page_html):
        attrs = match.group("attrs")
        block = match.group("body")
        attr_text = html.unescape(attrs)
        block_text = html_to_text(block)
        if not likely_profile_block(attr_text, block_text):
            continue
        name = extract_name(block_text)
        title = extract_title(block_text)
        if not name or not title:
            continue
        bio = extract_biography(block_text, name, title)
        if not valid_profile(name, title, bio):
            continue
        image = extract_image(block, source_url) or first_absolute_image(images, source_url)
        profiles.append(
            make_profile(
                name,
                title,
                bio,
                source_url,
                page_title,
                retrieved_at,
                block_text[:900],
                image,
                profile_confidence(name, title, bio, block_text),
                "semantic_html",
            )
        )
    return profiles


def extract_line_profiles(lines: list[str], source_url: str, page_title: str, retrieved_at: str) -> list[Profile]:
    cleaned = [clean_text(line) for line in lines if clean_text(line)]
    region = management_region(cleaned)
    profiles: list[Profile] = []
    for index, line in enumerate(region):
        if not NAME_RE.match(line) or not plausible_name(line):
            continue
        nearby = region[index + 1 : index + 8]
        title = next((item for item in nearby if TITLE_RE.search(item) and len(item) <= 160), "")
        if not title:
            continue
        bio_parts = [item for item in nearby if item != title and len(item) > 50][:4]
        bio = clean_text(" ".join(bio_parts))
        evidence = clean_text(" ".join(region[index : index + 8]))[:900]
        if valid_profile(line, title, bio):
            profiles.append(
                make_profile(
                    line,
                    title,
                    bio,
                    source_url,
                    page_title,
                    retrieved_at,
                    evidence,
                    "",
                    profile_confidence(line, title, bio, evidence) - 0.08,
                    "text_context",
                )
            )
    return profiles


def management_region(lines: list[str]) -> list[str]:
    joined = "\n".join(lines).lower()
    starts = [joined.find(term) for term in MANAGEMENT_TERMS if joined.find(term) >= 0]
    if not starts:
        return lines
    start_char = min(starts)
    current = 0
    start_index = 0
    for index, line in enumerate(lines):
        current += len(line) + 1
        if current >= start_char:
            start_index = index
            break
    return lines[start_index : start_index + 220]


def make_profile(
    name: str,
    title: str,
    bio: str,
    source_url: str,
    page_title: str,
    retrieved_at: str,
    evidence: str,
    image: str,
    confidence: float,
    layer: str,
) -> Profile:
    evidence = clean_text(evidence)
    return Profile(
        person_name=clean_text(name),
        title=clean_text(title),
        biography=clean_text(bio),
        appointment_date=extract_first(APPOINTMENT_RE, evidence),
        board_roles=extract_board_roles(title, evidence),
        committee_roles=unique(COMMITTEE_RE.findall(evidence)),
        source_url=source_url,
        page_title=page_title,
        retrieved_at=retrieved_at,
        evidence_text=evidence,
        profile_image_url=image,
        confidence=round(max(0, min(confidence, 0.99)), 3),
        extraction_layer=layer,
    )


def likely_profile_block(attrs: str, text: str) -> bool:
    haystack = f"{attrs} {text}".lower()
    class_hit = bool(re.search(r"\b(?:team|member|person|profile|bio|leader|leadership|management|executive|director|card)\b", attrs, re.I))
    return class_hit and bool(TITLE_RE.search(text)) and any(term in haystack for term in MANAGEMENT_TERMS + ["chief", "president"])


def extract_name(text: str) -> str:
    lines = [line for line in split_text_lines(text) if len(line) <= 90]
    for line in lines[:8]:
        if NAME_RE.match(line) and plausible_name(line):
            return line
    return ""


def extract_title(text: str) -> str:
    lines = split_text_lines(text)
    for line in lines[:12]:
        if TITLE_RE.search(line) and len(line) <= 180 and not NAME_RE.match(line):
            return line
    return ""


def extract_biography(text: str, name: str, title: str) -> str:
    parts = [part for part in split_text_lines(text) if part not in {name, title}]
    bio_parts = [part for part in parts if len(part) > 45]
    return clean_text(" ".join(bio_parts[:6]))


def valid_profile(name: str, title: str, bio: str) -> bool:
    if not plausible_name(name) or not TITLE_RE.search(title):
        return False
    if any(term in name.lower() for term in {"committee", "investor", "contact", "privacy", "subscribe"}):
        return False
    return bool(title or bio)


def profile_confidence(name: str, title: str, bio: str, evidence: str) -> float:
    score = 0.45
    if plausible_name(name):
        score += 0.18
    if TITLE_RE.search(title):
        score += 0.2
    if len(bio) > 100:
        score += 0.1
    if any(term in evidence.lower() for term in MANAGEMENT_TERMS):
        score += 0.06
    return score


def dedupe_profiles(profiles: list[Profile]) -> list[Profile]:
    best: dict[tuple[str, str], Profile] = {}
    for profile in profiles:
        key = (profile.person_name.lower(), profile.title.lower())
        existing = best.get(key)
        if existing is None or profile.confidence + len(profile.biography) / 10000 > existing.confidence + len(existing.biography) / 10000:
            best[key] = profile
    return sorted(best.values(), key=lambda profile: profile.person_name)


def row_for_profile(company: Company, profile: Profile, *, status: str) -> dict[str, Any]:
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "source_url": profile.source_url,
        "page_title": profile.page_title,
        "retrieved_at": profile.retrieved_at,
        "person_name": profile.person_name,
        "title": profile.title,
        "biography": profile.biography,
        "biography_length": len(profile.biography),
        "appointment_date": profile.appointment_date,
        "board_roles_json": json.dumps(profile.board_roles, separators=(",", ":")),
        "committee_roles_json": json.dumps(profile.committee_roles, separators=(",", ":")),
        "profile_image_url": profile.profile_image_url,
        "evidence_text": profile.evidence_text,
        "confidence": profile.confidence,
        "extraction_layer": profile.extraction_layer,
        "status": status,
        "error_message": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def row_for_status(company: Company, status: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "symbol": company.symbol,
        "company_name": company.company_name,
        "short_name": company.short_name,
        "metal": company.metal,
        "company_type": company.company_type,
        "source_url": status.get("source_url") or "",
        "page_title": "",
        "retrieved_at": now,
        "person_name": "",
        "title": "",
        "biography": "",
        "biography_length": 0,
        "appointment_date": "",
        "board_roles_json": "[]",
        "committee_roles_json": "[]",
        "profile_image_url": "",
        "evidence_text": json.dumps(status.get("tried_urls") or [], separators=(",", ":")),
        "confidence": 0,
        "extraction_layer": "status",
        "status": status["status"],
        "error_message": status.get("error_message") or "",
        "created_at": now,
    }


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
        "source_url",
        "page_title",
        "retrieved_at",
        "person_name",
        "title",
        "biography",
        "biography_length",
        "appointment_date",
        "board_roles_json",
        "committee_roles_json",
        "profile_image_url",
        "evidence_text",
        "confidence",
        "extraction_layer",
        "status",
        "error_message",
        "created_at",
    ]
    symbols = sorted({row["symbol"] for row in rows if row.get("symbol")})
    if symbols:
        statements.append(f"DELETE FROM website_management_team WHERE symbol IN ({', '.join(sql_value(symbol) for symbol in symbols)});")
    for row in rows:
        values = ", ".join(sql_value(row.get(column)) for column in columns)
        statements.append(f"INSERT INTO website_management_team ({', '.join(columns)}, updated_at) VALUES ({values}, CURRENT_TIMESTAMP);")
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
    parser = PageParser()
    parser.feed(value)
    lines = [clean_text(line) for line in parser.lines if clean_text(line)]
    return "\n".join(lines)


def split_text_lines(text: str) -> list[str]:
    return [clean_text(line) for line in re.split(r"[\n\r]+| {2,}", text) if clean_text(line)]


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def extract_image(block: str, base_url: str) -> str:
    match = re.search(r"<img[^>]+src=['\"]([^'\"]+)['\"]", block, re.I)
    return urllib.parse.urljoin(base_url, html.unescape(match.group(1))) if match else ""


def first_absolute_image(images: list[str], base_url: str) -> str:
    return urllib.parse.urljoin(base_url, images[0]) if images else ""


def extract_first(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text)
    return clean_text(match.group(0)) if match else ""


def extract_board_roles(title: str, evidence: str) -> list[str]:
    roles = []
    if re.search(r"\bchair(?:man)?\b", title, re.I):
        roles.append("Chair")
    if re.search(r"\bdirector\b", f"{title} {evidence}", re.I):
        roles.append("Director")
    return unique(roles)


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(clean_text(value) for value in values if clean_text(value)))


def plausible_name(value: str) -> bool:
    if not NAME_RE.match(value):
        return False
    words = value.split()
    if len(words) < 2 or len(words) > 5:
        return False
    blocked = {"management", "leadership", "corporate", "investor", "directors", "committee"}
    return not any(word.lower() in blocked for word in words)


def is_same_site(base_url: str, candidate_url: str) -> bool:
    base = urllib.parse.urlparse(base_url).netloc.lower().removeprefix("www.")
    candidate = urllib.parse.urlparse(candidate_url).netloc.lower().removeprefix("www.")
    return bool(base and candidate) and (candidate == base or candidate.endswith(f".{base}") or base.endswith(f".{candidate}"))


def unwanted_url(url: str) -> bool:
    lowered = url.lower()
    return any(term in lowered for term in ["cookie", "privacy", "terms", "contact", "news", "release", ".pdf"])


if __name__ == "__main__":
    raise SystemExit(main())
