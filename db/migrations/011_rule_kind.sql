-- Parakh: Rule kind — 'instruction' rules suppress findings instead of enforcing standards.
-- Forward-looking developer directives ("stop flagging X in future reviews") are stored as
-- 'instruction' rules: they are excluded from the enforce list, rendered as prompt-level
-- suppressions, and matched deterministically to drop findings. 'standard' is the default.

ALTER TABLE rules ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard'
  CHECK (kind IN ('standard', 'instruction'));

CREATE INDEX IF NOT EXISTS idx_rules_kind ON rules(kind) WHERE kind = 'instruction';
