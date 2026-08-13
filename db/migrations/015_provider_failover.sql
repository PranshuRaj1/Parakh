ALTER TABLE reviews ADD COLUMN IF NOT EXISTS provisional_score NUMERIC(3,1);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS stage_deadline_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reviews_stage_deadline
  ON reviews (stage_deadline_at)
  WHERE status = 'RUNNING';
