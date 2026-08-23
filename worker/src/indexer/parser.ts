import type { CodeSymbolKind, IndexedSymbol } from '@parakh/shared';

const DECLARATION = /^(export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^\n]*\)\s*=>)/;
const METHOD = /^(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{/;
const TEST = /^(?:test|it|describe)\s*\(/;
const IMPORT = /^import\s+(?:type\s+)?(?:[^'\"]+from\s+)?['\"]([^'\"]+)['\"]/;

function hash(value: string): string {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

function normalize(value: string): string {
  return value
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/['\"][^'\"]*['\"]/g, 'STR')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'NUM')
    .replace(/\s+/g, ' ')
    .trim();
}

function kind(match: RegExpExecArray): CodeSymbolKind {
  if (match[2]) return 'function';
  if (match[3]) return 'class';
  if (match[4]) return 'interface';
  if (match[5]) return 'type';
  return 'function';
}

function name(match: RegExpExecArray): string {
  return match[2] || match[3] || match[4] || match[5] || match[6] || '';
}

function endLine(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const char of lines[i]) {
      if (char === '{') {
        depth++;
        opened = true;
      } else if (char === '}' && opened) {
        depth--;
      }
    }
    if (opened && depth <= 0) return i + 1;
  }
  return Math.min(lines.length, start + 1);
}

export function parseTypeScriptFile(
  repo: string,
  commitSha: string,
  path: string,
  source: string
): IndexedSymbol[] {
  const lines = source.split(/\r?\n/);
  const imports = lines.map((line) => IMPORT.exec(line)?.[1]).filter((value): value is string => Boolean(value));
  const symbols: IndexedSymbol[] = [];

  lines.forEach((line, index) => {
    const declarationMatch = DECLARATION.exec(line);
    const methodMatch = declarationMatch ? null : METHOD.exec(line);
    const testMatch = declarationMatch || methodMatch || (TEST.test(line)
      ? ['test', '', '', '', '', '', line.match(/^(test|it|describe)/)?.[1] ?? 'test'] as unknown as RegExpExecArray
      : null);
    const declaration = declarationMatch || methodMatch || testMatch;
    if (!declaration) return;
    const symbolName = name(declaration);
    if (!symbolName || ['if', 'for', 'while', 'switch', 'catch'].includes(symbolName)) return;
    const end = endLine(lines, index);
    const body = lines.slice(index, end).join('\n');
    const normalizedBody = normalize(body);
    const symbolKind = declarationMatch ? kind(declaration) : 'method';
    symbols.push({
      id: `${path}:${index + 1}:${symbolName}`,
      repo,
      commitSha,
      path,
      qualifiedName: `${path}#${symbolName}`,
      kind: symbolKind,
      startLine: index + 1,
      endLine: end,
      signature: line.trim(),
      exported: Boolean(declaration[1]),
      normalizedBody,
      bodyHash: hash(normalizedBody),
      imports,
    });
  });

  return symbols;
}

export function normalizeSource(source: string): string {
  return normalize(source);
}

export function contentHash(source: string): string {
  return hash(source);
}
