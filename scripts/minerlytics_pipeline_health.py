#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKFLOWS = [
    {
        "name": "Refresh Market History",
        "file": "refresh-market-history.yml",
        "category": "market",
        "threshold_hours": 30,
        "feeds": "daily_ohlcv",
    },
    {
        "name": "Refresh RSS News",
        "file": "refresh-rss-news.yml",
        "category": "news",
        "threshold_hours": 30,
        "feeds": "rss/news tables",
    },
    {
        "name": "Ingest YouTube Channel Transcripts",
        "file": "ingest-youtube-channel-transcripts.yml",
        "category": "youtube",
        "threshold_hours": 96,
        "feeds": "youtube_videos/youtube_segments/youtube_transcripts",
    },
    {
        "name": "EDGAR",
        "file": "edgar.yml",
        "category": "sec",
        "threshold_hours": 24 * 75,
        "feeds": "SEC/EDGAR disclosures",
    },
    {
        "name": "Sync Company Homepages",
        "file": "sync-company-homepages.yml",
        "category": "company_web",
        "threshold_hours": 36,
        "feeds": "company_homepages",
    },
    {
        "name": "Sync Website Project Portfolio",
        "file": "sync-website-project-portfolio.yml",
        "category": "company_web",
        "threshold_hours": 24 * 10,
        "feeds": "website_project_portfolio",
    },
    {
        "name": "Sync Website Management Team",
        "file": "sync-website-management-team.yml",
        "category": "company_web",
        "threshold_hours": 36,
        "feeds": "website_management_team",
    },
    {
        "name": "Sync Website Investor News",
        "file": "sync-website-investor-news.yml",
        "category": "company_web",
        "threshold_hours": 36,
        "feeds": "website_investor_news",
    },
]


@dataclass
class HealthResult:
    sql: str
    summary: dict[str, Any]
    alerts: list[dict[str, str]]


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Minerlytics GitHub Actions health and emit D1 SQL.")
    parser.add_argument("--output-sql", required=True, help="SQL file to write")
    parser.add_argument("--summary-json", help="Optional summary JSON output")
    parser.add_argument("--branch", default=os.environ.get("GITHUB_REF_NAME") or "main")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY") or "")
    parser.add_argument("--github-token", default=os.environ.get("GITHUB_TOKEN") or "")
    parser.add_argument("--server-url", default=os.environ.get("GITHUB_SERVER_URL") or "https://github.com")
    parser.add_argument("--notify-telegram", action="store_true", help="Send Telegram alert when secrets are present")
    args = parser.parse_args()

    if not args.repo:
        raise SystemExit("Missing GitHub repository. Set GITHUB_REPOSITORY or pass --repo owner/name.")
    if not args.github_token:
        raise SystemExit("Missing GitHub token. Set GITHUB_TOKEN.")

    result = build_health_result(
        repo=args.repo,
        token=args.github_token,
        branch=args.branch,
        server_url=args.server_url,
    )

    output_path = Path(args.output_sql)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result.sql, encoding="utf-8")
    print(f"Wrote pipeline health SQL to {output_path}")

    if args.summary_json:
        summary_path = Path(args.summary_json)
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(result.summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Wrote pipeline health summary to {summary_path}")

    if args.notify_telegram and result.alerts:
        send_telegram_alert(result.alerts, result.summary)

    print(json.dumps(result.summary, indent=2, sort_keys=True))
    return 0


def build_health_result(*, repo: str, token: str, branch: str, server_url: str) -> HealthResult:
    checked_at = utc_now()
    run_rows = []
    check_rows = []
    alerts = []

    for workflow in WORKFLOWS:
        latest_runs = fetch_workflow_runs(repo, workflow["file"], token, branch=branch, per_page=10)
        latest_run = latest_runs[0] if latest_runs else None
        latest_success = next((run for run in latest_runs if run.get("conclusion") == "success"), None)

        if latest_run:
            run_rows.append(build_run_row(workflow, latest_run, branch))

        check = build_workflow_check(workflow, latest_run, latest_success, checked_at)
        check_rows.append(check)
        if check["severity"] in {"warning", "critical"}:
            alerts.append(
                {
                    "severity": check["severity"],
                    "title": f"{workflow['name']} needs attention",
                    "message": check["message"],
                    "source": "github_actions",
                }
            )

    statements = [
        build_run_insert(row)
        for row in run_rows
    ]
    statements.extend(build_check_insert(row) for row in check_rows)
    statements.extend(build_alert_insert(alert, checked_at) for alert in alerts)

    summary = {
        "checked_at": checked_at,
        "branch": branch,
        "repo": repo,
        "total_workflows": len(WORKFLOWS),
        "healthy": sum(1 for row in check_rows if row["status"] == "fresh"),
        "warnings": sum(1 for row in check_rows if row["severity"] == "warning"),
        "critical": sum(1 for row in check_rows if row["severity"] == "critical"),
        "alerts": alerts,
        "admin_page_next_phase": "/admin-health.html",
    }

    return HealthResult(sql="\n\n".join(statements).strip() + "\n", summary=summary, alerts=alerts)


def fetch_workflow_runs(repo: str, workflow_file: str, token: str, *, branch: str, per_page: int) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode({"branch": branch, "per_page": str(per_page)})
    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow_file}/runs?{query}"
    data = github_json(url, token)
    return data.get("workflow_runs") or []


def github_json(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Minerlytics-Health-Check",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API failed for {url}: HTTP {exc.code} {body[:500]}") from exc


def build_run_row(workflow: dict[str, Any], run: dict[str, Any], branch: str) -> dict[str, Any]:
    started_at = run.get("run_started_at") or run.get("created_at")
    finished_at = run.get("updated_at")
    conclusion = run.get("conclusion") or ""
    status = "success" if conclusion == "success" else "failed" if conclusion in {"failure", "timed_out", "cancelled", "action_required"} else run.get("status") or "unknown"
    duration_seconds = duration_between(started_at, finished_at)
    run_id = str(run.get("id") or "")
    return {
        "id": stable_id("run", workflow["file"], run_id),
        "job_name": workflow["name"],
        "workflow_file": workflow["file"],
        "workflow_name": run.get("name") or workflow["name"],
        "status": status,
        "conclusion": conclusion or None,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": duration_seconds,
        "github_run_id": run_id,
        "github_run_url": run.get("html_url"),
        "branch": branch,
        "commit_sha": (run.get("head_sha") or "")[:40],
        "message": run.get("display_title") or "",
    }


def build_workflow_check(
    workflow: dict[str, Any],
    latest_run: dict[str, Any] | None,
    latest_success: dict[str, Any] | None,
    checked_at: str,
) -> dict[str, Any]:
    threshold = float(workflow["threshold_hours"])
    if not latest_run:
        return {
            "id": stable_id("check", "workflow", workflow["file"]),
            "check_name": f"{workflow['name']} latest run",
            "category": workflow["category"],
            "target_name": workflow["file"],
            "status": "empty",
            "severity": "critical",
            "row_count": None,
            "latest_data_at": None,
            "freshness_hours": None,
            "threshold_hours": threshold,
            "message": f"No GitHub Actions runs were found for {workflow['file']}.",
            "checked_at": checked_at,
        }

    latest_conclusion = latest_run.get("conclusion")
    latest_success_at = latest_success.get("updated_at") if latest_success else None
    freshness = hours_since(latest_success_at, checked_at) if latest_success_at else None

    if latest_conclusion in {"failure", "timed_out", "action_required"}:
        status = "failed"
        severity = "critical"
        message = f"Latest run failed for {workflow['name']}. Feeds: {workflow['feeds']}."
    elif latest_conclusion == "cancelled":
        status = "warning"
        severity = "warning"
        message = f"Latest run was cancelled for {workflow['name']}. Feeds: {workflow['feeds']}."
    elif freshness is None:
        status = "empty"
        severity = "critical"
        message = f"No successful run found for {workflow['name']}. Feeds: {workflow['feeds']}."
    elif freshness > threshold:
        status = "stale"
        severity = "warning"
        message = f"Last successful {workflow['name']} run is {freshness:.1f} hours old. Threshold: {threshold:.1f} hours."
    else:
        status = "fresh"
        severity = "info"
        message = f"{workflow['name']} is healthy. Last success was {freshness:.1f} hours ago."

    return {
        "id": stable_id("check", "workflow", workflow["file"]),
        "check_name": f"{workflow['name']} latest run",
        "category": workflow["category"],
        "target_name": workflow["file"],
        "status": status,
        "severity": severity,
        "row_count": None,
        "latest_data_at": latest_success_at,
        "freshness_hours": freshness,
        "threshold_hours": threshold,
        "message": message,
        "checked_at": checked_at,
    }


def send_telegram_alert(alerts: list[dict[str, str]], summary: dict[str, Any]) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or ""
    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or ""
    if not token or not chat_id:
        print("Telegram secrets not set; skipping phone notification.")
        return

    lines = [
        "Minerlytics Health Alert",
        f"Repo: {summary['repo']}",
        f"Checked: {summary['checked_at']}",
        "",
    ]
    for alert in alerts[:12]:
        lines.append(f"- {alert['severity'].upper()}: {alert['title']} - {alert['message']}")
    if len(alerts) > 12:
        lines.append(f"- Plus {len(alerts) - 12} more alerts.")

    payload = urllib.parse.urlencode({"chat_id": chat_id, "text": "\n".join(lines)}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        print(f"Telegram notification status: {response.status}")


def build_run_insert(row: dict[str, Any]) -> str:
    columns = [
        "id",
        "job_name",
        "workflow_file",
        "workflow_name",
        "status",
        "conclusion",
        "started_at",
        "finished_at",
        "duration_seconds",
        "github_run_id",
        "github_run_url",
        "branch",
        "commit_sha",
        "message",
    ]
    assignments = ",\n    ".join(f"{column} = excluded.{column}" for column in columns if column != "id")
    return f"""INSERT INTO pipeline_runs ({", ".join(columns)}, created_at, updated_at)
VALUES ({", ".join(sql_value(row.get(column)) for column in columns)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
    {assignments},
    updated_at = CURRENT_TIMESTAMP;"""


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


def build_alert_insert(alert: dict[str, str], checked_at: str) -> str:
    alert_id = stable_id("alert", alert["source"], alert["title"])
    return f"""INSERT INTO pipeline_alerts (id, severity, title, message, source, sent_to, sent_at, resolved_at, created_at, updated_at)
VALUES ({sql_value(alert_id)}, {sql_value(alert["severity"])}, {sql_value(alert["title"])}, {sql_value(alert["message"])}, {sql_value(alert["source"])}, NULL, {sql_value(checked_at)}, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
    severity = excluded.severity,
    message = excluded.message,
    sent_at = excluded.sent_at,
    resolved_at = NULL,
    updated_at = CURRENT_TIMESTAMP;"""


def stable_id(*parts: str) -> str:
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()
    return digest[:24]


def sql_value(value: Any) -> str:
    if value is None or value == "":
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def duration_between(start: str | None, end: str | None) -> int | None:
    started = parse_time(start)
    finished = parse_time(end)
    if not started or not finished:
        return None
    return max(0, int((finished - started).total_seconds()))


def hours_since(value: str | None, checked_at: str) -> float | None:
    then = parse_time(value)
    now = parse_time(checked_at)
    if not then or not now:
        return None
    return round(max(0.0, (now - then).total_seconds() / 3600), 2)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
