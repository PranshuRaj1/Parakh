import type { Finding, Severity } from '@parakh/shared';

export interface EvalCase {
  id: string;
  repo: string;
  baseSha: string;
  headSha: string;
  language: string;
  isNegativeControl: boolean;
  diff: string;
  files: Record<string, string>;
}
export interface EvalDefect {
  id: string;
  caseId: string;
  claim: string;
  evidence: string;
  files: string[];
  severity: Severity;
  fixCondition: string;
}

export interface EvalCorpus {
  schemaVersion: 1;
  goldSetVersion: string;
  cases: EvalCase[];
  defects: EvalDefect[];
}

export type PipelineLabel = 'old' | 'new';

export interface PipelineVersion {
  label: PipelineLabel;
  branchRef: string;
  resolvedSha: string;
}

export interface EvalRunConfig {
  reviewerModel: string;
  contextBudget: number;
  tools: string[];
  rulesHash: string;
  timeoutMs: number;
}

export interface PipelineOutput {
  rawFindings: Finding[];
  finalFindings: Finding[];
  inputTokens: number;
  outputTokens: number;
  providerCalls: number;
}

export interface EvalRun {
  caseId: string;
  caseSnapshotHash: string;
  goldSetVersion: string;
  pipeline: PipelineVersion;
  config: EvalRunConfig;
  output: PipelineOutput;
  latencyMs: number;
}

export interface EvalPipeline {
  review(testCase: EvalCase, config: EvalRunConfig): Promise<PipelineOutput>;
}

export interface JudgeVerdict {
  judgeModel: string;
  judgeTier: 'free' | 'paid_spotcheck';
  defectExists: boolean;
  matchedDefectId: string | null;
  correctness: 0 | 1 | 2;
  localization: 0 | 1 | 2;
  actionability: 0 | 1 | 2;
  unsupportedClaim: boolean;
  evidenceQuote: string;
  reason: string;
}

export interface JudgeInput {
  caseId: string;
  goldSetVersion: string;
  judgePromptVersion: string;
  finding: Finding;
  defects: EvalDefect[];
  codeContext: string;
}

export interface JudgeResult {
  cacheKey: string;
  verdicts: [JudgeVerdict, JudgeVerdict];
  outcome: AdjudicationOutcome;
  cacheHit: boolean;
}

export type AdjudicationOutcome =
  | 'correct'
  | 'partially_correct'
  | 'incorrect'
  | 'unsupported'
  | 'duplicate'
  | 'valid_unlisted'
  | 'needs_human_review';

export interface FindingAdjudication {
  finding: Finding;
  outcome: AdjudicationOutcome;
  matchedDefectId: string | null;
  verdicts: JudgeVerdict[];
  reason: string;
}
