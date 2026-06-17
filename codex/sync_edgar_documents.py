#!/usr/bin/env python3
"""Synchronize SEC EDGAR metadata, facts, filings, and filing documents.

This is the integrated EDGAR ingestion entry point for Minerlytics. It prepares
the local document universe that downstream parsers use for production, AISC,
project locations, and economic analysis.

Typical workflow:
    1. Refresh the SEC ticker-to-CIK map.
    2. Sync companyfacts and filing metadata for each miner.
    3. Discover relevant documents from each filing's EDGAR index.json.
    4. Extract text and store documents in edgar_filing_documents.
    5. Backfill existing exhibit tables so current parsers continue to work.

Examples:
    python scripts/sync_edgar_documents.py PAAS --forms 40-F --limit-filings-per-symbol 1
    python scripts/sync_edgar_documents.py --all-miners --forms 6-K 40-F 20-F 10-K --limit-filings-per-symbol 3
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from minerlytics.connectors.edgar import (
    DEFAULT_FACTS,
    EdgarError,
    discover_sec_filings,
    refresh_company_ticker_map,
    sync_company_facts_to_sqlite,
)
from minerlytics.connectors.ex96_importer import (
    DEFAULT_USER_AGENT,
    EX96_RE,
    POTENTIAL_TECHNICAL_EXHIBIT_RE,
    TECHNICAL_REPORT_TEXT_RE,
    extract_text,
)
from minerlytics.database import DEFAULT_DB_PATH, active_miner_symbols, connect, ensure_schema, seed_miner_tickers


DOCUMENT_EXTENSIONS = (".htm", ".html", ".pdf", ".txt", ".xml")
TITLE_CANDIDATE_EXTENSIONS = (".htm", ".html", ".pdf", ".txt")
DEFAULT_FORMS = {"6-K", "40-F", "20-F", "10-K", "10-Q", "8-K"}
TITLE_CANDIDATE_SKIP_RE = re.compile(
    r"^(?:r\d+|filingsummary|metalinks|show|report)\.(?:htm|html|xml|json|js|css)$",
    re.IGNORECASE,
)
GENERAL_EXHIBIT_RE = re.compile(
    r"(^|[/_.-])(?:ex|exh|exhibit)[-_.]?\d|dex\d|_ex\d|ex99|ex-99|ex_99|ex\d+d\d",
    re.IGNORECASE,
)
AIF_MDA_RE = re.compile(r"(^|[-_.])(aif|mda)([-_.]|$)", re.IGNORECASE)
EXHIBIT_NUMBER_RE = re.compile(
    r"(?:ex|exh|exhibit|dex)?[-_.]?(?P<number>\d{1,3})(?:[-_.d](?P<suffix>\d+))?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class FilingDocument:
    name: str
    url: str
    document_type: str
    exhibit_number: str | None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Synchronize EDGAR filing metadata, company facts, and relevant filing documents."
    )
    parser.add_argument("symbols", nargs="*", help="Ticker symbols to sync, for example PAAS KGC AEM")
    parser.add_argument("--all-miners", action="store_true", help="Sync every active miner in mining_companies")
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH), help="SQLite database path")
    parser.add_argument("--forms", nargs="*", default=sorted(DEFAULT_FORMS), help="SEC forms to discover/import")
    parser.add_argument("--facts", nargs="*", default=DEFAULT_FACTS, help="US-GAAP companyfacts to store")
    parser.add_argument("--skip-facts", action="store_true", help="Skip companyfacts API sync")
    parser.add_argument("--skip-filings", action="store_true", help="Skip SEC submissions filing metadata sync")
    parser.add_argument("--skip-documents", action="store_true", help="Skip filing document discovery/import")
    parser.add_argument("--include-primary", action="store_true", help="Also import primary filing documents")
    parser.add_argument("--limit-filings", type=int, help="Maximum number of filings to scan after filtering")
    parser.add_argument(
        "--limit-filings-per-symbol",
        type=int,
        help="Maximum number of recent filings to scan per symbol and form set",
    )
    parser.add_argument(
        "--document-regex",
        help="Optional case-insensitive filename regex to further filter imported documents",
    )
    parser.add_argument(
        "--title-prefixes",
        nargs="*",
        help=(
            "Optional document title prefixes to keep after text extraction, for example "
            "'Annual Information Form' 'Management Discussion and Analysis'."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-import documents even if text already exists locally",
    )
    parser.add_argument(
        "--user-agent",
        default=os.environ.get("SEC_USER_AGENT"),
        help="SEC-required User-Agent, for example 'Minerlytics admin@example.com'",
    )
    args = parser.parse_args()

    db_path = Path(args.db_path)
    forms = {form.upper() for form in args.forms}
    document_regex = re.compile(args.document_regex, re.IGNORECASE) if args.document_regex else None

    db = connect(db_path)
    try:
        ensure_schema(db)
        ensure_document_title_column(db)
        seed_miner_tickers(db)
        symbols = active_miner_symbols(db) if args.all_miners else [symbol.upper() for symbol in args.symbols]
    finally:
        db.close()

    if not symbols:
        parser.error("provide one or more symbols, or use --all-miners")

    # Step 1: Refresh ticker-to-CIK mapping so downstream SEC API calls use current identifiers.
    mapped = refresh_company_ticker_map(db_path=db_path, user_agent=args.user_agent)
    print(f"Refreshed SEC ticker map with {mapped} tickers")

    facts_synced = 0
    filings_synced = 0
    document_stats = {"scanned": 0, "imported": 0, "skipped": 0, "failed": 0}
    for symbol in symbols:
        # Step 2: Store structured SEC companyfacts before document parsing begins.
        if not args.skip_facts:
            try:
                status, count = sync_company_facts_to_sqlite(
                    db_path=db_path,
                    symbol=symbol,
                    fact_names=args.facts,
                    user_agent=args.user_agent,
                )
                facts_synced += count
                print(f"{symbol}: companyfacts {status} ({count} facts)")
            except EdgarError as exc:
                print(f"{symbol}: companyfacts failed: {exc}")

        # Step 3: Store filing metadata from SEC submissions so index URLs are locally queryable.
        if not args.skip_filings:
            count = discover_sec_filings(
                db_path=db_path,
                symbol=symbol,
                forms=forms,
                user_agent=args.user_agent,
            )
            filings_synced += count
            print(f"{symbol}: discovered {count} filings")
            time.sleep(0.12)

        # Step 4: Discover, classify, extract, and store filing documents in the shared table.
        if not args.skip_documents:
            stats = sync_documents_for_symbol(
                db_path=db_path,
                symbol=symbol,
                forms=forms,
                include_primary=args.include_primary,
                limit=args.limit_filings,
                limit_per_symbol=args.limit_filings_per_symbol,
                document_regex=document_regex,
                title_prefixes=args.title_prefixes or [],
                force=args.force,
                user_agent=args.user_agent,
            )
            for key, value in stats.items():
                document_stats[key] += value
            print(
                f"{symbol}: scanned {stats['scanned']} filings, "
                f"imported {stats['imported']} documents, skipped {stats['skipped']}, failed {stats['failed']}"
            )

    print(f"Facts synced: {facts_synced}")
    print(f"Filings synced: {filings_synced}")
    print(
        "Documents: "
        f"scanned {document_stats['scanned']} filings, "
        f"imported {document_stats['imported']}, "
        f"skipped {document_stats['skipped']}, "
        f"failed {document_stats['failed']}"
    )
    return 1 if document_stats["failed"] else 0


def sync_documents_for_symbol(
    *,
    db_path: str | Path,
    symbol: str,
    forms: set[str],
    include_primary: bool,
    limit: int | None,
    limit_per_symbol: int | None,
    document_regex: re.Pattern[str] | None,
    title_prefixes: list[str],
    force: bool,
    user_agent: str | None,
) -> dict[str, int]:
    db = connect(db_path)
    try:
        ensure_schema(db)
        ensure_document_title_column(db)
        filings = _select_filings(
            db,
            symbol=symbol,
            forms=forms,
            limit=limit,
            limit_per_symbol=limit_per_symbol,
        )
    finally:
        db.close()

    stats = {"scanned": 0, "imported": 0, "skipped": 0, "failed": 0}
    for filing in filings:
        stats["scanned"] += 1
        try:
            documents = discover_filing_documents(
                filing,
                include_primary=include_primary,
                document_regex=document_regex,
                include_title_candidates=bool(title_prefixes),
                user_agent=user_agent,
            )
        except Exception:
            stats["failed"] += 1
            continue

        for document in documents:
            if not force and _already_imported(db_path=db_path, filing=filing, document_name=document.name):
                stats["skipped"] += 1
                continue
            imported = store_document(
                db_path=db_path,
                filing=filing,
                document=document,
                title_prefixes=title_prefixes,
                user_agent=user_agent,
            )
            stats["imported"] += imported
    return stats


def discover_filing_documents(
    filing: Any,
    *,
    include_primary: bool,
    document_regex: re.Pattern[str] | None,
    include_title_candidates: bool,
    user_agent: str | None,
) -> list[FilingDocument]:
    index_url = filing["sec_filing_url"].rstrip("/") + "/index.json"
    payload = _fetch_bytes(index_url, user_agent=user_agent)
    index = json.loads(payload.decode("utf-8"))
    documents: list[FilingDocument] = []
    base_url = filing["sec_filing_url"]
    primary_name = _row_get(filing, "primary_document")

    for item in index.get("directory", {}).get("item", []):
        name = item.get("name", "")
        if not name or not name.lower().endswith(DOCUMENT_EXTENSIONS):
            continue
        if document_regex and not document_regex.search(name):
            continue

        document_type = classify_document_name(
            name,
            primary_name=primary_name,
            include_primary=include_primary,
            base_url=base_url,
            user_agent=user_agent,
        )
        if document_type is None:
            if (
                not include_title_candidates
                or not name.lower().endswith(TITLE_CANDIDATE_EXTENSIONS)
                or TITLE_CANDIDATE_SKIP_RE.search(name)
            ):
                continue
            document_type = "document_candidate"
        documents.append(
            FilingDocument(
                name=name,
                url=base_url + name,
                document_type=document_type,
                exhibit_number=extract_exhibit_number(name),
            )
        )
    return documents


def classify_document_name(
    name: str,
    *,
    primary_name: str | None,
    include_primary: bool,
    base_url: str,
    user_agent: str | None,
) -> str | None:
    lowered = name.lower()
    if include_primary and primary_name and lowered == primary_name.lower():
        return "primary_filing"
    if EX96_RE.search(name):
        return "technical_report"
    if _looks_like_technical_report_document(name, base_url=base_url, user_agent=user_agent):
        return "technical_report"
    if AIF_MDA_RE.search(name):
        return "annual_information_form" if "aif" in lowered else "management_discussion_analysis"
    if re.search(r"99[-_.d]?1|991", lowered):
        return "exhibit_99_1"
    if re.search(r"99[-_.d]?3|993", lowered):
        return "exhibit_99_3"
    if GENERAL_EXHIBIT_RE.search(name):
        return "exhibit"
    return None


def store_document(
    *,
    db_path: str | Path,
    filing: Any,
    document: FilingDocument,
    title_prefixes: list[str],
    user_agent: str | None,
) -> int:
    run_at = datetime.now(UTC).isoformat()
    try:
        payload = _fetch_bytes(document.url, user_agent=user_agent)
        content_type = _content_type(document.name, payload)
        text = extract_text(exhibit_name=document.name, payload=payload, content_type=content_type)
        document_title = extract_document_title(text, fallback_name=document.name)
        document_type = classify_document_title(document_title) or document.document_type
        if title_prefixes and not title_starts_with(document_title, title_prefixes):
            return 0
        status = "imported"
        error_message = None
    except Exception as exc:
        payload = b""
        content_type = _content_type(document.name, payload)
        text = ""
        document_title = None
        document_type = document.document_type
        status = "failed"
        error_message = str(exc)

    db = connect(db_path)
    try:
        ensure_schema(db)
        ensure_document_title_column(db)
        with db:
            # Step 5: Store the normalized document row that future parsers should query.
            db.execute(
                """
                insert into edgar_filing_documents
                    (
                        symbol, cik, source_form, accession_number, filing_date,
                        report_date, document_name, document_url, document_type,
                        document_title, exhibit_number, content_type, text_content, text_length,
                        import_status, error_message, imported_at, created_at, updated_at
                    )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(symbol, accession_number, document_name)
                do update set
                    cik = excluded.cik,
                    source_form = excluded.source_form,
                    filing_date = excluded.filing_date,
                    report_date = excluded.report_date,
                    document_url = excluded.document_url,
                    document_type = excluded.document_type,
                    document_title = excluded.document_title,
                    exhibit_number = excluded.exhibit_number,
                    content_type = excluded.content_type,
                    text_content = excluded.text_content,
                    text_length = excluded.text_length,
                    import_status = excluded.import_status,
                    error_message = excluded.error_message,
                    imported_at = excluded.imported_at,
                    updated_at = excluded.updated_at
                """,
                (
                    filing["symbol"],
                    filing["cik"],
                    filing["form"],
                    filing["accession_number"],
                    filing["filing_date"],
                    filing["report_date"],
                    document.name,
                    document.url,
                    document_type,
                    document_title,
                    document.exhibit_number,
                    content_type,
                    text,
                    len(text),
                    status,
                    error_message,
                    run_at,
                    run_at,
                    run_at,
                ),
            )

            # Step 6: Backfill legacy exhibit tables while parsers are transitioned to the shared table.
            legacy_document = FilingDocument(
                name=document.name,
                url=document.url,
                document_type=document_type,
                exhibit_number=document.exhibit_number,
            )
            if document_type == "technical_report":
                _upsert_legacy_ex96(db, filing=filing, document=legacy_document, content_type=content_type, text=text, status=status, error_message=error_message, run_at=run_at)
            elif document_type != "primary_filing":
                _upsert_legacy_filing_exhibit(db, filing=filing, document=legacy_document, content_type=content_type, text=text, status=status, error_message=error_message, run_at=run_at)
    finally:
        db.close()
    return 1


def ensure_document_title_column(db: Any) -> None:
    columns = {row["name"] for row in db.execute("pragma table_info(edgar_filing_documents)").fetchall()}
    if "document_title" not in columns:
        db.execute("alter table edgar_filing_documents add column document_title text")


def extract_document_title(text: str, *, fallback_name: str) -> str | None:
    cleaned_lines = []
    for raw_line in text.splitlines()[:120]:
        line = re.sub(r"\s+", " ", raw_line).strip(" :-\t")
        if not line:
            continue
        cleaned_lines.append(line)
        normalized = normalize_title(line)
        if normalized.startswith("annual information form"):
            return line[:300]
        if normalized.startswith("management discussion and analysis"):
            return line[:300]
    for line in cleaned_lines:
        if len(line) < 4 or re.fullmatch(r"\d+", line):
            continue
        if re.fullmatch(r"ex[-.\s]?\d+(?:\.\d+)?", line, flags=re.IGNORECASE):
            continue
        if line.lower() in {"table of contents", "exhibit", "document"}:
            continue
        if line.lower() == Path(fallback_name).name.lower():
            continue
        return line[:300]
    return Path(fallback_name).name


def classify_document_title(title: str | None) -> str | None:
    normalized = normalize_title(title or "")
    if normalized.startswith("annual information form"):
        return "annual_information_form"
    if normalized.startswith("management discussion and analysis"):
        return "management_discussion_analysis"
    return None


def title_starts_with(title: str | None, prefixes: list[str]) -> bool:
    normalized_title = normalize_title(title or "")
    return any(normalized_title.startswith(normalize_title(prefix)) for prefix in prefixes)


def normalize_title(value: str) -> str:
    normalized = value.lower().replace("’", "'")
    normalized = normalized.replace("management's", "management")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _select_filings(
    db: Any,
    *,
    symbol: str,
    forms: set[str],
    limit: int | None,
    limit_per_symbol: int | None,
) -> list[Any]:
    placeholders = ",".join("?" for _ in forms)
    params: list[Any] = [*sorted(forms), symbol.strip().upper()]
    if limit_per_symbol is not None:
        params.append(limit_per_symbol)
        return db.execute(
            f"""
            select symbol, cik, form, accession_number, filing_date, report_date,
                   sec_filing_url, primary_document
            from (
                select symbol, cik, form, accession_number, filing_date, report_date,
                       sec_filing_url, primary_document,
                       row_number() over (
                           partition by symbol
                           order by filing_date desc, accession_number desc
                       ) as filing_rank
                from edgar_forty_f_reports
                where form in ({placeholders})
                  and symbol = ?
                  and sec_filing_url is not null
            )
            where filing_rank <= ?
            order by filing_date desc, accession_number desc
            """,
            params,
        ).fetchall()

    limit_sql = ""
    if limit is not None:
        limit_sql = " limit ?"
        params.append(limit)
    return db.execute(
        f"""
        select symbol, cik, form, accession_number, filing_date, report_date,
               sec_filing_url, primary_document
        from edgar_forty_f_reports
        where form in ({placeholders})
          and symbol = ?
          and sec_filing_url is not null
        order by filing_date desc, accession_number desc
        {limit_sql}
        """,
        params,
    ).fetchall()


def _already_imported(*, db_path: str | Path, filing: Any, document_name: str) -> bool:
    db = connect(db_path)
    try:
        ensure_schema(db)
        row = db.execute(
            """
            select 1
            from edgar_filing_documents
            where symbol = ?
              and accession_number = ?
              and document_name = ?
              and import_status = 'imported'
              and text_length > 0
            """,
            (filing["symbol"], filing["accession_number"], document_name),
        ).fetchone()
        return row is not None
    finally:
        db.close()


def _looks_like_technical_report_document(name: str, *, base_url: str, user_agent: str | None) -> bool:
    if not POTENTIAL_TECHNICAL_EXHIBIT_RE.search(name):
        return False
    try:
        sample = _fetch_sample(base_url + name, user_agent=user_agent)
    except Exception:
        return False
    lowered = sample.decode("utf-8", errors="replace").lower()
    has_report_marker = bool(re.search(r"\b(?:ex|exhibit)[-. ]?96\b", lowered))
    has_report_structure = "table of contents" in lowered and "executive summary" in lowered
    return bool(TECHNICAL_REPORT_TEXT_RE.search(lowered) and (has_report_marker or has_report_structure))


def extract_exhibit_number(name: str) -> str | None:
    lowered = Path(name).stem.lower()
    if not re.search(r"(?:^|[-_.])(ex|exh|exhibit|dex)", lowered):
        return None
    match = EXHIBIT_NUMBER_RE.search(lowered)
    if not match:
        return None
    number = match.group("number")
    suffix = match.group("suffix")
    return f"{int(number)}.{int(suffix)}" if suffix else str(int(number))


def _upsert_legacy_filing_exhibit(
    db: Any,
    *,
    filing: Any,
    document: FilingDocument,
    content_type: str,
    text: str,
    status: str,
    error_message: str | None,
    run_at: str,
) -> None:
    db.execute(
        """
        insert into edgar_filing_exhibits
            (
                symbol, cik, source_form, accession_number, filing_date,
                report_date, document_name, document_url, content_type,
                text_content, text_length, import_status, error_message,
                imported_at, created_at, updated_at
            )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(symbol, accession_number, document_name)
        do update set
            cik = excluded.cik,
            source_form = excluded.source_form,
            filing_date = excluded.filing_date,
            report_date = excluded.report_date,
            document_url = excluded.document_url,
            content_type = excluded.content_type,
            text_content = excluded.text_content,
            text_length = excluded.text_length,
            import_status = excluded.import_status,
            error_message = excluded.error_message,
            imported_at = excluded.imported_at,
            updated_at = excluded.updated_at
        """,
        (
            filing["symbol"],
            filing["cik"],
            filing["form"],
            filing["accession_number"],
            filing["filing_date"],
            filing["report_date"],
            document.name,
            document.url,
            content_type,
            text,
            len(text),
            status,
            error_message,
            run_at,
            run_at,
            run_at,
        ),
    )


def _upsert_legacy_ex96(
    db: Any,
    *,
    filing: Any,
    document: FilingDocument,
    content_type: str,
    text: str,
    status: str,
    error_message: str | None,
    run_at: str,
) -> None:
    db.execute(
        """
        insert into edgar_ex96_documents
            (
                symbol, cik, source_form, accession_number, filing_date,
                report_date, exhibit_name, exhibit_url, content_type,
                text_content, text_length, import_status, error_message,
                imported_at, created_at, updated_at
            )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(symbol, accession_number, exhibit_name)
        do update set
            cik = excluded.cik,
            source_form = excluded.source_form,
            filing_date = excluded.filing_date,
            report_date = excluded.report_date,
            exhibit_url = excluded.exhibit_url,
            content_type = excluded.content_type,
            text_content = excluded.text_content,
            text_length = excluded.text_length,
            import_status = excluded.import_status,
            error_message = excluded.error_message,
            imported_at = excluded.imported_at,
            updated_at = excluded.updated_at
        """,
        (
            filing["symbol"],
            filing["cik"],
            filing["form"],
            filing["accession_number"],
            filing["filing_date"],
            filing["report_date"],
            document.name,
            document.url,
            content_type,
            text,
            len(text),
            status,
            error_message,
            run_at,
            run_at,
            run_at,
        ),
    )


def _fetch_bytes(url: str, *, user_agent: str | None = None) -> bytes:
    agent = user_agent or os.environ.get("SEC_USER_AGENT") or DEFAULT_USER_AGENT
    request = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def _fetch_sample(url: str, *, user_agent: str | None = None, size: int = 250_000) -> bytes:
    agent = user_agent or os.environ.get("SEC_USER_AGENT") or DEFAULT_USER_AGENT
    request = urllib.request.Request(
        url,
        headers={"User-Agent": agent, "Accept": "*/*", "Range": f"bytes=0-{size - 1}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(size)


def _content_type(name: str, payload: bytes) -> str:
    lowered = name.lower()
    if lowered.endswith(".pdf") or payload.startswith(b"%PDF"):
        return "pdf"
    if lowered.endswith((".htm", ".html")) or b"<html" in payload[:1000].lower():
        return "html"
    if lowered.endswith(".xml"):
        return "xml"
    if lowered.endswith(".txt"):
        return "text"
    return "binary" if payload else "unknown"


def _row_get(row: Any, key: str) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


if __name__ == "__main__":
    raise SystemExit(main())
