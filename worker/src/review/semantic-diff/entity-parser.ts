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
  if (lines.length === 0) return { symbol: null, confidence: 'low', reason: 'no reliable symbol range match' };
  const matches = symbols
    .filter((symbol) => lines.every((line) => line >= symbol.startLine && line <= symbol.endLine))
    .sort((left, right) =>
      (left.endLine - left.startLine) - (right.endLine - right.startLine)
      || right.startLine - left.startLine
      || left.qualifiedName.localeCompare(right.qualifiedName));
  if (matches.length === 0) return { symbol: null, confidence: 'low', reason: 'no reliable symbol range match' };
  const [match, next] = matches;
  if (!next || match.startLine !== next.startLine || match.endLine !== next.endLine) {
    return { symbol: match, confidence: 'high', reason: 'smallest enclosing symbol range match' };
  }
  return { symbol: match, confidence: 'medium', reason: 'multiple overlapping symbol ranges' };
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
  const parsed = new Map(Object.entries(sources).map(([file, source]) => [file, {
    old: symbolsForSource(repo, oldSha, file, source.oldSource),
    new: symbolsForSource(repo, newSha, file, source.newSource),
  }]));
  return hunks
    .flatMap((hunk) => {
      const mappings = new Map<string | null, EntityMapping>();
      for (const side of ['new', 'old'] as const) {
        if (!sources[hunk.file]?.[side === 'new' ? 'newSource' : 'oldSource']) continue;
        for (const line of changedLines(hunk, side)) {
          const mapping = mapLines(parsed.get(hunk.file)?.[side] ?? [], [line]);
          const key = mapping.symbol?.qualifiedName ?? null;
          if (!mappings.has(key)) mappings.set(key, mapping);
        }
      }
      if (mappings.size === 0) return [mapHunkToChange(repo, oldSha, newSha, hunk, sources[hunk.file] ?? {})];
      return [...mappings].map(([symbol, mapping]): SemanticChange => ({
        id: `change:${hash(`${hunk.evidence.patchHash}:${operation(hunk)}:${symbol ?? hunk.file}`)}`,
        file: hunk.file,
        operation: operation(hunk),
        symbol,
        evidence: hunk.evidence,
        confidence: mapping.confidence,
        reason: mapping.reason,
      }));
    })
    .sort((left, right) => left.file.localeCompare(right.file)
      || (left.evidence.newStart ?? left.evidence.oldStart ?? 0) - (right.evidence.newStart ?? right.evidence.oldStart ?? 0)
      || (left.symbol ?? '').localeCompare(right.symbol ?? '')
      || left.id.localeCompare(right.id));
}
