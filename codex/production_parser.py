from __future__ import annotations

import html
import os
import re
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from minerlytics.database import connect, ensure_schema


PARSER_VERSION = "production-v2"
DEFAULT_FORMS = {"10-Q", "10-K", "20-F", "40-F", "6-K"}
DEFAULT_USER_AGENT = "Minerlytics/0.1 contact@example.com"
PRODUCTION_LINE_RE = re.compile(
    r"\b(?P<metal>gold|silver)\s+(?:equivalent\s+)?(?:ounces?|ozs?)\s+(?:produced|production|payable\s+production)\b(?P<tail>.*)",
    re.IGNORECASE,
)
PRODUCTION_TABLE_LABEL_RE = re.compile(
    r"^(?P<metal>gold|silver)\s*\(\s*(?P<unit>ounces|ozs?|koz|000\s*oz|thousand\s+ounces|million\s+ounces)\s*\)\s*$",
    re.IGNORECASE,
)
SCALED_PRODUCTION_LABEL_RE = re.compile(
    r"^(?P<label>.*?\b(?P<metal>gold|silver)\s+(?:ounces?|ozs?|production)\s*\((?P<scale>koz|000\s*oz|thousands?|thousand ounces|millions?|million ounces)\).*):?$",
    re.IGNORECASE,
)
PRODUCED_SCALED_RE = re.compile(
    r"^(?:produced\s+)?(?P<metal>gold|silver)\s*(?:produced|production)?\s*\((?P<scale>koz|000\s*oz|million ounces|millions?|thousand ounces|thousands?)\)\s*$",
    re.IGNORECASE,
)
PRODUCED_VALUE_RE = re.compile(r"^produced\b(?P<tail>.*)", re.IGNORECASE)
FOREIGN_PRODUCTION_LABEL_RE = re.compile(
    r"^(?P<label>.*?\b(?P<metal>gold|silver)\b.*?\b(?:production|produced|payable\s+production|ounces?\s+produced|ozs?\s+produced)\b.*?)(?P<tail>(?:\s+[-—$()0-9,.]+)+)$",
    re.IGNORECASE,
)
SIMPLE_PRODUCTION_LABEL_RE = re.compile(
    r"^(?P<label>(?:attributable\s+|payable\s+)?(?P<metal>gold|silver)(?:\s+equivalent)?\s+(?:production|produced|ounces?\s+produced|ozs?\s+produced))$",
    re.IGNORECASE,
)
HIGHLIGHTS_PRODUCTION_RE = re.compile(
    r"\b(?:payable\s+|attributable\s+)?production(?:\s+of)?\s+"
    r"(?P<value>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+"
    r"(?:ounces?|ozs?)\s+of\s+(?P<metal>gold|silver)\b",
    re.IGNORECASE,
)
HIGHLIGHTS_PRODUCED_RE = re.compile(
    r"\bproduced\s+(?P<value>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+"
    r"(?:ounces?|ozs?)\s+of\s+(?P<metal>gold|silver)\b",
    re.IGNORECASE,
)
SCALED_OUNCES_RE = re.compile(
    r"(?P<value>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+"
    r"(?P<scale>million|thousand|m|k)?\s*(?:ounces?|ozs?)\s+of\s+(?P<metal>gold|silver)\b",
    re.IGNORECASE,
)
AIF_AGGREGATE_PRODUCTION_RE = re.compile(
    r"\battributable\s+production\s+of\s+(?P<first>.+?),?\s+led\s+by",
    re.IGNORECASE,
)
AIF_PROJECT_PRODUCTION_RE = re.compile(
    r"\b(?P<metal>gold|silver)\s+production\s+"
    r"(?:from\s+the\s+(?P<mine_before>.+?)\s+mine\s+)?"
    r"(?:\([^)]*\)\s+)?"
    r"of\s+(?P<value>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+"
    r"(?P<scale>million|thousand|m|k)?\s*ounces?"
    r"(?:\s+from\s+the\s+(?P<mine_after>.+?)\s+mine)?",
    re.IGNORECASE,
)
AIF_INCLUDED_PRODUCTION_RE = re.compile(
    r"\battributable\s+(?P<metal>gold|silver)\s+production\s+included\s+"
    r"(?P<value>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+"
    r"(?P<scale>million|thousand|m|k)?\s*ounces?\s+produced\s+from\s+the\s+(?P<mine>.+?)\s+mine\b",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"(?<![\w.])\(?-?\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\)?")
QUARTER_BY_MONTH = {3: "Q1", 6: "Q2", 9: "Q3", 12: "FY"}


@dataclass(frozen=True)
class ProductionRecord:
    symbol: str
    cik: str
    accession_number: str
    form: str
    filing_date: str | None
    report_date: str | None
    fiscal_year: int | None
    fiscal_period: str | None
    period_type: str
    mine_name: str
    metal: str
    ounces_produced: float
    source_url: str | None
    source_text: str
    confidence: float


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"br", "p", "div", "tr", "td", "th", "li", "table", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"p", "div", "tr", "td", "th", "li", "table", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        cleaned = html.unescape(data)
        if cleaned.strip():
            self.parts.append(cleaned)

    def text(self) -> str:
        return "\n".join(self.parts)


def parse_10q_production_to_sqlite(
    *,
    db_path: str | Path,
    symbol: str | None = None,
    accession_number: str | None = None,
    latest_only: bool = False,
    user_agent: str | None = None,
) -> int:
    return parse_production_to_sqlite(
        db_path=db_path,
        symbol=symbol,
        accession_number=accession_number,
        forms={"10-Q"},
        latest_per_form=latest_only,
        user_agent=user_agent,
    )


def parse_production_to_sqlite(
    *,
    db_path: str | Path,
    symbol: str | None = None,
    accession_number: str | None = None,
    forms: set[str] | None = None,
    latest_per_form: bool = False,
    user_agent: str | None = None,
) -> int:
    db = connect(db_path)
    try:
        ensure_schema(db)
        filings = _select_filings(
            db,
            symbol=symbol,
            accession_number=accession_number,
            forms=forms or DEFAULT_FORMS,
            latest_per_form=latest_per_form,
        )
    finally:
        db.close()

    total = 0
    for filing in filings:
        document_url = filing["sec_primary_document_url"]
        document_text = _row_get(filing, "document_text")
        if document_text:
            text = document_text
        elif document_url:
            try:
                text = html_to_text(fetch_sec_document_text(document_url, user_agent=user_agent))
            except Exception:
                continue
        else:
            continue
        records = extract_production_records(filing, text)
        total += store_production_records(db_path=db_path, records=records)
    return total


def fetch_sec_document_text(url: str, *, user_agent: str | None = None) -> str:
    agent = user_agent or os.environ.get("SEC_USER_AGENT") or DEFAULT_USER_AGENT
    request = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": "text/html,*/*"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def html_to_text(document: str) -> str:
    parser = _TextExtractor()
    parser.feed(document)
    raw_text = parser.text()
    lines = []
    for line in raw_text.splitlines():
        cleaned = re.sub(r"\s+", " ", line).strip()
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines)


def extract_production_records(filing: Any, text: str) -> list[ProductionRecord]:
    lines = text.splitlines()
    records: list[ProductionRecord] = []
    fiscal_year, fiscal_period = _period_from_report_date(filing["report_date"])
    records.extend(_records_from_gold_equivalent_annual_table(filing, lines, fiscal_year, fiscal_period))
    records.extend(_records_from_aif_attributable_production(filing, lines, fiscal_year, fiscal_period))
    records.extend(_records_from_production_and_costs_table(filing, lines, fiscal_year, fiscal_period))

    for index, line in enumerate(lines):
        highlights_record = _record_from_highlights_section(filing, lines, index, fiscal_year, fiscal_period)
        if highlights_record:
            records.append(highlights_record)
            continue

        foreign_record = _record_from_foreign_label(filing, lines, index, fiscal_year, fiscal_period)
        if foreign_record:
            records.append(foreign_record)
            continue

        scaled_record = _record_from_scaled_label(filing, lines, index, fiscal_year, fiscal_period)
        if scaled_record:
            records.append(scaled_record)
            continue

        match = PRODUCTION_LINE_RE.search(line)
        table_match = PRODUCTION_TABLE_LABEL_RE.search(line)
        if not match and not table_match:
            continue

        metal = (match or table_match).group("metal").lower()
        if "equivalent" in line.lower():
            continue

        context_lines = _context(lines, index)
        period_context = " ".join(context_lines[-8:]).lower()
        if filing["form"] == "10-Q" and "year ended" in period_context and "three months" not in period_context:
            continue
        if table_match and not _is_production_table_row(lines, index):
            continue

        number_text = _first_number(match.group("tail")) if match else None
        if number_text is None:
            number_text = _first_number(" ".join(lines[index + 1 : index + 8]))
        if number_text is None:
            continue
        if re.fullmatch(r"20\d{2}", number_text):
            continue
        parsed_number = _parse_number(number_text)
        if parsed_number < 100:
            continue
        if table_match:
            parsed_number *= _unit_multiplier(table_match.group("unit"))
        if not _looks_plausible_production_value(metal, parsed_number):
            continue

        mine_name = _mine_name_from_context(context_lines)
        source_text = " | ".join(context_lines[-6:] + [line] + lines[index + 1 : index + 3])
        confidence = 0.9 if "three months" in period_context else 0.65
        if filing["form"] in {"20-F", "40-F"}:
            confidence = max(confidence, 0.75)
        records.append(
            ProductionRecord(
                symbol=filing["symbol"],
                cik=filing["cik"],
                accession_number=filing["accession_number"],
                form=filing["form"],
                filing_date=filing["filing_date"],
                report_date=filing["report_date"],
                fiscal_year=fiscal_year,
                fiscal_period=fiscal_period,
                mine_name=mine_name,
                period_type=_period_type_for_filing(filing),
                metal=metal,
                ounces_produced=parsed_number,
                source_url=filing["sec_primary_document_url"],
                source_text=source_text[:2000],
                confidence=confidence,
            )
        )

    return _dedupe_records(records)


def _records_from_gold_equivalent_annual_table(
    filing: Any,
    lines: list[str],
    fiscal_year: int | None,
    fiscal_period: str | None,
) -> list[ProductionRecord]:
    clean_lines = [_clean_line(line) for line in lines]
    clean_lines = [line for line in clean_lines if line]
    table_start = _find_line_index(
        clean_lines,
        "the following table sets forth the total gold equivalent production (in ounces)",
    )
    if table_start is None:
        return []

    table_end = _find_line_index(clean_lines[table_start + 1 :], "Marketing")
    if table_end is None:
        table_end = min(len(clean_lines), table_start + 80)
    else:
        table_end = table_start + 1 + table_end
    table_lines = clean_lines[table_start:table_end]

    target_year = str(fiscal_year) if fiscal_year else None
    if not target_year:
        years = [line for line in table_lines[:20] if re.fullmatch(r"20\d{2}", line)]
        target_year = years[0] if years else None

    records_by_mine: dict[str, ProductionRecord] = {}
    consolidated_record: ProductionRecord | None = None
    skip_labels = {
        "americas",
        "africa",
        "west africa",
        "north america",
        "south america",
        "mauritania",
        "years ended december 31",
        "table of contents",
    }
    for offset, line in enumerate(table_lines):
        label = line.strip(" :")
        if not label or label.lower() in skip_labels:
            continue
        if re.search(r"\d", label):
            continue
        if "gold equivalent production" in label.lower():
            continue

        values = _production_values_after_label(table_lines, offset)
        if not values:
            continue

        mine_name = "Consolidated" if label.lower() == "total" else _normalize_mine_name(label)
        source_text = (
            "Gold equivalent production table"
            + (f" for {target_year}" if target_year else "")
            + f": {label} = {values[0]:,.0f} ounces"
        )
        record = ProductionRecord(
            symbol=filing["symbol"],
            cik=filing["cik"],
            accession_number=filing["accession_number"],
            form=filing["form"],
            filing_date=filing["filing_date"],
            report_date=filing["report_date"],
            fiscal_year=fiscal_year,
            fiscal_period=fiscal_period,
            mine_name=mine_name,
            period_type=_period_type_for_filing(filing),
            metal="gold",
            ounces_produced=values[0],
            source_url=filing["sec_primary_document_url"],
            source_text=source_text[:2000],
            confidence=0.82,
        )
        if mine_name == "Consolidated":
            consolidated_record = record
        else:
            records_by_mine[mine_name.lower()] = record

    records = list(records_by_mine.values())
    if consolidated_record:
        records.append(consolidated_record)
    return records


def _records_from_aif_attributable_production(
    filing: Any,
    lines: list[str],
    fiscal_year: int | None,
    fiscal_period: str | None,
) -> list[ProductionRecord]:
    records: list[ProductionRecord] = []
    for line in [_clean_line(line) for line in lines]:
        lowered = line.lower()
        if "attributable production of" not in lowered:
            continue
        if "mineral reserves" in lowered or "mineral resources" in lowered:
            continue

        aggregate_match = AIF_AGGREGATE_PRODUCTION_RE.search(line)
        if aggregate_match:
            for value_match in SCALED_OUNCES_RE.finditer(aggregate_match.group("first")):
                records.append(
                    _production_record(
                        filing,
                        fiscal_year,
                        fiscal_period,
                        mine_name="Consolidated",
                        metal=value_match.group("metal").lower(),
                        ounces=_scaled_ounces(value_match.group("value"), value_match.group("scale")),
                        source_text=line,
                        confidence=0.9,
                    )
                )

        for project_match in AIF_PROJECT_PRODUCTION_RE.finditer(line):
            mine_name = project_match.group("mine_before") or project_match.group("mine_after")
            if not mine_name:
                continue
            records.append(
                _production_record(
                    filing,
                    fiscal_year,
                    fiscal_period,
                    mine_name=_normalize_mine_name(mine_name),
                    metal=project_match.group("metal").lower(),
                    ounces=_scaled_ounces(project_match.group("value"), project_match.group("scale")),
                    source_text=line,
                    confidence=0.86,
                )
            )

        for included_match in AIF_INCLUDED_PRODUCTION_RE.finditer(line):
            records.append(
                _production_record(
                    filing,
                    fiscal_year,
                    fiscal_period,
                    mine_name=_normalize_mine_name(included_match.group("mine")),
                    metal=included_match.group("metal").lower(),
                    ounces=_scaled_ounces(included_match.group("value"), included_match.group("scale")),
                    source_text=line,
                    confidence=0.86,
                )
            )
    return [record for record in records if _looks_plausible_production_value(record.metal, record.ounces_produced)]


def _records_from_production_and_costs_table(
    filing: Any,
    lines: list[str],
    fiscal_year: int | None,
    fiscal_period: str | None,
) -> list[ProductionRecord]:
    clean_lines = [_clean_line(line) for line in lines]
    clean_lines = [line for line in clean_lines if line]
    table_start = _find_line_index(clean_lines, "Production and Costs")
    if table_start is None:
        return []
    table_end = _find_line_index(clean_lines[table_start + 1 :], "Notes:")
    if table_end is None:
        table_end = min(len(clean_lines), table_start + 350)
    else:
        table_end = table_start + 1 + table_end

    records: list[ProductionRecord] = []
    table_lines = clean_lines[table_start:table_end]
    header_labels = {"total", "first", "second", "third", "fourth quarter", "quarter", "change"}
    for offset, line in enumerate(table_lines):
        if line.lower() != "gold ounces produced":
            continue
        prior_label = _previous_table_label(table_lines, offset)
        mine_name = "Consolidated" if not prior_label or prior_label.lower() in header_labels else prior_label
        values = _production_values_after_label(table_lines, offset)
        if not values:
            continue
        records.append(
            _production_record(
                filing,
                fiscal_year,
                fiscal_period,
                mine_name=_normalize_mine_name(mine_name),
                metal="gold",
                ounces=values[0],
                source_text=(
                    f"Production and Costs table"
                    + (f" for {fiscal_year}" if fiscal_year else "")
                    + f": {mine_name} gold ounces produced = {values[0]:,.0f}"
                ),
                confidence=0.9,
            )
        )
    return records


def _previous_table_label(lines: list[str], index: int) -> str | None:
    for line in reversed(lines[max(0, index - 12) : index]):
        lowered = line.lower().strip()
        if not lowered or lowered in {"1", "2024", "2025", "2026", "$/oz sold", "($m)"}:
            continue
        if re.fullmatch(r"[-—()0-9,.$]+", line):
            continue
        return line
    return None


def _production_record(
    filing: Any,
    fiscal_year: int | None,
    fiscal_period: str | None,
    *,
    mine_name: str,
    metal: str,
    ounces: float,
    source_text: str,
    confidence: float,
) -> ProductionRecord:
    return ProductionRecord(
        symbol=filing["symbol"],
        cik=filing["cik"],
        accession_number=filing["accession_number"],
        form=filing["form"],
        filing_date=filing["filing_date"],
        report_date=filing["report_date"],
        fiscal_year=fiscal_year,
        fiscal_period=fiscal_period,
        mine_name=mine_name,
        period_type=_period_type_for_filing(filing),
        metal=metal,
        ounces_produced=ounces,
        source_url=filing["sec_primary_document_url"],
        source_text=source_text[:2000],
        confidence=confidence,
    )


def _find_line_index(lines: list[str], needle: str) -> int | None:
    lowered_needle = needle.lower()
    for index, line in enumerate(lines):
        if lowered_needle in line.lower():
            return index
    return None


def _production_values_after_label(lines: list[str], label_index: int) -> list[float]:
    values: list[float] = []
    for line in lines[label_index + 1 : label_index + 8]:
        if line.endswith(":"):
            break
        number = _first_number(line)
        if not number:
            if values:
                break
            continue
        value = _parse_number(number)
        if value < 100:
            continue
        values.append(value)
        if len(values) == 3:
            break
    return values if len(values) >= 1 else []


def _clean_line(line: str) -> str:
    cleaned = line.replace("\u200b", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _record_from_highlights_section(
    filing: Any,
    lines: list[str],
    index: int,
    fiscal_year: int | None,
    fiscal_period: str | None,
) -> ProductionRecord | None:
    if not _is_executive_summary_highlight(lines, index):
        return None

    candidate_text = " ".join(lines[index : index + 4])
    source_text = " | ".join(lines[max(0, index - 4) : index + 4])
    if _reject_highlights_production(candidate_text):
        return None

    match = HIGHLIGHTS_PRODUCTION_RE.search(candidate_text) or HIGHLIGHTS_PRODUCED_RE.search(candidate_text)
    if not match:
        return None

    metal = match.group("metal").lower()
    value = _parse_number(match.group("value"))
    if not _looks_plausible_production_value(metal, value):
        return None

    return ProductionRecord(
        symbol=filing["symbol"],
        cik=filing["cik"],
        accession_number=filing["accession_number"],
        form=filing["form"],
        filing_date=filing["filing_date"],
        report_date=filing["report_date"],
        fiscal_year=fiscal_year,
        fiscal_period=fiscal_period,
        mine_name="Consolidated",
        period_type=_period_type_for_filing(filing),
        metal=metal,
        ounces_produced=value,
        source_url=filing["sec_primary_document_url"],
        source_text=source_text[:2000],
        confidence=0.95,
    )


def _is_executive_summary_highlight(lines: list[str], index: int) -> bool:
    context = " ".join(lines[max(0, index - 18) : index + 1]).lower()
    if "highlights" not in context:
        return False
    if "executive summary" not in " ".join(lines[max(0, index - 60) : index + 1]).lower():
        return False
    after_highlights = context.rfind("highlights")
    after_notes = context.rfind("notes:")
    return after_notes < after_highlights


def _reject_highlights_production(text: str) -> bool:
    lowered = text.lower()
    return any(
        phrase in lowered
        for phrase in [
            "mineral reserves",
            "mineral resources",
            "realized price",
            "all-in sustaining costs",
        ]
    )


def _record_from_scaled_label(
    filing: Any,
    lines: list[str],
    index: int,
    fiscal_year: int | None,
    fiscal_period: str | None,
) -> ProductionRecord | None:
    line = lines[index]
    label_match = SCALED_PRODUCTION_LABEL_RE.search(line)
    produced_scaled_match = PRODUCED_SCALED_RE.search(line)
    if not label_match and not produced_scaled_match:
        return None
    if "equivalent" in line.lower() or "sold" in line.lower():
        return None

    if produced_scaled_match:
        metal = produced_scaled_match.group("metal").lower()
        scale = produced_scaled_match.group("scale").lower()
        number_text = _first_number(" ".join(lines[index + 1 : index + 4]))
        mine_name = "Consolidated"
    else:
        metal = label_match.group("metal").lower()
        scale = label_match.group("scale").lower()
        produced_offset, produced_line = next(
            (
                (offset, candidate)
                for offset, candidate in enumerate(lines[index + 1 : index + 6], start=1)
                if PRODUCED_VALUE_RE.search(candidate)
            ),
            (None, ""),
        )
        produced_match = PRODUCED_VALUE_RE.search(produced_line) if produced_line else None
        number_text = _first_number(produced_match.group("tail") if produced_match else "")
        if number_text is None and produced_offset is not None:
            number_text = _first_number(" ".join(lines[index + produced_offset + 1 : index + produced_offset + 4]))
        mine_name = _clean_scaled_mine_name(label_match.group("label"), metal)

    if number_text is None:
        return None

    multiplier = _scale_multiplier(scale)
    source_text = " | ".join(lines[max(0, index - 4) : index + 6])
    value = _parse_number(number_text) * multiplier
    if not _looks_plausible_production_value(metal, value):
        return None

    return ProductionRecord(
        symbol=filing["symbol"],
        cik=filing["cik"],
        accession_number=filing["accession_number"],
        form=filing["form"],
        filing_date=filing["filing_date"],
        report_date=filing["report_date"],
        fiscal_year=fiscal_year,
        fiscal_period=fiscal_period,
        mine_name=mine_name,
        period_type=_period_type_for_filing(filing),
        metal=metal,
        ounces_produced=value,
        source_url=filing["sec_primary_document_url"],
        source_text=source_text[:2000],
        confidence=0.85,
    )


def _record_from_foreign_label(
    filing: Any,
    lines: list[str],
    index: int,
    fiscal_year: int | None,
    fiscal_period: str | None,
) -> ProductionRecord | None:
    line = lines[index]
    if _reject_production_line(line):
        return None

    match = FOREIGN_PRODUCTION_LABEL_RE.search(line)
    simple_match = SIMPLE_PRODUCTION_LABEL_RE.search(line)
    if not match and not simple_match:
        return None

    if match:
        metal = match.group("metal").lower()
        label = match.group("label")
        number_text = _first_number(match.group("tail"))
    else:
        metal = simple_match.group("metal").lower()
        label = simple_match.group("label")
        number_text = _first_number(" ".join(lines[index + 1 : index + 8]))

    if not number_text:
        return None
    if re.fullmatch(r"20\d{2}", number_text):
        return None

    source_text = " | ".join(lines[max(0, index - 5) : index + 8])
    scale = _scale_from_context(source_text)
    value = _parse_number(number_text) * scale
    if value < 100:
        return None
    if not _looks_plausible_production_value(metal, value):
        return None

    mine_name = _mine_name_from_label_or_context(label, lines[max(0, index - 10) : index])
    confidence = 0.8 if filing["form"] in {"20-F", "40-F", "6-K"} else 0.7
    if "attributable" in label.lower() or "payable" in label.lower():
        confidence += 0.05

    return ProductionRecord(
        symbol=filing["symbol"],
        cik=filing["cik"],
        accession_number=filing["accession_number"],
        form=filing["form"],
        filing_date=filing["filing_date"],
        report_date=filing["report_date"],
        fiscal_year=fiscal_year,
        fiscal_period=fiscal_period,
        mine_name=mine_name,
        period_type=_period_type_for_filing(filing),
        metal=metal,
        ounces_produced=value,
        source_url=filing["sec_primary_document_url"],
        source_text=source_text[:2000],
        confidence=min(confidence, 0.9),
    )


def store_production_records(*, db_path: str | Path, records: list[ProductionRecord]) -> int:
    if not records:
        return 0
    run_at = datetime.now(UTC).isoformat()
    db = connect(db_path)
    try:
        ensure_schema(db)
        with db:
            db.executemany(
                """
                insert into production
                    (
                        symbol, cik, accession_number, form, filing_date, report_date,
                        fiscal_year, fiscal_period, period_type, mine_name, metal,
                        ounces_produced, unit, source_url, source_text, parser_version,
                        confidence, created_at, updated_at
                    )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ounces', ?, ?, ?, ?, ?, ?)
                on conflict(symbol, accession_number, mine_name, metal, report_date)
                do update set
                    ounces_produced = excluded.ounces_produced,
                    source_url = excluded.source_url,
                    source_text = excluded.source_text,
                    parser_version = excluded.parser_version,
                    confidence = excluded.confidence,
                    updated_at = excluded.updated_at
                """,
                [
                    (
                        record.symbol,
                        record.cik,
                        record.accession_number,
                        record.form,
                        record.filing_date,
                        record.report_date,
                        record.fiscal_year,
                        record.fiscal_period,
                        record.period_type,
                        record.mine_name,
                        record.metal,
                        record.ounces_produced,
                        record.source_url,
                        record.source_text,
                        PARSER_VERSION,
                        record.confidence,
                        run_at,
                        run_at,
                    )
                    for record in records
                ],
            )
    finally:
        db.close()
    return len(records)


def _select_filings(
    db: Any,
    *,
    symbol: str | None,
    accession_number: str | None,
    forms: set[str],
    latest_per_form: bool,
) -> list[Any]:
    params: list[Any] = []
    form_placeholders = ",".join("?" for _ in forms)
    params.extend(sorted(forms))
    where = [f"form in ({form_placeholders})", "sec_primary_document_url is not null"]
    exhibit_where = [f"source_form in ({form_placeholders})", "import_status = 'imported'", "text_length > 0"]
    exhibit_params = list(sorted(forms))
    document_where = [f"source_form in ({form_placeholders})", "import_status = 'imported'", "text_length > 0"]
    document_params = list(sorted(forms))
    if symbol:
        where.append("symbol = ?")
        params.append(symbol.strip().upper())
        exhibit_where.append("symbol = ?")
        exhibit_params.append(symbol.strip().upper())
        document_where.append("symbol = ?")
        document_params.append(symbol.strip().upper())
    if accession_number:
        where.append("accession_number = ?")
        params.append(accession_number)
        exhibit_where.append("accession_number = ?")
        exhibit_params.append(accession_number)
        document_where.append("accession_number = ?")
        document_params.append(accession_number)

    latest_filter = ""
    exhibit_latest_filter = ""
    document_latest_filter = ""
    if latest_per_form:
        latest_filter = """
            and filing_date = (
                select max(f2.filing_date)
                from edgar_forty_f_reports f2
                where f2.symbol = edgar_forty_f_reports.symbol
                  and f2.form = edgar_forty_f_reports.form
            )
        """
        exhibit_latest_filter = """
            and filing_date = (
                select max(e2.filing_date)
                from edgar_filing_exhibits e2
                where e2.symbol = edgar_filing_exhibits.symbol
                  and e2.source_form = edgar_filing_exhibits.source_form
                  and e2.import_status = 'imported'
                  and e2.text_length > 0
            )
        """
        document_latest_filter = """
            and filing_date = (
                select max(d2.filing_date)
                from edgar_filing_documents d2
                where d2.symbol = edgar_filing_documents.symbol
                  and d2.source_form = edgar_filing_documents.source_form
                  and d2.import_status = 'imported'
                  and d2.text_length > 0
            )
        """
    return db.execute(
        f"""
        select symbol, cik, accession_number, form, filing_date, report_date,
               sec_primary_document_url, null as document_text
        from edgar_forty_f_reports
        where {" and ".join(where)}
        {latest_filter}
        union all
        select symbol, cik, accession_number, source_form as form, filing_date, report_date,
               document_url as sec_primary_document_url, text_content as document_text
        from edgar_filing_exhibits
        where {" and ".join(exhibit_where)}
          and ({_exhibit_99_3_sql("document_name")})
        {exhibit_latest_filter}
        union all
        select symbol, cik, accession_number, source_form as form, filing_date, report_date,
               document_url as sec_primary_document_url, text_content as document_text
        from edgar_filing_documents
        where {" and ".join(document_where)}
          and (
              {_exhibit_99_3_sql("document_name")}
              or document_type in ('annual_information_form', 'management_discussion_analysis')
          )
          and not exists (
              select 1
              from edgar_filing_exhibits legacy
              where legacy.symbol = edgar_filing_documents.symbol
                and legacy.accession_number = edgar_filing_documents.accession_number
                and legacy.document_name = edgar_filing_documents.document_name
                and legacy.import_status = 'imported'
                and legacy.text_length > 0
          )
        {document_latest_filter}
        order by filing_date desc
        """,
        params + exhibit_params + document_params,
    ).fetchall()


def _exhibit_99_3_sql(column_name: str) -> str:
    return f"""
        lower({column_name}) like '%99-1%'
        or lower({column_name}) like '%99_1%'
        or lower({column_name}) like '%991%'
        or lower({column_name}) like '%99d1%'
        or lower({column_name}) like '%99-3%'
        or lower({column_name}) like '%99_3%'
        or lower({column_name}) like '%993%'
        or lower({column_name}) like '%99d3%'
        or lower({column_name}) like '%aif%'
        or lower({column_name}) like '%mda%'
    """


def _row_get(row: Any, key: str) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


def _select_10q_filings(
    db: Any,
    *,
    symbol: str | None,
    accession_number: str | None,
    latest_only: bool,
) -> list[Any]:
    return _select_filings(
        db,
        symbol=symbol,
        accession_number=accession_number,
        forms={"10-Q"},
        latest_per_form=latest_only,
    )


def _context(lines: list[str], index: int) -> list[str]:
    return lines[max(0, index - 18) : index]


def _is_production_table_row(lines: list[str], index: int) -> bool:
    prior = " ".join(lines[max(0, index - 10) : index]).lower()
    following = " ".join(lines[index + 1 : index + 8]).lower()
    if "payable metal quantities sold" in prior:
        return False
    if "ore grades" in prior:
        return False
    return (
        "production:" in prior
        or "production summary" in prior
        or "operating results" in prior
        or "tons of ore milled" in prior
        or "lead (tons)" in following
        or "ounces produced" in following
    )


def _first_number(text: str) -> str | None:
    for match in NUMBER_RE.finditer(text):
        value = match.group(1)
        if value in {"0", "1", "2", "3"}:
            continue
        return value
    return None


def _parse_number(value: str) -> float:
    return float(value.replace(",", ""))


def _scale_multiplier(scale: str) -> float:
    lowered = scale.lower()
    if "million" in lowered:
        return 1_000_000.0
    if "thousand" in lowered or "koz" in lowered or "000" in lowered:
        return 1_000.0
    return 1.0


def _scaled_ounces(value: str, scale: str | None) -> float:
    multiplier = _scale_multiplier(scale or "")
    if scale and scale.lower() == "m":
        multiplier = 1_000_000.0
    if scale and scale.lower() == "k":
        multiplier = 1_000.0
    return _parse_number(value) * multiplier


def _unit_multiplier(unit: str | None) -> float:
    return _scale_multiplier(unit or "")


def _scale_from_context(text: str) -> float:
    lowered = text.lower()
    if re.search(r"\b(million ounces|moz)\b", lowered):
        return 1_000_000.0
    if re.search(r"\b(koz|000 oz|thousand ounces|in thousands|000s)\b", lowered):
        return 1_000.0
    return 1.0


def _clean_scaled_mine_name(label: str, metal: str) -> str:
    cleaned = re.sub(
        rf"\b{metal}\s+ounces?\s*\([^)]*\)",
        "",
        label,
        flags=re.IGNORECASE,
    ).strip(" :-")
    return cleaned or "Consolidated"


def _mine_name_from_label_or_context(label: str, context_lines: list[str]) -> str:
    cleaned = re.sub(
        r"\b(?:attributable|payable)?\s*(?:gold|silver)(?:\s+equivalent)?\s+(?:production|produced|ounces?\s+produced|ozs?\s+produced)\b",
        "",
        label,
        flags=re.IGNORECASE,
    ).strip(" :-")
    if _looks_like_mine_name(cleaned):
        return _normalize_mine_name(cleaned)
    return _mine_name_from_context(context_lines)


def _mine_name_from_context(context_lines: list[str]) -> str:
    stop_words = {
        "operating results",
        "three months ended",
        "six months ended",
        "nine months ended",
        "twelve months ended",
        "production",
        "sales",
    }
    for line in reversed(context_lines):
        lowered = line.lower().strip(":")
        if any(stop in lowered for stop in stop_words):
            continue
        if len(line) > 80 or re.search(r"\d", line):
            continue
        if _looks_like_mine_name(line):
            return _normalize_mine_name(line.strip(":"))
    return "Consolidated"


def _normalize_mine_name(value: str) -> str:
    return re.sub(
        r",\s*(?:United States|USA|Canada|Mexico|Argentina|Australia|Ghana|Peru|Chile|Brazil|South Africa)\.?$",
        "",
        value.strip(),
        flags=re.IGNORECASE,
    )


def _looks_like_mine_name(value: str) -> bool:
    lowered = value.lower().strip(":")
    if not value or len(value) > 90 or re.search(r"\d", value):
        return False
    if any(
        token in lowered
        for token in [
            "revenue",
            "income",
            "loss",
            "cash flow",
            "capital expenditure",
            "guidance",
            "risk",
            "results of operations",
            "expressed in thousands",
            "life of mine",
            "waste mined",
            "global project pipeline",
            "due to",
            "as the company",
            "owned and operated",
            "took over the mine",
            "the capital of",
            "attributable",
        ]
    ):
        return False
    return bool(
        re.search(
            r"(mine|project|complex|district|operations|united states|mexico|canada|argentina|nevada|alaska|idaho|peru|ghana|australia|south africa|brazil|chile)",
            lowered,
        )
    )


def _reject_production_line(line: str) -> bool:
    lowered = line.lower()
    if re.search(r"\bfirst\s+(?:gold|silver)\s+produced\b", lowered):
        return True
    if re.search(r"\bcommercial\s+production\s+of\s+(?:gold|silver)\b", lowered):
        return True
    if re.search(r"\b(?:expected|expects|estimated|forecast|guidance|average annual)\b", lowered):
        return True
    return any(
        token in lowered
        for token in [
            "sold",
            "sale",
            "cash cost",
            "aisc",
            "acre",
            "hectare",
            "tailings",
            "throughput",
            "reserve",
            "derivative",
            "took over the mine",
            "reserves",
            "resources",
            "contained",
            "price",
            "revenue",
            "royalty",
            "by-product",
            "equivalent",
            "commercial levels of production",
        ]
    )


def _period_type_for_filing(filing: Any) -> str:
    if filing["form"] in {"10-K", "20-F", "40-F"}:
        return "annual"
    return "quarter"


def _looks_plausible_production_value(metal: str, value: float) -> bool:
    if value < 100:
        return False
    if metal == "gold":
        return value <= 20_000_000
    if metal == "silver":
        return value <= 500_000_000
    return True


def _period_from_report_date(report_date: str | None) -> tuple[int | None, str | None]:
    if not report_date:
        return (None, None)
    try:
        year, month, _day = [int(part) for part in report_date.split("-")]
    except ValueError:
        return (None, None)
    return (year, QUARTER_BY_MONTH.get(month))


def _dedupe_records(records: list[ProductionRecord]) -> list[ProductionRecord]:
    seen: set[tuple[str, str, str, str, str | None]] = set()
    deduped: list[ProductionRecord] = []
    for record in records:
        key = (
            record.symbol,
            record.accession_number,
            record.mine_name.lower(),
            record.metal,
            record.report_date,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(record)
    return deduped
