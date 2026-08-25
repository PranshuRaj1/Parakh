import type { ConventionRule, Rule } from '@parakh/shared';
import { getFileContent } from '../../github/api.js';
import { CONVENTION_FILES, capConventionRules, parseConventionRules } from './parser.js';

export interface LoadedConventions {
  rules: Rule[];
  /** Distinct convention files that existed and parsed successfully. */
  filesFound: number;
  /** True when the 4000-char prompt budget dropped trailing rules. */
  truncated: boolean;
  /** GitHub contents-API calls made — accounted against the subrequest budget by the caller. */
  fetchAttempts: number;
}

const NOT_FOUND = /GitHub API error \(404\)/;

/**
 * Fetch and parse the repo's convention markdown at the pinned head SHA.
 * A missing file is normal (most repos have none) and stays silent; any other
 * failure degrades to reviewing without conventions. Never throws.
 */
/** Load repository-owned convention files as review rules at a pinned commit. */
export async function loadConventionRules(
  owner: string,
  repo: string,
  headSha: string,
  token: string
): Promise<LoadedConventions> {
  const parsed: ConventionRule[] = [];
  let filesFound = 0;
  let fetchAttempts = 0;

  for (const sourceFile of CONVENTION_FILES) {
    fetchAttempts++;
    try {
      const raw = await getFileContent(owner, repo, sourceFile, headSha, token);
      filesFound++;
      parsed.push(...parseConventionRules(sourceFile, raw));
    } catch (err) {
      if (!NOT_FOUND.test(err instanceof Error ? err.message : String(err))) {
        console.warn(`[conventions] Failed to read ${sourceFile} — skipping:`, err);
      }
    }
  }

  const capped = capConventionRules(parsed);
  return { rules: capped.kept.map(toRule), filesFound, truncated: capped.truncated, fetchAttempts };
}

/**
 * Conventions ride the existing Rule pipeline (scope filter, prompt rendering,
 * suppression matching) as a per-review overlay. They are never persisted:
 * no DB identity, no evidence tracking, learned DB rules always outrank them.
 */
function toRule(convention: ConventionRule): Rule {
  return {
    id: convention.id,
    repo: '',
    body: convention.body,
    embedding: null,
    status: 'ACTIVE',
    scope: convention.scope,
    priority: convention.priority,
    kind: convention.kind,
    supersedes: null,
    superseded_by: null,
    source_pr: null,
    created_by: null,
    evidence_count: 0,
    reinforcement_count: 0,
    created_at: '',
    superseded_at: null,
  };
}
