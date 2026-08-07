-- Migration 005: Stage Tracking and strict timeouts

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS current_stage TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS stage_started_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS stage_attempt INT DEFAULT 1;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS stage_reason_code TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS stage_reason_detail TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ;

-- Drop old constraints and migrate status
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_check;

UPDATE reviews SET status = 'QUEUED' WHERE status = 'SEEN';
UPDATE reviews SET status = 'RUNNING' WHERE status = 'PAUSED_RATE_LIMITED';

ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED'));

-- Drop old review_step_events table
DROP TABLE IF EXISTS review_step_events CASCADE;

CREATE TABLE review_step_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  attempt_number INT NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_ms INT,
  outcome TEXT CHECK (outcome IN ('COMPLETED','FAILED','TIMED_OUT')),
  error_code TEXT,
  error_message TEXT,
  error_stack TEXT,
  reason_transitions JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_step_events_review ON review_step_events(review_id, started_at);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_stage_attempt_per_review
  ON review_step_events (review_id, stage, attempt_number)
  WHERE ended_at IS NULL;
