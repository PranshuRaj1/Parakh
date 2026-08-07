-- Parakh: Stuck-Detection & Recovery Pipeline
-- Adds observability columns, retry support, step events, and repo-level stuck timeout.

-- ── Reviews: replace status enum ─────────────────────────────────────────────
-- Drop REVIEWING (legacy, replaced by RUNNING with step tracking).
-- Add RUNNING, FAILED, PAUSED_RATE_LIMITED.

-- 1. Drop old constraint first so UPDATE is allowed to set status = 'RUNNING'
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_check;

-- 2. Migrate any existing rows that violate the new status enum
UPDATE reviews SET status = 'RUNNING' WHERE status NOT IN ('SEEN', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED_RATE_LIMITED');

-- 3. Add new constraint with RUNNING, FAILED, PAUSED_RATE_LIMITED
ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('SEEN', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED_RATE_LIMITED'));

-- ── Reviews: expand trigger_reason ───────────────────────────────────────────

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_trigger_reason_check;

UPDATE reviews SET trigger_reason = 'opened' WHERE trigger_reason NOT IN ('opened', 'synchronize', 'manual_mention', 'auto_retry');

ALTER TABLE reviews ADD CONSTRAINT reviews_trigger_reason_check
  CHECK (trigger_reason IN ('opened', 'synchronize', 'manual_mention', 'auto_retry'));

-- ── Reviews: installation_id (needed by watchdog to call triggerReview) ───────

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS installation_id INT;

-- ── Reviews: retry + observability columns ───────────────────────────────────

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS current_step TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS step_detail JSONB;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS error_step TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS error_stack TEXT;

-- ── Step events: append-only audit log ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS review_step_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES reviews(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_step_events_review ON review_step_events(review_id, created_at DESC);

-- ── Repo settings: stuck timeout ─────────────────────────────────────────────

ALTER TABLE repo_settings ADD COLUMN IF NOT EXISTS stuck_timeout_seconds INT DEFAULT 30;
