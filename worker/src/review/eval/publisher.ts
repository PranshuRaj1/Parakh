import { put } from '@vercel/blob';
import { neon } from '@neondatabase/serverless';
import { reportId, runScore } from './run-history.js';
import type { EvalReport } from './types.js';

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to publish evals');
  if (!process.env.PUBLIC_READ_WRITE_TOKEN) throw new Error('PUBLIC_READ_WRITE_TOKEN is required to publish evals');
  return neon(process.env.DATABASE_URL);
}

export async function publishEvalReport(report: EvalReport): Promise<string> {
  const sql = getSql();
  const runId = reportId(report);
  const blob = await put(`eval-reports/${runId}/report.json`, JSON.stringify(report), {
    access: 'public',
    token: process.env.PUBLIC_READ_WRITE_TOKEN,
    addRandomSuffix: false,
  });

  await sql`
    INSERT INTO eval_runs (
      run_id, created_at, commit_sha, working_tree_hash, corpus_version,
      reviewer_model, context_budget, judge_model, judge_tier, score, report_url
    ) VALUES (
      ${runId}, ${report.createdAt}, ${report.newPipeline.resolvedSha},
      ${report.newPipeline.workingTreeHash ?? null}, ${report.goldSetVersion},
      ${report.config.reviewerModel}, ${report.config.contextBudget},
      ${report.judgeModel}, ${report.judgeTier}, ${runScore(report)}, ${blob.url}
    )
    ON CONFLICT (run_id) DO UPDATE SET
      report_url = EXCLUDED.report_url,
      score = EXCLUDED.score
  `;

  await sql`DELETE FROM eval_case_metrics WHERE run_id = ${runId}`;
  for (const item of report.cases) {
    const metrics = item.comparison.newMetrics;
    const output = item.runs.newA.run.output;
    await sql`
      INSERT INTO eval_case_metrics (
        id, run_id, case_id, assessment, strict_f1, precision, recall,
        false_positives, latency_ms, provider_calls, input_tokens, output_tokens,
        planning_groups, planning_changes, planning_moves, planning_fallback_groups,
        behavior_calls, file_calls, retrieval_recall, fallback_rate
      ) VALUES (
        ${`${runId}:${item.caseId}`}, ${runId}, ${item.caseId}, ${item.assessment},
        ${metrics.strictF1}, ${metrics.knownPrecision}, ${metrics.recall},
        ${metrics.strictFalsePositives}, ${metrics.latencyMs}, ${metrics.providerCalls},
        ${metrics.inputTokens}, ${metrics.outputTokens}, ${output.planningGroups ?? null},
        ${output.planningChanges ?? null}, ${output.planningMoves ?? null},
        ${output.planningFallbackGroups ?? null}, ${metrics.retrieval?.behaviorCalls ?? null},
        ${metrics.retrieval?.fileCalls ?? null}, ${metrics.retrieval?.recall ?? null},
        ${metrics.retrieval?.fallbackRate ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        assessment = EXCLUDED.assessment,
        strict_f1 = EXCLUDED.strict_f1,
        precision = EXCLUDED.precision,
        recall = EXCLUDED.recall,
        false_positives = EXCLUDED.false_positives,
        latency_ms = EXCLUDED.latency_ms,
        provider_calls = EXCLUDED.provider_calls,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        planning_groups = EXCLUDED.planning_groups,
        planning_changes = EXCLUDED.planning_changes,
        planning_moves = EXCLUDED.planning_moves,
        planning_fallback_groups = EXCLUDED.planning_fallback_groups,
        behavior_calls = EXCLUDED.behavior_calls,
        file_calls = EXCLUDED.file_calls,
        retrieval_recall = EXCLUDED.retrieval_recall,
        fallback_rate = EXCLUDED.fallback_rate
    `;
  }

  return runId;
}
