-- Migration 009: Daily-quota pause & auto-resume
--
-- When EVERY configured LLM provider key hits its free-tier DAILY quota,
-- the review used to be parked as a terminal FAILED (user had to re-trigger).
-- Now it moves to PAUSED_DAILY_QUOTA and the 1-minute cron auto-resumes it
-- once `daily_quota_resume_at` elapses (≈6h → next UTC day for Gemini free keys).

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_check;

UPDATE reviews SET status = 'QUEUED' WHERE status = 'FAILED'
  AND error_message LIKE 'All provider API keys have exhausted their daily quota%';

ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','PAUSED_DAILY_QUOTA'));

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS daily_quota_resume_at TIMESTAMPTZ;

-- Resume lookups filter on status + resume timestamp; index it so the
-- every-minute cron sweep is a cheap indexed scan (updates already touch WAL).
CREATE INDEX IF NOT EXISTS idx_reviews_daily_quota_resume
  ON reviews (status, daily_quota_resume_at)
  WHERE status = 'PAUSED_DAILY_QUOTA';