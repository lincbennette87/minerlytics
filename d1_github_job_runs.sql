CREATE TABLE IF NOT EXISTS github_job_runs (
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
);

CREATE INDEX IF NOT EXISTS idx_github_job_runs_completed_at
ON github_job_runs (completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_job_runs_repository
ON github_job_runs (repository, workflow_name);
