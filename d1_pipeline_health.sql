CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  workflow_file TEXT NOT NULL,
  workflow_name TEXT,
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_seconds INTEGER,
  github_run_id TEXT,
  github_run_url TEXT,
  branch TEXT,
  commit_sha TEXT,
  message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_job_finished
  ON pipeline_runs (job_name, finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
  ON pipeline_runs (status, conclusion);

CREATE TABLE IF NOT EXISTS pipeline_checks (
  id TEXT PRIMARY KEY,
  check_name TEXT NOT NULL,
  category TEXT NOT NULL,
  target_name TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  row_count INTEGER,
  latest_data_at TEXT,
  freshness_hours REAL,
  threshold_hours REAL,
  message TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_checks_status
  ON pipeline_checks (status, severity);

CREATE INDEX IF NOT EXISTS idx_pipeline_checks_checked_at
  ON pipeline_checks (checked_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT NOT NULL,
  sent_to TEXT,
  sent_at TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pipeline_alerts_open
  ON pipeline_alerts (resolved_at, severity, created_at DESC);
