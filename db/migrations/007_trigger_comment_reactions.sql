-- Migration 007: Per-comment review reactions
-- Tracks which comment triggered a review (@parakh review on issue or review comment),
-- so the bot can react 👀 → 👍/👎/😕 and post a threaded completion reply on that comment.
-- Only populated when trigger_reason = 'manual_mention'.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS trigger_comment_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_reviews_trigger_comment_id
  ON reviews (trigger_comment_id) WHERE trigger_comment_id IS NOT NULL;

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS trigger_comment_type TEXT;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_trigger_comment_type_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_trigger_comment_type_check
  CHECK (trigger_comment_type IN ('issue_comment', 'pull_request_review_comment'));

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS trigger_comment_reaction_id BIGINT;
