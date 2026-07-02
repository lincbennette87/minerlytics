CREATE TABLE IF NOT EXISTS website_investor_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  company_name TEXT NOT NULL,
  short_name TEXT,
  metal TEXT,
  company_type TEXT,
  homepage_url TEXT,
  news_landing_url TEXT,
  article_url TEXT,
  article_title TEXT,
  published_date TEXT,
  summary_text TEXT,
  page_title TEXT,
  retrieved_at TEXT NOT NULL,
  evidence_text TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  extraction_layer TEXT NOT NULL,
  status_code TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_website_investor_news_symbol
  ON website_investor_news (symbol, published_date DESC);

CREATE INDEX IF NOT EXISTS idx_website_investor_news_status
  ON website_investor_news (status_code);

CREATE INDEX IF NOT EXISTS idx_website_investor_news_company_type
  ON website_investor_news (company_type);

CREATE INDEX IF NOT EXISTS idx_website_investor_news_retrieved_at
  ON website_investor_news (retrieved_at DESC);

CREATE INDEX IF NOT EXISTS idx_website_investor_news_article_url
  ON website_investor_news (article_url);
