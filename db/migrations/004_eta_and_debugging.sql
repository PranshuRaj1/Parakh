-- Migration 004: ETA and Debugging

ALTER TABLE review_step_events ADD COLUMN IF NOT EXISTS duration_ms INT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS github_delivery_id TEXT;

CREATE INDEX IF NOT EXISTS idx_step_events_step_status ON review_step_events(step, status) WHERE status = 'COMPLETED';
