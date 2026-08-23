import type { CodebaseImpact } from '@parakh/shared';
import { buildRepositoryIndex } from '../indexer/repository-index.js';
import { analyzeBlastRadius } from './blast-radius.js';

function diffSource(diff: string): string {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

export function buildPrImpact(repo: string, commitSha: string, fileChunks: Map<string, string>): CodebaseImpact {
  const files = Object.fromEntries([...fileChunks].map(([path, diff]) => [path, diffSource(diff)]));
  const index = buildRepositoryIndex(repo, commitSha, files);
  const changed = index.symbols;
  const blastRadius = analyzeBlastRadius(changed, index.symbols, index.edges);
  if (changed.length > 0) {
    blastRadius.confidence = 'low';
    blastRadius.riskSignals.unshift('PR-local index; unchanged repository callers were not available');
  }
  return { blastRadius, reuseCandidates: [] };
}
