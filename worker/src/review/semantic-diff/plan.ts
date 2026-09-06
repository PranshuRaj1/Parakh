import type { IndexedSymbol } from '@parakh/shared';
import type { IndexedEdge } from '../../indexer/edges.js';
import { buildBehaviorGroups } from '../grouping/group-builder.js';
import { buildChangeGraph } from '../grouping/graph.js';
import type { BehaviorGroup, ChangeGraph } from '../grouping/types.js';
import { mapDiffToChanges, type SemanticChange } from './entity-parser.js';
import { detectMoves, type MoveBlock, type MoveMatch } from './move-detector.js';
import { pairTokenDelta } from './token-delta.js';
import { parseUnifiedDiff, type SemanticFileDiff, type SemanticHunk } from './unified-parser.js';

export interface ChangeUnderstandingPlan {
  files: SemanticFileDiff[];
  changes: SemanticChange[];
  moves: MoveMatch[];
  graph: ChangeGraph;
  groups: BehaviorGroup[];
}

function changedBlocks(hunks: SemanticHunk[], prefix: '+' | '-'): MoveBlock[] {
  return hunks.flatMap((hunk) => {
    const blocks: MoveBlock[] = [];
    let line = prefix === '+' ? hunk.newStart : hunk.oldStart;
    let start: number | null = null;
    let body: string[] = [];
    for (const item of hunk.lines) {
      const isMatch = item.startsWith(prefix) && !item.startsWith(`${prefix}${prefix}`);
      if (isMatch) {
        start ??= line;
        body.push(item.slice(1));
      } else if (start !== null) {
        blocks.push({ file: hunk.file, startLine: start, endLine: line - 1, text: body.join('\n') });
        start = null;
        body = [];
      }
      if (item.startsWith('+') && !item.startsWith('+++')) line += prefix === '+' ? 1 : 0;
      else if (item.startsWith('-') && !item.startsWith('---')) line += prefix === '-' ? 1 : 0;
      else if (item.startsWith(' ')) line++;
    }
    if (start !== null) blocks.push({ file: hunk.file, startLine: start, endLine: line - 1, text: body.join('\n') });
    return blocks;
  });
}

function linePairs(hunk: SemanticHunk): { before: string; after: string }[] {
  const pairs: { before: string; after: string }[] = [];
  for (let index = 0; index < hunk.lines.length - 1; index++) {
    const before = hunk.lines[index];
    const after = hunk.lines[index + 1];
    if (before.startsWith('-') && !before.startsWith('---') && after.startsWith('+') && !after.startsWith('+++')) {
      pairs.push({ before: before.slice(1), after: after.slice(1) });
      index++;
    }
  }
  return pairs;
}

export async function buildChangeUnderstandingPlan(input: {
  repository: string;
  oldSha: string;
  newSha: string;
  diff: string;
  sources?: Record<string, { oldSource?: string; newSource?: string }>;
  symbols?: IndexedSymbol[];
  edges?: IndexedEdge[];
}): Promise<ChangeUnderstandingPlan> {
  const files = await parseUnifiedDiff(input.diff);
  const hunks = files.flatMap((file) => file.hunks);
  const changes = mapDiffToChanges(input.repository, input.oldSha, input.newSha, hunks, input.sources ?? {});
  const tokenChanges = new Map<string, ReturnType<typeof pairTokenDelta>>();
  for (const hunk of hunks) {
    const pairs = linePairs(hunk).flatMap((pair) => pairTokenDelta(pair.before, pair.after));
    tokenChanges.set(hunk.evidence.patchHash, pairs);
  }
  for (const change of changes) change.tokenChanges = tokenChanges.get(change.evidence.patchHash) ?? [];
  const moves = detectMoves(
    files.flatMap((file) => changedBlocks(file.hunks, '-')),
    files.flatMap((file) => changedBlocks(file.hunks, '+')),
  );
  const graph = buildChangeGraph(changes, input.symbols ?? [], input.edges ?? []);
  graph.baseSha = input.oldSha;
  return { files, changes, moves, graph, groups: buildBehaviorGroups(input.repository, graph) };
}
