import type {
  Finding,
  PriorFindingResolution,
  PriorFindingResolutionStatus,
} from '@parakh/shared';

export interface LedgerFinding extends Finding {
  finding_id: string;
  first_seen_head_sha: string;
  last_validated_head_sha: string;
}

export interface FindingReconciliationOutcome {
  findingId: string;
  status: PriorFindingResolutionStatus | 'CARRIED' | 'RESOLVED_FILE_DELETED' | 'RENAMED' | 'PROVIDER_FAILURE';
  previousPath: string;
  currentPath: string | null;
}

export interface ReconciliationSummary {
  newCount: number;
  carriedCount: number;
  stillPresentCount: number;
  resolvedCount: number;
  uncertainCount: number;
  missingCount: number;
  malformedCount: number;
  providerFailureCount: number;
  ambiguousDedupKeptCount: number;
  ambiguousFindingIds: string[];
}

export interface ReconcileFileResult {
  findings: LedgerFinding[];
  outcomes: FindingReconciliationOutcome[];
  summary: ReconciliationSummary;
}

export function emptyReconciliationSummary(): ReconciliationSummary {
  return {
    newCount: 0,
    carriedCount: 0,
    stillPresentCount: 0,
    resolvedCount: 0,
    uncertainCount: 0,
    missingCount: 0,
    malformedCount: 0,
    providerFailureCount: 0,
    ambiguousDedupKeptCount: 0,
    ambiguousFindingIds: [],
  };
}

/**
 * Merge per-file totals into the review-wide reconciliation summary.
 * Keeping this pure means batch execution order does not change the meaning
 * of the accumulated review result.
 */
export function mergeReconciliationSummaries(
  left: ReconciliationSummary,
  right: ReconciliationSummary
): ReconciliationSummary {
  return {
    newCount: left.newCount + right.newCount,
    carriedCount: left.carriedCount + right.carriedCount,
    stillPresentCount: left.stillPresentCount + right.stillPresentCount,
    resolvedCount: left.resolvedCount + right.resolvedCount,
    uncertainCount: left.uncertainCount + right.uncertainCount,
    missingCount: left.missingCount + right.missingCount,
    malformedCount: left.malformedCount + right.malformedCount,
    providerFailureCount: left.providerFailureCount + right.providerFailureCount,
    ambiguousDedupKeptCount: left.ambiguousDedupKeptCount + right.ambiguousDedupKeptCount,
    ambiguousFindingIds: [...left.ambiguousFindingIds, ...right.ambiguousFindingIds],
  };
}

/**
 * Add durable identity and commit history to findings before persistence.
 * The identity lets incremental reviews update an existing issue instead of
 * creating a new issue for every pull request commit.
 */
export function ensureLedgerFindings(
  findings: Finding[],
  headSha: string,
  createId: () => string = () => crypto.randomUUID()
): LedgerFinding[] {
  return findings.map((finding) => ({
    ...finding,
    finding_id: finding.finding_id ?? createId(),
    first_seen_head_sha: finding.first_seen_head_sha ?? headSha,
    last_validated_head_sha: finding.last_validated_head_sha ?? headSha,
  }));
}

function normalizeText(text: string | null): string {
  return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function semanticKey(finding: Finding): string {
  return [canonicalPath(finding.file), finding.rule_id ?? 'generic', normalizeText(finding.body)].join('\0');
}

export async function strictFindingFingerprint(finding: Finding): Promise<string> {
  const value = [
    'v1',
    canonicalPath(finding.file),
    finding.rule_id ?? 'generic',
    String(finding.line),
    normalizeText(finding.body),
    normalizeText(finding.suggestion),
  ].join('\0');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function classifyResolution(
  finding: LedgerFinding,
  resolutions: PriorFindingResolution[] | null | unknown
): PriorFindingResolution {
  if (resolutions === null) {
    return { findingId: finding.finding_id, status: 'MODEL_RESULT_MISSING' };
  }
  if (!Array.isArray(resolutions)) {
    return { findingId: finding.finding_id, status: 'MODEL_RESULT_MALFORMED' };
  }
  const matches = resolutions.filter((item) => item?.findingId === finding.finding_id);
  if (matches.length === 0) {
    return { findingId: finding.finding_id, status: 'MODEL_RESULT_MISSING' };
  }
  if (matches.length !== 1) {
    return { findingId: finding.finding_id, status: 'MODEL_RESULT_MALFORMED' };
  }
  const match = matches[0];
  if (!['STILL_PRESENT', 'RESOLVED', 'UNCERTAIN'].includes(match.status)) {
    return { findingId: finding.finding_id, status: 'MODEL_RESULT_MALFORMED' };
  }
  if (match.line !== undefined && (!Number.isInteger(match.line) || match.line < 1)) {
    return { findingId: finding.finding_id, status: 'MODEL_RESULT_MALFORMED' };
  }
  return match;
}

export function retainPriorFindings(
  priorFindings: LedgerFinding[],
  status: 'MODEL_RESULT_MISSING' | 'MODEL_RESULT_MALFORMED' | 'PROVIDER_FAILURE'
): ReconcileFileResult {
  const summary = emptyReconciliationSummary();
  if (status === 'MODEL_RESULT_MISSING') summary.missingCount = priorFindings.length;
  if (status === 'MODEL_RESULT_MALFORMED') summary.malformedCount = priorFindings.length;
  if (status === 'PROVIDER_FAILURE') summary.providerFailureCount = priorFindings.length;
  return {
    findings: [...priorFindings],
    outcomes: priorFindings.map((finding) => ({
      findingId: finding.finding_id,
      status,
      previousPath: finding.file,
      currentPath: finding.file,
    })),
    summary,
  };
}

/**
 * Reconcile one file's new findings with its prior ledger findings. Resolution
 * is applied first, then strict and semantic matching preserve issue identity;
 * provider failures retain known findings instead of erasing them.
 */
export async function reconcileFileFindings(
  priorFindings: LedgerFinding[],
  newFindings: Finding[],
  resolutions: PriorFindingResolution[] | null,
  headSha: string,
  createId: () => string = () => crypto.randomUUID()
): Promise<ReconcileFileResult> {
  const summary = emptyReconciliationSummary();
  const findings: LedgerFinding[] = [];
  const outcomes: FindingReconciliationOutcome[] = [];

  for (const prior of priorFindings) {
    const resolution = classifyResolution(prior, resolutions);
    if (resolution.status === 'RESOLVED') {
      summary.resolvedCount++;
      outcomes.push({
        findingId: prior.finding_id,
        status: 'RESOLVED',
        previousPath: prior.file,
        currentPath: null,
      });
      continue;
    }

    const retained: LedgerFinding = {
      ...prior,
      line: resolution.status === 'STILL_PRESENT' && resolution.line
        ? resolution.line
        : prior.line,
      last_validated_head_sha: resolution.status === 'STILL_PRESENT'
        ? headSha
        : prior.last_validated_head_sha,
    };
    findings.push(retained);
    outcomes.push({
      findingId: prior.finding_id,
      status: resolution.status,
      previousPath: prior.file,
      currentPath: retained.file,
    });
    if (resolution.status === 'STILL_PRESENT') summary.stillPresentCount++;
    if (resolution.status === 'UNCERTAIN') summary.uncertainCount++;
    if (resolution.status === 'MODEL_RESULT_MISSING') summary.missingCount++;
    if (resolution.status === 'MODEL_RESULT_MALFORMED') summary.malformedCount++;
  }

  const priorCandidates = [...findings];
  const reusedPriorIds = new Set<string>();
  const fingerprints = new Set(await Promise.all(findings.map(strictFindingFingerprint)));
  for (const raw of newFindings) {
    const fingerprint = await strictFindingFingerprint(raw);
    if (fingerprints.has(fingerprint)) continue;

    const candidates = priorCandidates.filter((existing) => semanticKey(existing) === semanticKey(raw));
    let findingId: string;
    let firstSeenHeadSha = headSha;
    let isNewFinding = true;
    if (candidates.length === 1 && !reusedPriorIds.has(candidates[0].finding_id)) {
      findingId = candidates[0].finding_id;
      firstSeenHeadSha = candidates[0].first_seen_head_sha;
      isNewFinding = false;
      const index = findings.findIndex((finding) => finding.finding_id === findingId);
      if (index >= 0) {
        fingerprints.delete(await strictFindingFingerprint(findings[index]));
        findings.splice(index, 1);
      }
      reusedPriorIds.add(findingId);
    } else {
      findingId = createId();
      if (candidates.length > 1) {
        summary.ambiguousDedupKeptCount++;
        summary.ambiguousFindingIds.push(findingId, ...candidates.map((candidate) => candidate.finding_id));
      }
    }

    findings.push({
      ...raw,
      finding_id: findingId,
      first_seen_head_sha: firstSeenHeadSha,
      last_validated_head_sha: headSha,
    });
    fingerprints.add(fingerprint);
    if (isNewFinding) summary.newCount++;
  }

  return { findings, outcomes, summary };
}
