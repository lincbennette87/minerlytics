CREATE TABLE IF NOT EXISTS contact_feedback (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  submitted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_feedback_submitted_at
ON contact_feedback (submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_feedback_email
ON contact_feedback (email);
