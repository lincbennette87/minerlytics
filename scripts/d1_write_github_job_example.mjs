import fs from "node:fs";
import path from "node:path";

const outputFile = process.argv[2] || ".tmp/d1-github-job-example.sql";

function sqlString(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const now = new Date().toISOString();
const runId = requiredEnv("GITHUB_RUN_ID");
const workflowName = process.env.GITHUB_WORKFLOW || "D1 GitHub job write example";
const jobName = process.env.GITHUB_JOB || "write-example";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
const repository = requiredEnv("GITHUB_REPOSITORY");
const branch = process.env.GITHUB_REF_NAME || "";
const commitSha = process.env.GITHUB_SHA || "";
const id = `${repository}:${workflowName}:${jobName}:${runId}:${runAttempt}`;

const payload = {
  message: "This row was written from a GitHub Actions workflow into Cloudflare D1.",
  sampleTicker: process.env.SAMPLE_TICKER || "AEM",
  sampleCategory: process.env.SAMPLE_CATEGORY || "gold",
  source: "github_actions_d1_example",
  generatedAt: now
};

const statements = [
  `CREATE TABLE IF NOT EXISTS github_job_runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    job_name TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_attempt TEXT,
    repository TEXT NOT NULL,
    branch TEXT,
    commit_sha TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE INDEX IF NOT EXISTS idx_github_job_runs_completed_at
    ON github_job_runs (completed_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_github_job_runs_repository
    ON github_job_runs (repository, workflow_name);`,
  `INSERT OR REPLACE INTO github_job_runs (
    id,
    workflow_name,
    job_name,
    run_id,
    run_attempt,
    repository,
    branch,
    commit_sha,
    status,
    started_at,
    completed_at,
    payload_json
  ) VALUES (
    ${sqlString(id)},
    ${sqlString(workflowName)},
    ${sqlString(jobName)},
    ${sqlString(runId)},
    ${sqlString(runAttempt)},
    ${sqlString(repository)},
    ${sqlString(branch)},
    ${sqlString(commitSha)},
    'success',
    ${sqlString(now)},
    ${sqlString(now)},
    ${sqlString(JSON.stringify(payload))}
  );`
];

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${statements.join("\n\n")}\n`);
console.log(`Wrote D1 SQL example to ${outputFile}`);
