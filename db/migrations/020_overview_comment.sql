-- Persistent PR overview comment: one comment per PR, updated in place on
-- every completed review. Null for reviews that predate this migration.
ALTER TABLE reviews
ADD COLUMN IF NOT EXISTS overview_comment_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_reviews_overview_comment
ON reviews (repo, pr_number, created_at DESC)
WHERE overview_comment_id IS NOT NULL;
