-- Migration 010: per-file review telemetry
--
-- One row per file reviewed, whether it succeeded or failed. Feeds the
-- dashboard's per-file failure drilldown and lets us spot which providers
-- serve what share of files without guessing from reasoning rows.

CREATE TABLE IF NOT EXISTS review_file_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED')),
  provider TEXT,
  model TEXT,
  findings_count INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_file_events_review
  ON review_file_events (review_id, started_at);