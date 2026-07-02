#!/usr/bin/env python3
"""Export the local Minerlytics SQLite production table into Cloudflare D1 SQL.

This keeps the D1 production table in the same shape used by the Worker endpoint
/api/company-production and the company page Key Health Measures accordion.
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

COLUMNS = [
    "symbol",
    "cik",
    "accession_number",
    "form",
    "filing_date",
    "report_date",
    "fiscal_year",
    "fiscal_period",
    "period_type",
    "mine_name",
    "metal",
    "ounces_produced",
    "unit",
    "source_url",
    "source_text",
    "parser_version",
    "confidence",
    "created_at",
    "updated_at",
]


def sql_value(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def export_production(db_path: Path, output_sql: Path) -> int:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            f"""
            SELECT {', '.join(COLUMNS)}
            FROM production
            ORDER BY symbol, report_date, filing_date, metal, mine_name, id
            """
        ).fetchall()
    finally:
        db.close()

    lines = [
        "-- Current Minerlytics production table export for Cloudflare D1.",
        "PRAGMA foreign_keys = OFF;",
        "DELETE FROM production;",
    ]
    for row in rows:
        values = ", ".join(sql_value(row[column]) for column in COLUMNS)
        lines.append(f"INSERT INTO production ({', '.join(COLUMNS)}) VALUES ({values});")
    lines.append("PRAGMA foreign_keys = ON;")

    output_sql.parent.mkdir(parents=True, exist_ok=True)
    output_sql.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export production rows to a D1 import SQL file.")
    parser.add_argument("--db-path", required=True, help="Path to the source Minerlytics SQLite database")
    parser.add_argument("--output-sql", default="data/production_d1_import.sql", help="Output SQL file")
    args = parser.parse_args()

    count = export_production(Path(args.db_path).expanduser(), Path(args.output_sql))
    print(f"Exported {count} production rows to {args.output_sql}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
