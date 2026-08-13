-- Migration 013: Shadow-planner observations used by the incremental rollout gate.

CREATE TABLE IF NOT EXISTS incremental_review_shadow_runs (
  review_id UUID PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  parent_review_id UUID REFERENCES reviews(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('eligible', 'fallback', 'not_requested', 'disabled')),
  fallback_reason TEXT,
  parent_head_sha TEXT,
  current_head_sha TEXT NOT NULL,
  full_input_characters INT NOT NULL,
  incremental_input_characters INT,
  full_estimated_tokens INT NOT NULL,
  incremental_estimated_tokens INT,
  full_file_count INT NOT NULL,
  incremental_file_count INT,
  input_ratio DOUBLE PRECISION,
  execution_diff_hash TEXT NOT NULL,
  full_diff_hash TEXT NOT NULL,
  execution_matches_full BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incremental_shadow_runs_created
  ON incremental_review_shadow_runs(created_at DESC);
