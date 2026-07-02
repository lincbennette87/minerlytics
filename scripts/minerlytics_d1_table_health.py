#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TABLE_CHECKS = [
    {
        "table": "daily_ohlcv",
        "category": "market",
        "latest_column": "date",
        "threshold_hours": 36,
        "label": "Market history",
    },
    {
        "table": "news_items",
        "category": "news",
        "latest_column": "published_at",
        "threshold_hours": 72,
        "label": "RSS/news items",
    },
    {
        "table": "rss_news",
        "category": "news",
        "latest_column": "published_at",
        "threshold_hours": 72,
        "label": "RSS feed",
    },
    {
        "table": "youtube_videos",
        "category": "youtube",
        "latest_column": "published_at",
        "threshold_hours": 24 * 7,
        "label": "YouTube videos",
    },
    {
        "table": "youtube_transcripts",
        "category": "youtube",
        "latest_column": "created_at",
        "threshold_hours": 24 * 14,
        "label": "YouTube transcripts",
    },
    {
        "table": "youtube_segments",
        "category": "youtube",
        "latest_column": "created_at",
        "threshold_hours": 24 * 14,
        "label": "YouTube segments",
    },
    {
        "table": "company_homepages",
        "category": "company_web",
        "latest_column": "checked_at",
        "threshold_hours": 72,
        "label": "Company homepages",
    },
    {
        "table": "website_project_portfolio",
        "category": "company_web",
        "latest_column": "retrieved_at",
        "threshold_hours": 24 * 14,
        "label": "Website project portfolio",
    },
    {
        "table": "website_management_team",
        "category": "company_web",
        "latest_column": "retrieved_at",
        "threshold_hours": 24 * 7,
        "label": "Website management team",
    },
    {
        "table": "website_investor_news",
        "category": "company_web",
        "latest_column": "published_at",
        "threshold_hours": 24 * 7,
        "label": "Website investor news",
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert Wrangler D1 table query results into pipeline health SQL.")
    parser.add_argument("--input-dir", required=True, help="Directory containing one JSON/error file per table")
    parser.add_argument("--output-sql", required=True)
    parser.add_argument("--summary-json")
    parser.add_argument("--notify-telegram", action="store_true", help="Send Telegram alert when secrets are present")
    args = parser.parse_args()

    checked_at = utc_now()
    rows = [build_check(check, Path(args.input_dir), checked_at) for check in TABLE_CHECKS]
    sql = "\n\n".join(build_check_insert(row) for row in rows).strip() + "\n"

    output_path = Path(args.output_sql)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(sql, encoding="utf-8")
    print(f"Wrote D1 table health SQL to {output_path}")

    summary = {
        "checked_at": checked_at,
        "total_tables": len(rows),
        "fresh": sum(1 for row in rows if row["status"] == "fresh"),
        "empty": sum(1 for row in rows if row["status"] == "empty"),
        "stale": sum(1 for row in rows if row["status"] == "stale"),
        "missing_or_failed": sum(1 for row in rows if row["status"] == "failed"),
        "checks": rows,
    }
    if args.summary_json:
        summary_path = Path(args.summary_json)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.notify_telegram:
        alerts = [row for row in rows if row["severity"] in {"warning", "critical"}]
        if alerts:
            send_telegram_alert(alerts, summary)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


def build_check(config: dict[str, Any], input_dir: Path, checked_at: str) -> dict[str, Any]:
    table = config["table"]
    error_path = input_dir / f"{table}.err"
    json_path = input_dir / f"{table}.json"
    row_count = None
    latest_data_at = None
    status = "failed"
    severity = "critical"
    message = f"{config['label']} check failed."

    error_text = error_path.read_text(encoding="utf-8", errors="replace").strip() if error_path.exists() else ""
    if error_text:
        message = f"{config['label']} table could not be queried. {error_text[:500]}"
    elif json_path.exists():
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
            result = first_result_row(payload)
            row_count = integer_or_none(result.get("row_count"))
            latest_data_at = normalize_latest(result.get("latest_data_at"))
            status, severity, message = classify_table(config, row_count, latest_data_at, checked_at)
        except Exception as exc:
            message = f"{config['label']} query output could not be parsed: {exc}"
    else:
        message = f"No query output was captured for {config['label']}."

    freshness = hours_since(latest_data_at, checked_at) if latest_data_at else None
    return {
        "id": stable_id("check", "d1", table),
        "check_name": f"{config['label']} D1 table",
        "category": config["category"],
        "target_name": table,
        "status": status,
        "severity": severity,
        "row_count": row_count,
        "latest_data_at": latest_data_at,
        "freshness_hours": freshness,
        "threshold_hours": float(config["threshold_hours"]),
        "message": message,
        "checked_at": checked_at,
    }


def classify_table(config: dict[str, Any], row_count: int | None, latest_data_at: str | None, checked_at: str) -> tuple[str, str, str]:
    label = config["label"]
    threshold = float(config["threshold_hours"])
    if row_count is None:
        return "failed", "critical", f"{label} row count is unavailable."
    if row_count == 0:
        return "empty", "critical", f"{label} table exists but has no rows."
    if not latest_data_at:
        return "warning", "warning", f"{label} has {row_count} rows but no latest timestamp was found."
    freshness = hours_since(latest_data_at, checked_at)
    if freshness is not None and freshness > threshold:
        return "stale", "warning", f"{label} has {row_count} rows, but latest data is {freshness:.1f} hours old."
    return "fresh", "info", f"{label} is healthy with {row_count} rows."


def first_result_row(payload: Any) -> dict[str, Any]:
    if isinstance(payload, list) and payload:
        first = payload[0]
        if isinstance(first, dict) and isinstance(first.get("results"), list) and first["results"]:
            return first["results"][0]
    if isinstance(payload, dict):
        if isinstance(payload.get("result"), list) and payload["result"]:
            result = payload["result"][0]
            if isinstance(result, dict) and isinstance(result.get("results"), list) and result["results"]:
                return result["results"][0]
        if isinstance(payload.get("results"), list) and payload["results"]:
            return payload["results"][0]
    raise ValueError("No D1 result row found")


def build_check_insert(row: dict[str, Any]) -> str:
    columns = [
        "id",
        "check_name",
        "category",
        "target_name",
        "status",
        "severity",
        "row_count",
        "latest_data_at",
        "freshness_hours",
        "threshold_hours",
        "message",
        "checked_at",
    ]
    assignments = ",\n    ".join(f"{column} = excluded.{column}" for column in columns if column != "id")
    return f"""INSERT INTO pipeline_checks ({", ".join(columns)}, created_at, updated_at)
VALUES ({", ".join(sql_value(row.get(column)) for column in columns)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
    {assignments},
    updated_at = CURRENT_TIMESTAMP;"""


def send_telegram_alert(alerts: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or ""
    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or ""
    if not token or not chat_id:
        print("Telegram secrets not set; skipping D1 table phone notification.")
        return

    lines = [
        "Minerlytics D1 Data Feed Alert",
        f"Checked: {summary['checked_at']}",
        "",
    ]
    for alert in alerts[:12]:
        lines.append(f"- {alert['severity'].upper()}: {alert['target_name']} - {alert['message']}")
    if len(alerts) > 12:
        lines.append(f"- Plus {len(alerts) - 12} more table alerts.")

    payload = urllib.parse.urlencode({"chat_id": chat_id, "text": "\n".join(lines)}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        print(f"Telegram D1 notification status: {response.status}")


def stable_id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:24]


def sql_value(value: Any) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def integer_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_latest(value: Any) -> str | None:
    if value is None or value == "":
        return None
    text = str(value)
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return f"{text}T00:00:00Z"
    return text


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def hours_since(value: str | None, checked_at: str) -> float | None:
    then = parse_time(value)
    now = parse_time(checked_at)
    if not then or not now:
        return None
    return round(max(0.0, (now - then).total_seconds() / 3600), 2)


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
