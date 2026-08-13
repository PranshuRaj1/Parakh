-- Repeatable go/no-go report for enabling incremental execution.
-- Run with: psql "$DATABASE_URL" -f db/reports/incremental-shadow-gate.sql

WITH eligible AS (
  SELECT *
  FROM incremental_review_shadow_runs
  WHERE decision = 'eligible'
), summary AS (
  SELECT
    COUNT(*)::int AS eligible_comparisons,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY input_ratio) AS median_input_ratio,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY input_ratio) AS p95_input_ratio,
    BOOL_AND(execution_matches_full) AS all_execution_inputs_match_full
  FROM eligible
)
SELECT
  *,
  eligible_comparisons >= 30
    AND median_input_ratio <= 0.40
    AND p95_input_ratio <= 0.70
    AND all_execution_inputs_match_full AS shadow_gate_passed
FROM summary;

SELECT fallback_reason, COUNT(*)::int AS occurrences
FROM incremental_review_shadow_runs
WHERE decision = 'fallback'
GROUP BY fallback_reason
ORDER BY occurrences DESC, fallback_reason;
