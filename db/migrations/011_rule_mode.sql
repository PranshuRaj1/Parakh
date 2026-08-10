-- Migration 011: rule mode + suppression patterns
--
-- Rules are either 'enforce' (code must comply — the traditional case) or
-- 'suppress' (never flag this class of issue). Suppress rules are NEVER sent
-- to the LLM as enforceable standards — that is exactly what made the old
-- "never flag EOF newlines" rule backfire: the model reported the issue as a
-- violation OF the very rule meant to suppress it. Instead, suppress rules
-- drive a deterministic post-filter that drops matching findings.
--
-- patterns: case-insensitive substrings matched against finding bodies. A
-- suppress rule drops any finding whose body contains one of these AND whose
-- file matches the rule's scope.

ALTER TABLE rules
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'enforce'
    CHECK (mode IN ('enforce', 'suppress'));

ALTER TABLE rules
  ADD COLUMN patterns JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Deactivate the backfiring EOF-newline rule. Stored ACTIVE, it was fed to the
-- LLM as an enforceable standard, so the model flagged the newline issue as a
-- rule violation and double-counted it (once as a generic finding, once as a
-- rule finding). Superseded by mode='suppress' + prompt hardening. Idempotent:
-- no-ops on databases that never had this rule.
UPDATE rules
SET status = 'INACTIVE'
WHERE id = '7a4b897f-e078-4986-b068-5dbc507b2f01';
