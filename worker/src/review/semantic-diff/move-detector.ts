export interface MoveBlock {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface MoveMatch {
  from: MoveBlock;
  to: MoveBlock;
  confidence: 'high' | 'low';
}

function normalize(value: string): string {
  return value
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, 'STR')
    .replace(/\s+/g, ' ')
    .trim();
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

export function detectMoves(deleted: MoveBlock[], added: MoveBlock[], minimumLines = 3): MoveMatch[] {
  const candidates = new Map<string, MoveBlock[]>();
  for (const block of deleted) {
    if (block.endLine - block.startLine + 1 < minimumLines) continue;
    const key = hash(normalize(block.text));
    candidates.set(key, [...(candidates.get(key) ?? []), block]);
  }
  const used = new Set<MoveBlock>();
  const matches: MoveMatch[] = [];
  for (const block of added) {
    if (block.endLine - block.startLine + 1 < minimumLines) continue;
    const key = hash(normalize(block.text));
    const exact = (candidates.get(key) ?? []).filter((candidate) =>
      !used.has(candidate) && normalize(candidate.text) === normalize(block.text)
    );
    if (exact.length !== 1) continue;
    used.add(exact[0]);
    matches.push({ from: exact[0], to: block, confidence: 'high' });
  }
  return matches.sort((left, right) => left.from.file.localeCompare(right.from.file)
    || left.from.startLine - right.from.startLine
    || left.to.file.localeCompare(right.to.file)
    || left.to.startLine - right.to.startLine);
}
