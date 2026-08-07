-- Parakh: Initial database schema
-- Requires: Neon Postgres with pgvector extension

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Rules Table (the memory system) ─────────────────────────────────────────
--
-- Every retrieval query filters: WHERE status = 'ACTIVE' AND repo = $1
-- That single WHERE clause is the entire "don't touch old PRs" guarantee.
-- No special-case logic, just what the query naturally returns.

CREATE TABLE rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,                                      -- "owner/repo"
  body TEXT NOT NULL,                                      -- rule text
  embedding vector(768),                                   -- text-embedding-004 dimension
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED','INACTIVE')),
  scope JSONB DEFAULT '{}',                                -- glob patterns for file matching
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),

  -- Supersession FKs: ONLY written by the CONTRADICTION branch.
  -- Dashboard chain view follows these exclusively.
  -- Every link means "this rule was contradicted and replaced" — never refined or duplicated.
  supersedes UUID REFERENCES rules(id),
  superseded_by UUID REFERENCES rules(id),

  source_pr INT,                                           -- PR number that created this rule

  -- Split counters — each has exactly one meaning.
  evidence_count INT DEFAULT 0,                            -- per violation instance across reviews
  reinforcement_count INT DEFAULT 0,                       -- duplicate correction attempts (DUPLICATE branch)

  created_at TIMESTAMPTZ DEFAULT now(),
  superseded_at TIMESTAMPTZ                                -- set when status becomes SUPERSEDED
);

-- Primary retrieval index: all rule lookups filter by repo + status.
CREATE INDEX idx_rules_repo_status ON rules(repo, status);

-- pgvector index: cosine similarity search for contradiction detection.
CREATE INDEX idx_rules_embedding ON rules USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─── Rule Relationships (DUPLICATE and REFINEMENT only) ──────────────────────
--
-- CONTRADICTION uses the supersedes/superseded_by FKs on rules table.
-- UNRELATED is never stored — pipeline takes no action.
--
-- Direction convention:
--   from_rule_id = NEWER rule (the one just created)
--   to_rule_id   = EXISTING rule (the one already in the DB)
--
-- Queries always use: WHERE from_rule_id = $1 OR to_rule_id = $1
-- so the dashboard's Related Rules panel never silently misses edges.

CREATE TABLE rule_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_rule_id UUID NOT NULL REFERENCES rules(id),
  to_rule_id UUID NOT NULL REFERENCES rules(id),
  relationship TEXT NOT NULL CHECK (relationship IN ('DUPLICATE','REFINEMENT')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(from_rule_id, to_rule_id)
);

CREATE INDEX idx_rule_relationships_from ON rule_relationships(from_rule_id);
CREATE INDEX idx_rule_relationships_to ON rule_relationships(to_rule_id);

-- ─── Reviews Table ───────────────────────────────────────────────────────────
--
-- Every synchronize event inserts a NEW row — intentional.
-- This gives free score history per push for the dashboard.
-- getLatestReviewByPR() uses: ORDER BY created_at DESC LIMIT 1

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,                                      -- "owner/repo"
  pr_number INT NOT NULL,
  score NUMERIC(2,1),                                      -- displayed score (rounded to 0.5)
  findings JSONB,                                          -- [{severity, file, line, body, suggestion, rule_id?}]
  seen_reaction_id BIGINT,                                 -- GitHub reaction ID for 👀
  verdict_reaction_id BIGINT,                              -- GitHub reaction ID for 👍/👎
  status TEXT CHECK (status IN ('SEEN','REVIEWING','COMPLETED')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_reviews_repo_pr ON reviews(repo, pr_number);
