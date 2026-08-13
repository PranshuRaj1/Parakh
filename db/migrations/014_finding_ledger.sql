-- Migration 014: Durable reconciliation evidence for whole-PR incremental scoring.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reconciliation_summary JSONB;

CREATE TABLE IF NOT EXISTS review_finding_reconciliations (
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'CARRIED', 'RENAMED', 'RESOLVED_FILE_DELETED', 'STILL_PRESENT', 'RESOLVED',
    'UNCERTAIN', 'MODEL_RESULT_MISSING', 'MODEL_RESULT_MALFORMED', 'PROVIDER_FAILURE'
  )),
  previous_path TEXT NOT NULL,
  current_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, finding_id)
);

CREATE INDEX IF NOT EXISTS idx_review_finding_reconciliations_status
  ON review_finding_reconciliations(review_id, status);
