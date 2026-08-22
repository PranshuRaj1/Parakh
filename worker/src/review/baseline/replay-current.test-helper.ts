import type { Finding, Rule } from '@parakh/shared';
import { computeScore, displayScore } from '@parakh/shared';
import type { ReviewResult } from '../../gemini/client.js';
import {
  extractSuppressionPatterns,
  isIgnoredLockfile,
  matchesScope,
  parseDiffByFile,
  resolveReviewResult,
} from '../../jobs/review.js';
import {
  deterministicPrOverview,
  formatOverviewComment,
} from '../../jobs/overview.js';
import { DEFAULT_FEATURE_FLAGS, type FeatureFlags } from '../../config/feature-flags.js';
import { ReviewBaselineCollector, type ReviewBaselineSnapshot } from './metrics.js';
import type { LoadedFixture } from './fixture-cases.test-helper.js';

export interface ReplayCall {
  file: string;
  diff: string;
}

export interface CurrentReplayResult {
  fixtureId: string;
  metrics: ReviewBaselineSnapshot;
  calls: ReplayCall[];
  findings: Finding[];
  rawScore: number;
  displayedScore: number;
  comment: string;
}

const BASELINE_RULE: Rule = {
  id: 'baseline-rule',
  repo: 'fixture/repo',
  body: 'Authentication configuration must define an explicit callback URL.',
  embedding: null,
  status: 'ACTIVE',
  scope: {},
  priority: 'high',
  kind: 'standard',
  supersedes: null,
  superseded_by: null,
  source_pr: null,
  evidence_count: 0,
  reinforcement_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  superseded_at: null,
};

function emptyResult(): ReviewResult {
  return { genericFindings: [], ruleFindings: [], thinking: null };
}

/**
 * Fixed responses keyed by file path make replay independent of concurrency
 * and invocation order. These are test observations, not review intelligence.
 */
export function deterministicReviewResult(file: string): ReviewResult {
  if (file === 'src/example.ts') {
    return {
      genericFindings: [{
        severity: 'MEDIUM',
        file,
        line: 1,
        body: 'Baseline fixture issue.',
        suggestion: 'Keep this deterministic response stable.',
      }],
      ruleFindings: [],
      thinking: null,
    };
  }
  if (file === 'src/eof.ts') {
    return {
      genericFindings: [{
        severity: 'LOW',
        file,
        line: 1,
        body: 'No newline at the end of the file',
        suggestion: null,
      }],
      ruleFindings: [],
      thinking: null,
    };
  }
  if (file === 'src/auth/provider.ts') {
    return {
      genericFindings: [{
        severity: 'HIGH',
        file,
        line: 1,
        body: 'Authentication flow lacks state validation.',
        suggestion: 'Validate state before completing sign-in.',
      }],
      ruleFindings: [],
      thinking: null,
    };
  }
  if (file === 'src/config/auth.ts') {
    return {
      genericFindings: [],
      ruleFindings: [{
        file,
        line: 1,
        body: 'Authentication callback configuration violates the repository rule.',
        suggestion: 'Use the approved callback configuration.',
        rule_id: BASELINE_RULE.id,
      }],
      thinking: null,
    };
  }
  return emptyResult();
}

/** Replay current file-oriented behavior without any external service. */
export function replayCurrentFixture(
  fixture: LoadedFixture,
  flags: FeatureFlags = { ...DEFAULT_FEATURE_FLAGS }
): CurrentReplayResult {
  const chunks = parseDiffByFile(fixture.content);
  const reviewableFiles = Array.from(chunks.keys()).filter((file) => !isIgnoredLockfile(file));
  const collector = new ReviewBaselineCollector(
    `fixture:${fixture.id}`,
    1,
    flags,
    () => 0
  );
  collector.captureInput(
    fixture.content,
    fixture.resumeValidationHash,
    chunks.size,
    reviewableFiles.length
  );

  const activeRules = [BASELINE_RULE];
  const suppressPatterns = extractSuppressionPatterns([]);
  const calls: ReplayCall[] = [];
  const findings: Finding[] = [];

  for (const file of reviewableFiles) {
    const diff = chunks.get(file) ?? '';
    const applicableRules = activeRules.filter((rule) =>
      matchesScope(file, rule.scope as Record<string, unknown>)
    );
    calls.push({ file, diff });
    collector.recordReviewCall();

    const resolved = resolveReviewResult(
      deterministicReviewResult(file),
      file,
      applicableRules,
      suppressPatterns
    );
    collector.recordFindings(resolved.rawFindingCount, resolved.findings.length);
    findings.push(...resolved.findings);
  }

  const rawScore = computeScore(findings);
  const displayedScore = displayScore(rawScore);
  collector.recordScore(rawScore, displayedScore);

  return {
    fixtureId: fixture.id,
    metrics: collector.snapshot('completed', 0),
    calls,
    findings,
    rawScore,
    displayedScore,
    comment: formatOverviewComment({
      score: displayedScore,
      prOverview: deterministicPrOverview([]),
      files: [],
      repo: 'fixture/repo',
      prNumber: 1,
    }),
  };
}
