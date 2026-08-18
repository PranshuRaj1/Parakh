CREATE TABLE IF NOT EXISTS dashboard_users (
  github_id BIGINT PRIMARY KEY,
  github_login TEXT NOT NULL UNIQUE,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_dashboard_users_status_requested
  ON dashboard_users(status, requested_at DESC);
