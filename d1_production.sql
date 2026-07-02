-- Cloudflare D1 schema for parsed mine production values.
-- The company page reads this table through /api/company-production.

CREATE TABLE IF NOT EXISTS production (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  cik TEXT NOT NULL,
  accession_number TEXT NOT NULL,
  form TEXT NOT NULL,
  filing_date TEXT,
  report_date TEXT,
  fiscal_year INTEGER,
  fiscal_period TEXT,
  period_type TEXT NOT NULL DEFAULT 'quarter',
  mine_name TEXT NOT NULL DEFAULT 'Consolidated',
  metal TEXT NOT NULL CHECK (LOWER(metal) IN ('gold', 'silver')),
  ounces_produced REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'ounces',
  source_url TEXT,
  source_text TEXT,
  parser_version TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(symbol, accession_number, report_date, fiscal_period, period_type, mine_name, metal, ounces_produced, source_text)
);

CREATE INDEX IF NOT EXISTS idx_production_symbol_period
  ON production(symbol, report_date, filing_date);

CREATE INDEX IF NOT EXISTS idx_production_symbol_metal
  ON production(symbol, metal, report_date);
