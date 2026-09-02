export type TokenDeltaKind = 'added' | 'removed' | 'changed';

export interface TokenDelta {
  kind: TokenDeltaKind;
  value: string;
  previous?: string;
}

function tokens(value: string): string[] {
  return value.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|==|!=|=>|&&|\|\||[^\s]/g) ?? [];
}

export function tokenDelta(before: string, after: string): TokenDelta[] {
  const oldTokens = tokens(before);
  const newTokens = tokens(after);
  const table = Array.from({ length: oldTokens.length + 1 }, () => Array<number>(newTokens.length + 1).fill(0));
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] = oldTokens[oldIndex] === newTokens[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const deltas: TokenDelta[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
    if (oldIndex < oldTokens.length && newIndex < newTokens.length && oldTokens[oldIndex] === newTokens[newIndex]) {
      oldIndex++;
      newIndex++;
    } else if (newIndex < newTokens.length && (oldIndex === oldTokens.length || table[oldIndex][newIndex + 1] >= table[oldIndex + 1][newIndex])) {
      deltas.push({ kind: 'added', value: newTokens[newIndex++] });
    } else {
      deltas.push({ kind: 'removed', value: oldTokens[oldIndex++] });
    }
  }
  return deltas;
}

export function pairTokenDelta(before: string, after: string): TokenDelta[] {
  const delta = tokenDelta(before, after);
  const result: TokenDelta[] = [];
  for (let index = 0; index < delta.length; index++) {
    const current = delta[index];
    const next = delta[index + 1];
    if ((current.kind === 'removed' && next?.kind === 'added')
      || (current.kind === 'added' && next?.kind === 'removed')) {
      const removed = current.kind === 'removed' ? current : next;
      const added = current.kind === 'added' ? current : next;
      result.push({ kind: 'changed', value: added.value, previous: removed.value });
      index++;
    } else {
      result.push(current);
    }
  }
  return result;
}
