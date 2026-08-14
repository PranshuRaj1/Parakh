-- Parakh: Rule trust levels — PENDING status and created_by audit trail.
-- Rules created by COLLABORATORs start as PENDING (need owner/member approval).
-- Rules created by OWNERs/MEMBERs start as ACTIVE (auto-activate).

ALTER TABLE rules DROP CONSTRAINT IF EXISTS rules_status_check;
ALTER TABLE rules ADD CONSTRAINT rules_status_check
  CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'INACTIVE', 'PENDING'));

ALTER TABLE rules ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status) WHERE status = 'PENDING';
