CREATE TABLE IF NOT EXISTS Website_mine_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  company_name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  metal TEXT NOT NULL DEFAULT '',
  company_type TEXT NOT NULL DEFAULT '',
  homepage_url TEXT,
  mine_name TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  project_url TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT NOT NULL DEFAULT '',
  description_text TEXT NOT NULL DEFAULT '',
  ownership TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  mining_style TEXT NOT NULL DEFAULT '',
  measured_indicated_mineral_resources TEXT NOT NULL DEFAULT '',
  inferred_mineral_resources TEXT NOT NULL DEFAULT '',
  geology_text TEXT NOT NULL DEFAULT '',
  technical_report_names_json TEXT NOT NULL DEFAULT '[]',
  technical_report_urls_json TEXT NOT NULL DEFAULT '[]',
  evidence_text TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  extraction_method TEXT NOT NULL DEFAULT '',
  extraction_layer TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '',
  status_code TEXT NOT NULL DEFAULT 'found'
    CHECK (status_code IN ('found', 'not_found', 'failed')),
  error_message TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(symbol, source_url, project_name, extraction_layer)
);

CREATE INDEX IF NOT EXISTS idx_website_mine_details_symbol
  ON Website_mine_details(symbol, status_code, confidence);

CREATE INDEX IF NOT EXISTS idx_website_mine_details_project
  ON Website_mine_details(symbol, project_name);

CREATE INDEX IF NOT EXISTS idx_website_mine_details_checked_at
  ON Website_mine_details(checked_at DESC);
