CREATE TABLE IF NOT EXISTS company_homepages (
  symbol TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  short_name TEXT,
  metal TEXT,
  company_type TEXT,
  homepage_url TEXT,
  matched_domain TEXT,
  search_query TEXT NOT NULL,
  search_provider TEXT NOT NULL,
  source_title TEXT,
  source_snippet TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_message TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_company_homepages_status
  ON company_homepages (status);

CREATE INDEX IF NOT EXISTS idx_company_homepages_company_type
  ON company_homepages (company_type);

CREATE INDEX IF NOT EXISTS idx_company_homepages_metal
  ON company_homepages (metal);

CREATE INDEX IF NOT EXISTS idx_company_homepages_checked_at
  ON company_homepages (checked_at DESC);
