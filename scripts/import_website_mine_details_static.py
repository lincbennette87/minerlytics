#!/usr/bin/env python3
"""Convert committed website mine details JSON into D1 import SQL."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path


COLUMNS = [
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
    "updated_at",
]


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def report_values(row, key):
    values = []
    for item in row.get("ni43101Reports") or []:
        if isinstance(item, dict):
            value = item.get(key) or item.get("url" if key == "href" else "name")
        else:
            value = str(item) if key != "href" else ""
        if value:
            values.append(value)
    return json.dumps(values, ensure_ascii=False)


def row_values(symbol, row, timestamp):
    project_name = row.get("projectName") or ""
    return {
        "symbol": symbol,
        "company_name": row.get("companyName") or "",
        "short_name": "",
        "metal": "",
        "company_type": "",
        "homepage_url": row.get("homepageUrl") or "",
        "mine_name": project_name,
        "project_name": project_name,
        "project_url": row.get("projectUrl") or "",
        "source_url": row.get("sourceUrl") or row.get("projectUrl") or "",
        "page_title": row.get("pageTitle") or "",
        "retrieved_at": row.get("retrievedAt") or "",
        "description_text": row.get("description") or "",
        "ownership": row.get("ownership") or "",
        "location": row.get("location") or "",
        "status": row.get("status") or "",
        "mining_style": row.get("miningStyle") or "",
        "measured_indicated_mineral_resources": row.get("miResources") or "",
        "inferred_mineral_resources": row.get("inferredResources") or "",
        "geology_text": row.get("geologySummary") or "",
        "technical_report_names_json": report_values(row, "name"),
        "technical_report_urls_json": report_values(row, "href"),
        "evidence_text": row.get("evidenceText") or "",
        "confidence": row.get("confidence") or 0,
        "extraction_method": "website_mine_details_static_import",
        "extraction_layer": row.get("extractionLayer") or "static_import",
        "raw_json": json.dumps(row, ensure_ascii=False, sort_keys=True),
        "status_code": "found",
        "error_message": None,
        "checked_at": timestamp,
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def parse_symbols(raw):
    return {item.strip().upper() for item in (raw or "").split(",") if item.strip()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-json", default="website-mine-details.json")
    parser.add_argument("--schema-sql", default="d1_website_mine_details.sql")
    parser.add_argument("--output-sql", required=True)
    parser.add_argument("--symbols", default="")
    args = parser.parse_args()

    payload = json.loads(Path(args.input_json).read_text())
    projects_by_symbol = payload.get("projectsBySymbol") or {}
    selected = parse_symbols(args.symbols)
    symbols = sorted(sym for sym in projects_by_symbol if not selected or sym in selected)
    if not symbols:
        raise SystemExit("No matching symbols found in website mine details JSON")

    timestamp = dt.datetime.now(dt.timezone.utc).isoformat()
    statements = [Path(args.schema_sql).read_text()]
    statements.append(
        "DELETE FROM Website_mine_details WHERE symbol IN ("
        + ", ".join(sql_value(symbol) for symbol in symbols)
        + ");"
    )

    inserted = 0
    for symbol in symbols:
        for row in projects_by_symbol.get(symbol) or []:
            values = row_values(symbol, row, timestamp)
            statements.append(
                f"INSERT INTO Website_mine_details ({', '.join(COLUMNS)}) VALUES ("
                + ", ".join(sql_value(values[column]) for column in COLUMNS)
                + ");"
            )
            inserted += 1

    Path(args.output_sql).write_text("\n".join(statements) + "\n")
    print(f"Wrote {inserted} Website_mine_details rows for {len(symbols)} symbols to {args.output_sql}")


if __name__ == "__main__":
    main()
