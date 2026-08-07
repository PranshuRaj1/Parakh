-- Migration 006: Model reasoning capture (per-file thinking) + failure tie-in

-- Per-file reasoning rows. Raw thinking text is verbose, so every row carries an
-- expires_at deadline (default 14 days) and is pruned by the worker cron to keep
-- storage costs near zero.

CREATE TABLE IF NOT EXISTS review_reasoning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  model TEXT,
  thinking TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days'
);

-- One reasoning row per (review, file) — re-runs overwrite instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_reasoning_review_file
  ON review_reasoning (review_id, file);

-- Fast lookup by review for the dashboard, and cheap pruning of expired rows.
CREATE INDEX IF NOT EXISTS idx_review_reasoning_review
  ON review_reasoning (review_id, created_at);

CREATE INDEX IF NOT EXISTS idx_review_reasoning_expires
  ON review_reasoning (expires_at);
