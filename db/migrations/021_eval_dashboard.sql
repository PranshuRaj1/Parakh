CREATE TABLE IF NOT EXISTS eval_runs (
  run_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  commit_sha TEXT NOT NULL,
  working_tree_hash TEXT,
  corpus_version TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  context_budget INTEGER,
  judge_model TEXT NOT NULL,
  judge_tier TEXT NOT NULL,
  score DOUBLE PRECISION,
  report_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_case_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES eval_runs(run_id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  assessment TEXT NOT NULL,
  strict_f1 DOUBLE PRECISION,
  precision DOUBLE PRECISION NOT NULL,
  recall DOUBLE PRECISION,
  false_positives INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  provider_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  planning_groups INTEGER,
  planning_changes INTEGER,
  planning_moves INTEGER,
  planning_fallback_groups INTEGER,
  behavior_calls INTEGER,
  file_calls INTEGER,
  retrieval_recall DOUBLE PRECISION,
  fallback_rate DOUBLE PRECISION,
  UNIQUE (run_id, case_id)
);

CREATE INDEX IF NOT EXISTS eval_runs_created_at_idx ON eval_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS eval_case_metrics_case_id_idx ON eval_case_metrics(case_id, run_id);
