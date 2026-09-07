import { neon } from '@neondatabase/serverless';

export interface RunSummary {
  runId: string;
  createdAt: string;
  commitSha: string;
  workingTreeHash: string | null;
  corpusVersion: string;
  reviewerModel: string;
  contextBudget: number | null;
  score: number | null;
  reportUrl: string;
}

export interface CaseMetric {
  runId: string;
  caseId: string;
  assessment: string;
  strictF1: number | null;
  precision: number;
  recall: number | null;
  falsePositives: number;
  latencyMs: number;
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  planningGroups: number | null;
  behaviorCalls: number | null;
  fileCalls: number | null;
  fallbackRate: number | null;
}

function sql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return neon(process.env.DATABASE_URL);
}

export async function getRuns(): Promise<RunSummary[]> {
  const rows = await sql()`
    SELECT run_id AS "runId", created_at AS "createdAt", commit_sha AS "commitSha",
      working_tree_hash AS "workingTreeHash", corpus_version AS "corpusVersion",
      reviewer_model AS "reviewerModel", context_budget AS "contextBudget",
      score, report_url AS "reportUrl"
    FROM eval_runs ORDER BY created_at DESC LIMIT 30
  `;
  return rows as unknown as RunSummary[];
}

export async function getCasesForRuns(runIds: string[]): Promise<CaseMetric[]> {
  if (!runIds.length) return [];
  const rows = await sql()`
    SELECT run_id AS "runId", case_id AS "caseId", assessment,
      strict_f1 AS "strictF1", precision, recall,
      false_positives AS "falsePositives", latency_ms AS "latencyMs",
      provider_calls AS "providerCalls", input_tokens AS "inputTokens",
      output_tokens AS "outputTokens", planning_groups AS "planningGroups",
      behavior_calls AS "behaviorCalls", file_calls AS "fileCalls",
      fallback_rate AS "fallbackRate"
    FROM eval_case_metrics WHERE run_id = ANY(${runIds})
    ORDER BY case_id, run_id
  `;
  return rows as unknown as CaseMetric[];
}

export async function getCase(caseId: string): Promise<CaseMetric[]> {
  const rows = await sql()`
    SELECT run_id AS "runId", case_id AS "caseId", assessment,
      strict_f1 AS "strictF1", precision, recall,
      false_positives AS "falsePositives", latency_ms AS "latencyMs",
      provider_calls AS "providerCalls", input_tokens AS "inputTokens",
      output_tokens AS "outputTokens", planning_groups AS "planningGroups",
      behavior_calls AS "behaviorCalls", file_calls AS "fileCalls",
      fallback_rate AS "fallbackRate"
    FROM eval_case_metrics WHERE case_id = ${caseId}
    ORDER BY run_id
  `;
  return rows as unknown as CaseMetric[];
}

export async function getRun(runId: string) {
  const runs = await sql()`
    SELECT run_id AS "runId", created_at AS "createdAt", commit_sha AS "commitSha",
      working_tree_hash AS "workingTreeHash", corpus_version AS "corpusVersion",
      reviewer_model AS "reviewerModel", context_budget AS "contextBudget",
      score, report_url AS "reportUrl"
    FROM eval_runs WHERE run_id = ${runId}
  `;
  const cases = await getCasesForRuns([runId]);
  return { run: (runs[0] as unknown as RunSummary | undefined) ?? null, cases };
}
