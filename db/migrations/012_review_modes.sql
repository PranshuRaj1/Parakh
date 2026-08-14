-- Migration 012: Durable review-mode and compatibility metadata.
-- Existing reviews represent the historical full-review pipeline.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS requested_review_mode TEXT NOT NULL DEFAULT 'full';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS effective_review_mode TEXT NOT NULL DEFAULT 'full';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS parent_review_id UUID REFERENCES reviews(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comparison_base_sha TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS fallback_reason TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS active_rules_hash TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT '1';

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_requested_review_mode_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_requested_review_mode_check
  CHECK (requested_review_mode IN ('incremental', 'full'));

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_effective_review_mode_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_effective_review_mode_check
  CHECK (effective_review_mode IN ('incremental', 'full'));

CREATE INDEX IF NOT EXISTS idx_reviews_completed_parent
  ON reviews(repo, pr_number, created_at DESC)
  WHERE status = 'COMPLETED';
