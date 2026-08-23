import type { CodeSymbolKind, IndexedSymbol } from '@parakh/shared';

const DECLARATION = /^\s*(export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([\s\S]*?\)\s*=>)/;
const METHOD = /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([\s\S]*?\)\s*\{/;
const TEST = /^\s*(test|it|describe)\s*\(/;
const IMPORT = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g;

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

function endLine(lines: string[], sanitized: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const char of sanitized[i]) {
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

function stripStringsAndComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (value) => value.replace(/[^\n]/g, ' '));
}

export function parseTypeScriptFile(
  repo: string,
  commitSha: string,
  path: string,
  source: string
): IndexedSymbol[] {
  const lines = source.split(/\r?\n/);
  const sanitized = stripStringsAndComments(source).split(/\r?\n/);
  const imports = [...source.matchAll(IMPORT)].map((match) => match[1]);
  const symbols: IndexedSymbol[] = [];

  lines.forEach((line, index) => {
    const header = lines.slice(index, index + 10).join('\n');
    const declarationMatch = DECLARATION.exec(header);
    const methodMatch = declarationMatch ? null : METHOD.exec(header);
    const testMatch = declarationMatch || methodMatch || TEST.exec(line);
    const declaration = declarationMatch || methodMatch || testMatch;
    if (!declaration) return;
    const symbolName = declarationMatch
      ? declaration.slice(2, 7).find(Boolean) ?? ''
      : declaration[1];
    if (!symbolName || ['if', 'for', 'while', 'switch', 'catch'].includes(symbolName)) return;
    const end = endLine(lines, sanitized, index);
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
