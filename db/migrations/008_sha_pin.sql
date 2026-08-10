-- Migration 008: Pin the reviewed diff to the commit captured at review-start.
-- The worker fetches the diff via compare/{base_sha}...{head_sha}, so pushes
-- made after a review starts can never change what is being reviewed, and the
-- Redis resume state (diffHash) survives queue redeliveries.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS head_sha TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS base_sha TEXT;
