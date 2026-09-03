import type { IndexedSymbol } from '@parakh/shared';
import { parseSourceFile } from '../../indexer/parser.js';
import type { SemanticHunk } from './unified-parser.js';
import type { TokenDelta } from './token-delta.js';

export type SemanticChangeConfidence = 'high' | 'medium' | 'low';

export interface EntityMapping {
  symbol: IndexedSymbol | null;
  confidence: SemanticChangeConfidence;
  reason: string;
}

export interface SemanticChange {
  id: string;
  file: string;
  operation: 'add' | 'delete' | 'edit' | 'rename';
  symbol: string | null;
  evidence: SemanticHunk['evidence'];
  tokenChanges?: TokenDelta[];
  confidence: SemanticChangeConfidence;
  reason: string;
}

interface FileSources {
  oldSource?: string;
  newSource?: string;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function changedLines(hunk: SemanticHunk, side: 'old' | 'new'): number[] {
  const lines: number[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (side === 'new') lines.push(newLine);
      newLine++;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (side === 'old') lines.push(oldLine);
      oldLine++;
      continue;
    }
    if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return lines;
}

function symbolsForSource(repo: string, sha: string, file: string, source: string | undefined): IndexedSymbol[] {
  if (!source) return [];
  return parseSourceFile(repo, sha, file, source);
}

function mapLines(symbols: IndexedSymbol[], lines: number[]): EntityMapping {
  const matches = symbols.filter((symbol) =>
    lines.some((line) => line >= symbol.startLine && line <= symbol.endLine)
  );
  if (matches.length === 1) return { symbol: matches[0], confidence: 'high', reason: 'exact symbol range match' };
  if (matches.length > 1) return { symbol: matches[0], confidence: 'medium', reason: 'multiple overlapping symbol ranges' };
  return { symbol: null, confidence: 'low', reason: 'no reliable symbol range match' };
}

function operation(hunk: SemanticHunk): SemanticChange['operation'] {
  if (hunk.oldPath !== hunk.newPath && hunk.oldPath && hunk.newPath) return 'rename';
  return hunk.evidence.kind === 'add' || hunk.evidence.kind === 'delete' ? hunk.evidence.kind : 'edit';
}

export function mapHunkToChange(
  repo: string,
  oldSha: string,
  newSha: string,
  hunk: SemanticHunk,
  sources: FileSources
): SemanticChange {
  const newFile = hunk.newPath ?? hunk.oldPath ?? hunk.file;
  const oldFile = hunk.oldPath ?? hunk.newPath ?? hunk.file;
  const newMapping = mapLines(
    symbolsForSource(repo, newSha, newFile, sources.newSource),
    changedLines(hunk, 'new'),
  );
  const oldMapping = mapLines(
    symbolsForSource(repo, oldSha, oldFile, sources.oldSource),
    changedLines(hunk, 'old'),
  );
  const mapping = newMapping.confidence !== 'low' ? newMapping : oldMapping;
  const symbol = mapping.symbol?.qualifiedName ?? null;
  const id = `change:${hash(`${hunk.evidence.patchHash}:${operation(hunk)}:${symbol ?? hunk.file}`)}`;
  return {
    id,
    file: hunk.file,
    operation: operation(hunk),
    symbol,
    evidence: hunk.evidence,
    confidence: mapping.confidence,
    reason: mapping.reason,
  };
}

export function mapDiffToChanges(
  repo: string,
  oldSha: string,
  newSha: string,
  hunks: SemanticHunk[],
  sources: Record<string, FileSources>
): SemanticChange[] {
  return hunks
    .map((hunk) => mapHunkToChange(repo, oldSha, newSha, hunk, sources[hunk.file] ?? {}))
    .sort((left, right) => left.file.localeCompare(right.file)
      || (left.evidence.newStart ?? left.evidence.oldStart ?? 0) - (right.evidence.newStart ?? right.evidence.oldStart ?? 0)
      || left.id.localeCompare(right.id));
}
