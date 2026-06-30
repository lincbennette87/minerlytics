CREATE TABLE IF NOT EXISTS website_project_portfolio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  company_name TEXT NOT NULL,
  short_name TEXT,
  metal TEXT,
  company_type TEXT,
  project_name TEXT,
  project_url TEXT,
  source_url TEXT,
  page_title TEXT,
  retrieved_at TEXT NOT NULL,
  description_text TEXT,
  ownership TEXT,
  location TEXT,
  status TEXT,
  mining_style TEXT,
  measured_indicated_mineral_resources TEXT,
  inferred_mineral_resources TEXT,
  geology_text TEXT,
  technical_report_names_json TEXT NOT NULL DEFAULT '[]',
  technical_report_urls_json TEXT NOT NULL DEFAULT '[]',
  evidence_text TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  extraction_layer TEXT NOT NULL,
  status_code TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_website_project_portfolio_symbol
  ON website_project_portfolio (symbol, project_name);

CREATE INDEX IF NOT EXISTS idx_website_project_portfolio_status
  ON website_project_portfolio (status_code);

CREATE INDEX IF NOT EXISTS idx_website_project_portfolio_company_type
  ON website_project_portfolio (company_type);

CREATE INDEX IF NOT EXISTS idx_website_project_portfolio_retrieved_at
  ON website_project_portfolio (retrieved_at DESC);
