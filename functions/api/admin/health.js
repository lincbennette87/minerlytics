export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const configuredKey = env.ADMIN_HEALTH_KEY || "";
    if (!configuredKey) {
      return json(
        {
          ok: false,
          setupRequired: true,
          error: "ADMIN_HEALTH_KEY is not configured in Cloudflare Pages environment variables.",
        },
        503
      );
    }

    const url = new URL(request.url);
    const providedKey =
      request.headers.get("x-admin-key") ||
      url.searchParams.get("key") ||
      "";

    if (providedKey !== configuredKey) {
      return json({ ok: false, error: "Unauthorized admin health request." }, 401);
    }

    if (!env.DB) {
      return json({ ok: false, error: "DB binding missing." }, 500);
    }

    const checks = await all(
      env.DB.prepare(`
        SELECT
          id,
          check_name,
          category,
          target_name,
          status,
          severity,
          row_count,
          latest_data_at,
          freshness_hours,
          threshold_hours,
          message,
          checked_at,
          updated_at
        FROM pipeline_checks
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 0
            WHEN 'warning' THEN 1
            ELSE 2
          END,
          category,
          check_name
      `)
    );

    const runs = await all(
      env.DB.prepare(`
        SELECT
          id,
          job_name,
          workflow_file,
          workflow_name,
          status,
          conclusion,
          started_at,
          finished_at,
          duration_seconds,
          github_run_id,
          github_run_url,
          branch,
          commit_sha,
          message,
          updated_at
        FROM pipeline_runs
        ORDER BY COALESCE(finished_at, updated_at, created_at) DESC
        LIMIT 40
      `)
    );

    const alerts = await all(
      env.DB.prepare(`
        SELECT
          id,
          severity,
          title,
          message,
          source,
          sent_to,
          sent_at,
          resolved_at,
          created_at,
          updated_at
        FROM pipeline_alerts
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT 40
      `)
    );

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: buildSummary(checks, runs, alerts),
      checks,
      runs,
      alerts,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: "Could not load Minerlytics health data.",
        message: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
}

function buildSummary(checks, runs, alerts) {
  const critical = checks.filter((check) => check.severity === "critical").length;
  const warning = checks.filter((check) => check.severity === "warning").length;
  const healthy = checks.filter((check) => check.status === "fresh").length;
  const failedRuns = runs.filter((run) => ["failed", "failure", "timed_out"].includes(run.status) || run.conclusion === "failure").length;
  const openAlerts = alerts.filter((alert) => !alert.resolved_at).length;

  let overall = "healthy";
  if (critical || failedRuns) overall = "critical";
  else if (warning || openAlerts) overall = "warning";

  const latestCheckAt = checks
    .map((check) => check.checked_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    overall,
    totalChecks: checks.length,
    healthy,
    warning,
    critical,
    totalRuns: runs.length,
    failedRuns,
    openAlerts,
    latestCheckAt,
  };
}

async function all(statement) {
  const result = await statement.all();
  return result?.results || [];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
