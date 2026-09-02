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

export interface JudgeVerdict {
  defectExists: boolean;
  matchedDefectId: string | null;
  correctness: 0 | 1 | 2;
  localization: 0 | 1 | 2;
  actionability: 0 | 1 | 2;
  unsupportedClaim: boolean;
  evidenceQuote: string;
  reason: string;
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
