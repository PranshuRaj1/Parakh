-- Parakh: Comment Routing and Repo Settings schema updates

-- 1. Add trigger_reason to reviews table
ALTER TABLE reviews ADD COLUMN trigger_reason TEXT 
  CHECK (trigger_reason IN ('opened', 'synchronize', 'manual_mention')) DEFAULT 'opened';

-- 2. Create repo_settings table for configuration
CREATE TABLE repo_settings (
  repo TEXT PRIMARY KEY,
  reply_mode TEXT CHECK (reply_mode IN ('mentioned_only', 'all_comments')) DEFAULT 'mentioned_only'
);

-- 3. Seed the demo repository to 'all_comments' mode for the demo
INSERT INTO repo_settings (repo, reply_mode) VALUES ('PranshuRaj1/Parakh', 'all_comments');
