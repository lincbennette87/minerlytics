CREATE TABLE IF NOT EXISTS website_management_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  company_name TEXT NOT NULL,
  short_name TEXT,
  metal TEXT,
  company_type TEXT,
  source_url TEXT,
  page_title TEXT,
  retrieved_at TEXT NOT NULL,
  person_name TEXT,
  title TEXT,
  biography TEXT,
  biography_length INTEGER NOT NULL DEFAULT 0,
  appointment_date TEXT,
  board_roles_json TEXT NOT NULL DEFAULT '[]',
  committee_roles_json TEXT NOT NULL DEFAULT '[]',
  profile_image_url TEXT,
  evidence_text TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  extraction_layer TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_website_management_team_symbol
  ON website_management_team (symbol, person_name);

CREATE INDEX IF NOT EXISTS idx_website_management_team_status
  ON website_management_team (status);

CREATE INDEX IF NOT EXISTS idx_website_management_team_company_type
  ON website_management_team (company_type);

CREATE INDEX IF NOT EXISTS idx_website_management_team_retrieved_at
  ON website_management_team (retrieved_at DESC);
