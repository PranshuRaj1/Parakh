import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';

const envFile = fs.readFileSync('D:/reptile-killer/worker/.env.moved', 'utf8');
const env = {};
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)$/);
  if (m) env[m[1]] = m[2].trim();
}
const dbUrl = env.DATABASE_URL.trim().split('?')[0];
const sql = neon(dbUrl);

async function q(label, query, ...params) {
  try {
    const rows = await sql(query, ...params);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.log(`\n=== ${label} ERROR ===`);
    console.log(String(err));
  }
}

await q(
  'RUNNING reviews (stale/heartbeat)',
  `
  SELECT id, repo, pr_number, status, current_stage, stage_attempt,
         stage_started_at, worker_heartbeat_at, stage_deadline_at,
         stage_reason_code, stage_reason_detail, error_step, error_message, created_at
  FROM reviews
  WHERE status = 'RUNNING'
  ORDER BY created_at DESC
  LIMIT 30
  `
);

await q(
  'Recent FAILED/TIMED_OUT reviews',
  `
  SELECT id, repo, pr_number, status, current_stage, error_step, error_message,
         error_stack, failed_at, created_at, stage_attempt
  FROM reviews
  WHERE status IN ('FAILED','TIMED_OUT')
  ORDER BY created_at DESC
  LIMIT 30
  `
);

await q(
  'Open step events for RUNNING reviews',
  `
  SELECT r.id, r.repo, r.pr_number, e.stage, e.attempt_number, e.started_at, e.outcome, e.error_code, e.error_message
  FROM review_step_events e
  JOIN reviews r ON r.id = e.review_id
  WHERE e.ended_at IS NULL AND r.status = 'RUNNING'
  ORDER BY e.started_at DESC
  LIMIT 30
  `
);

sql.end?.();