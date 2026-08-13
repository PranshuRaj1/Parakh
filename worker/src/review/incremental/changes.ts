import type { FindingReconciliationOutcome, LedgerFinding, ReconciliationSummary } from './ledger.js';
import { emptyReconciliationSummary } from './ledger.js';

export type DiffChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'renamed_edited';

export interface DiffChange {
  oldPath: string | null;
  newPath: string | null;
  kind: DiffChangeKind;
}

export function parseDiffChanges(diff: string): DiffChange[] {
  return diff.split(/^diff --git /m).slice(1).map<DiffChange>((section) => {
    const firstLine = section.split('\n', 1)[0] ?? '';
    const paths = firstLine.match(/^a\/(.+) b\/(.+)$/);
    const renameFrom = section.match(/^rename from (.+)$/m)?.[1] ?? null;
    const renameTo = section.match(/^rename to (.+)$/m)?.[1] ?? null;
    const hasHunk = /^@@ /m.test(section);
    if (renameFrom && renameTo) {
      return { oldPath: renameFrom, newPath: renameTo, kind: hasHunk ? 'renamed_edited' : 'renamed' };
    }
    const path = paths?.[2] ?? paths?.[1] ?? null;
    if (/^deleted file mode /m.test(section)) {
      return { oldPath: paths?.[1] ?? path, newPath: null, kind: 'deleted' };
    }
    if (/^new file mode /m.test(section)) {
      return { oldPath: null, newPath: path, kind: 'added' };
    }
    return { oldPath: path, newPath: path, kind: 'modified' };
  }).filter((change) => change.oldPath !== null || change.newPath !== null);
}

export interface PreparedIncrementalLedger {
  initialFindings: LedgerFinding[];
  priorFindingsByFile: Map<string, LedgerFinding[]>;
  outcomes: FindingReconciliationOutcome[];
  summary: ReconciliationSummary;
}

export function prepareIncrementalLedger(
  priorFindings: LedgerFinding[],
  changes: DiffChange[],
  headSha: string,
  shouldReviewPath: (path: string) => boolean = () => true
): PreparedIncrementalLedger {
  const initialFindings: LedgerFinding[] = [];
  const priorFindingsByFile = new Map<string, LedgerFinding[]>();
  const outcomes: FindingReconciliationOutcome[] = [];
  const summary = emptyReconciliationSummary();

  for (const finding of priorFindings) {
    const change = changes.find((candidate) =>
      candidate.oldPath === finding.file || candidate.newPath === finding.file
    );
    if (!change) {
      initialFindings.push(finding);
      summary.carriedCount++;
      outcomes.push({
        findingId: finding.finding_id,
        status: 'CARRIED',
        previousPath: finding.file,
        currentPath: finding.file,
      });
      continue;
    }
    if (change.kind === 'deleted') {
      summary.resolvedCount++;
      outcomes.push({
        findingId: finding.finding_id,
        status: 'RESOLVED_FILE_DELETED',
        previousPath: finding.file,
        currentPath: null,
      });
      continue;
    }
    if (change.kind === 'renamed') {
      const remapped = {
        ...finding,
        file: change.newPath!,
        last_validated_head_sha: headSha,
      };
      initialFindings.push(remapped);
      summary.carriedCount++;
      outcomes.push({
        findingId: finding.finding_id,
        status: 'RENAMED',
        previousPath: finding.file,
        currentPath: remapped.file,
      });
      continue;
    }

    const reviewPath = change.newPath ?? change.oldPath!;
    if (!shouldReviewPath(reviewPath)) {
      initialFindings.push(finding);
      summary.carriedCount++;
      outcomes.push({
        findingId: finding.finding_id,
        status: 'CARRIED',
        previousPath: finding.file,
        currentPath: finding.file,
      });
      continue;
    }
    const bucket = priorFindingsByFile.get(reviewPath) ?? [];
    bucket.push({ ...finding, file: reviewPath });
    priorFindingsByFile.set(reviewPath, bucket);
  }

  return { initialFindings, priorFindingsByFile, outcomes, summary };
}
