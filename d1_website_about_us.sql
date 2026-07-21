CREATE TABLE IF NOT EXISTS Website_about_Us (
  symbol TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  short_name TEXT,
  metal TEXT,
  company_type TEXT,
  homepage_url TEXT,
  about_url TEXT,
  about_title TEXT,
  about_text TEXT NOT NULL DEFAULT '',
  text_length INTEGER NOT NULL DEFAULT 0,
  extraction_method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('found', 'not_found', 'failed')),
  error_message TEXT,
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_website_about_us_status
  ON Website_about_Us (status);

CREATE INDEX IF NOT EXISTS idx_website_about_us_company_type
  ON Website_about_Us (company_type);

CREATE INDEX IF NOT EXISTS idx_website_about_us_metal
  ON Website_about_Us (metal);

CREATE INDEX IF NOT EXISTS idx_website_about_us_checked_at
  ON Website_about_Us (checked_at DESC);

CREATE TABLE IF NOT EXISTS Website_about_Us_Extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  company_name TEXT NOT NULL,
  short_name TEXT,
  metal TEXT,
  company_type TEXT,
  homepage_url TEXT,
  source_url TEXT NOT NULL,
  page_title TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT NOT NULL,
  about_text TEXT NOT NULL DEFAULT '',
  text_length INTEGER NOT NULL DEFAULT 0,
  evidence_text TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  extraction_layer TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'found' CHECK (status IN ('found', 'not_found', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(symbol, source_url, extraction_layer)
);

CREATE INDEX IF NOT EXISTS idx_website_about_us_extractions_symbol
  ON Website_about_Us_Extractions (symbol, confidence);

CREATE INDEX IF NOT EXISTS idx_website_about_us_extractions_status
  ON Website_about_Us_Extractions (status);

CREATE INDEX IF NOT EXISTS idx_website_about_us_extractions_retrieved_at
  ON Website_about_Us_Extractions (retrieved_at DESC);
