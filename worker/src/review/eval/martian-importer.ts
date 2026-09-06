import type { Severity } from '@parakh/shared';
import { readFile } from 'node:fs/promises';
import type { EvalCase, EvalCorpus, EvalDefect } from './types.js';

const RELEVANT_CATEGORIES = new Set([
  'bug',
  'security',
  'concurrency',
  'data',
  'api',
]);

const SEVERITY_MAP: Record<string, Severity> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

export interface MartianPr {
  pr_title: string;
  url: string;
  original_url?: string;
  az_comment?: string;
  comments: MartianComment[];
}

export interface MartianComment {
  comment: string;
  severity: string;
  category: string;
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function normalizeSeverity(raw: string): Severity {
  const mapped = SEVERITY_MAP[raw.toLowerCase()];
  if (!mapped) {
    throw new Error(`Unknown severity: ${raw}`);
  }
  return mapped;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function extractRepoName(pr: MartianPr): string {
  const parsed = parsePrUrl(pr.original_url ?? pr.url);
  if (!parsed) return 'unknown';
  return `${parsed.owner}/${parsed.repo}`;
}

export interface MartianImportResult {
  prs: MartianPr[];
  filteredComments: number;
  totalComments: number;
  skippedCategories: string[];
}

export async function loadMartianFile(path: string): Promise<MartianPr[]> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as MartianPr[];
}

export function filterToRelevantCategories(
  prs: MartianPr[]
): MartianImportResult {
  const skipped: string[] = [];
  let filteredCount = 0;
  let totalCount = 0;

  const filtered = prs.map((pr) => {
    const relevantComments = pr.comments.filter((comment) => {
      totalCount++;
      if (!RELEVANT_CATEGORIES.has(comment.category.toLowerCase())) {
        skipped.push(comment.category);
        filteredCount++;
        return false;
      }
      return true;
    });
    return { ...pr, comments: relevantComments };
  });

  return {
    prs: filtered,
    filteredComments: filteredCount,
    totalComments: totalCount,
    skippedCategories: [...new Set(skipped)],
  };
}

export function buildCorpusFromMartian(
  prs: MartianPr[],
  goldSetVersion: string,
  snapshotFetcher?: (owner: string, repo: string, number: number) => Promise<{
    baseSha: string;
    headSha: string;
    diff: string;
    files: Record<string, string>;
    baseFiles?: Record<string, string>;
  } | null>
): Promise<EvalCorpus> {
  return buildCorpusFromMartianAsync(prs, goldSetVersion, snapshotFetcher);
}

async function buildCorpusFromMartianAsync(
  prs: MartianPr[],
  goldSetVersion: string,
  snapshotFetcher?: (owner: string, repo: string, number: number) => Promise<{
    baseSha: string;
    headSha: string;
    diff: string;
    files: Record<string, string>;
    baseFiles?: Record<string, string>;
  } | null>
): Promise<EvalCorpus> {
  const cases: EvalCase[] = [];
  const defects: EvalDefect[] = [];
  let defectCounter = 0;

  for (let prIndex = 0; prIndex < prs.length; prIndex++) {
    const pr = prs[prIndex];
    const parsed = parsePrUrl(pr.original_url ?? pr.url);
    if (!parsed) continue;

    const caseId = `martian-${parsed.repo}-${parsed.number}-${slugify(pr.pr_title)}`;

    let snapshot: {
      baseSha: string;
      headSha: string;
      diff: string;
      files: Record<string, string>;
      baseFiles?: Record<string, string>;
    } | null = null;

    if (snapshotFetcher) {
      snapshot = await snapshotFetcher(parsed.owner, parsed.repo, parsed.number);
    }

    const language = detectLanguage(parsed.repo);

    cases.push({
      id: caseId,
      repo: extractRepoName(pr),
      baseSha: snapshot?.baseSha ?? `pending-${caseId}-base`,
      headSha: snapshot?.headSha ?? `pending-${caseId}-head`,
      language,
      isNegativeControl: pr.comments.length === 0,
      diff: snapshot?.diff ?? '',
      files: snapshot?.files ?? {},
      ...(snapshot?.baseFiles ? { baseFiles: snapshot.baseFiles } : {}),
    });

    for (const comment of pr.comments) {
      defectCounter++;
      const defectId = `martian-defect-${String(defectCounter).padStart(4, '0')}`;
      defects.push({
        id: defectId,
        caseId,
        claim: comment.comment,
        evidence: comment.comment,
        files: [],
        severity: normalizeSeverity(comment.severity),
        fixCondition: `Verify that the reviewer identifies: ${comment.comment.slice(0, 120)}`,
      });
    }
  }

  return {
    schemaVersion: 1,
    goldSetVersion,
    cases,
    defects,
  };
}

function detectLanguage(repoName: string): string {
  const lower = repoName.toLowerCase();
  if (lower.includes('next.js') || lower.includes('cal.com') || lower.includes('prisma')) {
    return 'typescript';
  }
  if (lower.includes('flask') || lower.includes('fastapi') || lower.includes('pydantic')) {
    return 'python';
  }
  if (lower.includes('grafana') || lower.includes('terraform') || lower.includes('compose')) {
    return 'go';
  }
  if (lower.includes('discourse')) {
    return 'ruby';
  }
  if (lower.includes('keycloak') || lower.includes('sentry')) {
    return 'python';
  }
  return 'unknown';
}

export function summarizeImport(result: MartianImportResult): string {
  const lines: string[] = [
    `Martian import summary:`,
    `  PRs: ${result.prs.length}`,
    `  Total comments: ${result.totalComments}`,
    `  Relevant comments (kept): ${result.totalComments - result.filteredComments}`,
    `  Filtered out: ${result.filteredComments}`,
    `  Skipped categories: ${result.skippedCategories.join(', ') || 'none'}`,
  ];
  return lines.join('\n');
}
