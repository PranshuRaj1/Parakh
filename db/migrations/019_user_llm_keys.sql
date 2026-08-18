-- Parakh: bring-your-own LLM API keys.
-- One row per dashboard user; keys are encrypted (AES-256-GCM, worker-only,
-- master key = LLM_KEY_ENCRYPTION_SECRET) and stored as JSONB arrays of
-- {enc, hint} objects. Reviews on a user's repos bill exclusively to this
-- user's keys — no fallback to the worker's shared env keys.

CREATE TABLE IF NOT EXISTS user_llm_keys (
  github_id BIGINT PRIMARY KEY REFERENCES dashboard_users(github_id) ON DELETE CASCADE,
  gemini_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  groq_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  cfai_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  cfai_account_id TEXT,
  openrouter_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_llm_keys_updated
  ON user_llm_keys(updated_at DESC);
