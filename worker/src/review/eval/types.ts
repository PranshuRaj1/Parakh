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
  isNegativeControl: boolean;
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

export interface CaseMetrics {
  caseId: string;
  pipeline: PipelineVersion;
  knownPrecision: number;
  recall: number | null;
  strictF1: number | null;
  weightedRecall: number | null;
  strictFalsePositives: number;
  relaxedFalsePositives: number;
  unsupportedRate: number;
  duplicateRate: number;
  partialRate: number;
  judgeDisagreementRate: number;
  heldOutCount: number;
  heldOutRate: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  providerCalls: number;
}

export interface CaseComparison {
  caseId: string;
  oldMetrics: CaseMetrics;
  newMetrics: CaseMetrics;
  precisionDelta: number;
  recallDelta: number | null;
  f1Delta: number | null;
  weightedRecallDelta: number | null;
  falsePositiveDelta: number;
  latencyDeltaMs: number;
}

export interface NoiseFloor {
  pipeline: PipelineVersion;
  reviewerDisagreementRate: number;
  precisionDelta: number;
  recallDelta: number | null;
  f1Delta: number | null;
  falsePositiveDelta: number;
}

export interface EvaluatedRun {
  run: EvalRun;
  adjudications: FindingAdjudication[];
  metrics: CaseMetrics;
}

export type ComparisonAssessment =
  | 'better'
  | 'worse'
  | 'mixed'
  | 'inconclusive'
  | 'judge_unstable';

export interface EvalCaseReport {
  caseId: string;
  oldNoiseFloor: NoiseFloor;
  newNoiseFloor: NoiseFloor;
  comparison: CaseComparison;
  assessment: ComparisonAssessment;
  runs: {
    oldA: EvaluatedRun;
    oldB: EvaluatedRun;
    newA: EvaluatedRun;
    newB: EvaluatedRun;
  };
}

export interface EvalReport {
  schemaVersion: 1;
  createdAt: string;
  goldSetVersion: string;
  oldPipeline: PipelineVersion;
  newPipeline: PipelineVersion;
  judgeModel: string;
  judgeTier: JudgeVerdict['judgeTier'];
  config: EvalRunConfig;
  cases: EvalCaseReport[];
  summary: Record<ComparisonAssessment, number>;
}
