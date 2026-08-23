import type { IndexedSymbol, ReuseCandidate } from '@parakh/shared';

function tokenSet(value: string): Set<string> {
  return new Set(value.split(/[^A-Za-z0-9_$]+/).filter((token) => token.length > 2));
}

function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

function ref(symbol: IndexedSymbol) {
  return {
    repo: symbol.repo,
    commitSha: symbol.commitSha,
    path: symbol.path,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}

export function findReuseCandidates(
  changed: IndexedSymbol[],
  existing: IndexedSymbol[],
  limit = 5
): ReuseCandidate[] {
  const candidates: ReuseCandidate[] = [];
  for (const source of changed) {
    for (const target of existing) {
      if (source.id === target.id || source.path === target.path && source.bodyHash === target.bodyHash) continue;
      const signals: string[] = [];
      let score = 0;
      if (source.bodyHash === target.bodyHash) {
        score = 1;
        signals.push('exact normalized body match');
      } else {
        const bodyScore = similarity(source.normalizedBody, target.normalizedBody);
        if (bodyScore >= 0.72) {
          score = bodyScore;
          signals.push(`${Math.round(bodyScore * 100)} percent normalized token similarity`);
        }
        if (source.signature.replace(/\s/g, '') === target.signature.replace(/\s/g, '')) {
          score = Math.max(score, 0.6);
          signals.push('matching signature');
        }
        if (source.imports.some((item) => target.imports.includes(item))) signals.push('shared imports');
      }
      if (score >= 0.72 || signals.length >= 2) {
        candidates.push({
          changedSymbol: ref(source),
          candidate: ref(target),
          score: Number(score.toFixed(2)),
          signals,
          recommendation: `Consider reusing ${target.qualifiedName} or extracting the shared behavior. Confirm behavior differences first.`,
        });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}
