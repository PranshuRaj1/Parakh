import type { CodeSymbolKind, IndexedSymbol } from '@parakh/shared';

const DECLARATION = /^\s*(export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([\s\S]*?\)\s*=>)/;
const METHOD = /^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([\s\S]*?\)\s*\{/;
const TEST = /^\s*(test|it|describe)\s*\(/;
const IMPORT = /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g;
const GENERIC_IMPORT = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|from\s+|require\s*\(\s*|dofile\s*\(\s*)['\"]([^'\"]+)['\"]/g;

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

type AdapterKind = Extract<CodeSymbolKind, 'function' | 'method' | 'class' | 'interface' | 'type'>;

interface Declaration {
  name: string;
  kind: AdapterKind;
  exported: boolean;
}

function declarationForLine(line: string, extension: string): Declaration | null {
  if (/^(?:ts|tsx|js|jsx)$/.test(extension)) return null;
  if (extension === 'py') {
    const match = line.match(/^\s*(?:(export)\s+)?(?:async\s+)?(def)\s+([A-Za-z_]\w*)\s*\(/)
      ?? line.match(/^\s*class\s+([A-Za-z_]\w*)\b/);
    if (!match) return null;
    if (match[3]) return { name: match[3], kind: 'function', exported: Boolean(match[1]) };
    return { name: match[1], kind: 'class', exported: true };
  }
  if (extension === 'go') {
    const functionMatch = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) return { name: functionMatch[1], kind: 'function', exported: /^[A-Z]/.test(functionMatch[1]) };
    const typeMatch = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
    if (typeMatch) return { name: typeMatch[1], kind: typeMatch[2] === 'interface' ? 'interface' : 'class', exported: /^[A-Z]/.test(typeMatch[1]) };
    return null;
  }
  if (extension === 'java') {
    const typeMatch = line.match(/^\s*(?:(?:public|private|protected|abstract|final|static)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/);
    if (typeMatch) return { name: typeMatch[2], kind: typeMatch[1] === 'interface' ? 'interface' : 'class', exported: /\bpublic\b/.test(line) };
    const methodMatch = line.match(/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|\s)+)?[A-Za-z_<>,?\[\].]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws\b[^\{]+)?\{/);
    if (methodMatch) return { name: methodMatch[1], kind: 'method', exported: /\bpublic\b/.test(line) };
    return null;
  }
  if (extension === 'lua') {
    const match = line.match(/^\s*(?:local\s+)?function\s+([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*)\s*\(/);
    if (match) return { name: match[1].replace(/[.:]/g, '_'), kind: 'function', exported: !/^\s*local\b/.test(line) };
    return null;
  }
  return null;
}

function genericEndLine(lines: string[], sanitized: string[], start: number, extension: string): number {
  if (extension === 'py') {
    const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
    for (let index = start + 1; index < lines.length; index++) {
      if (lines[index].trim() && (lines[index].match(/^\s*/)?.[0].length ?? 0) <= indentation) return index;
    }
    return lines.length;
  }
  if (extension === 'lua') {
    for (let index = start + 1; index < lines.length; index++) {
      if (/^\s*end\b/.test(lines[index])) return index + 1;
    }
    return Math.min(lines.length, start + 1);
  }
  return endLine(lines, sanitized, start);
}

function parseLanguageFile(
  repo: string,
  commitSha: string,
  path: string,
  source: string,
  extension: string,
): IndexedSymbol[] {
  const lines = source.split(/\r?\n/);
  const sanitized = stripStringsAndComments(source).split(/\r?\n/);
  const imports = [...source.matchAll(GENERIC_IMPORT)].map((match) => match[1]);
  const symbols: IndexedSymbol[] = [];
  lines.forEach((line, index) => {
    const declaration = declarationForLine(line, extension);
    if (!declaration) return;
    const end = genericEndLine(lines, sanitized, index, extension);
    const body = lines.slice(index, end).join('\n');
    const normalizedBody = normalize(body);
    symbols.push({
      id: `${path}:${index + 1}:${declaration.name}`,
      repo,
      commitSha,
      path,
      qualifiedName: `${path}#${declaration.name}`,
      kind: declaration.kind,
      startLine: index + 1,
      endLine: end,
      signature: line.trim(),
      exported: declaration.exported,
      normalizedBody,
      bodyHash: hash(normalizedBody),
      imports,
    });
  });
  return symbols;
}

export function parseSourceFile(
  repo: string,
  commitSha: string,
  path: string,
  source: string,
): IndexedSymbol[] {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (/^(?:ts|tsx|js|jsx)$/.test(extension)) return parseTypeScriptFile(repo, commitSha, path, source);
  if (/^(?:py|go|java|lua)$/.test(extension)) return parseLanguageFile(repo, commitSha, path, source, extension);
  return [];
}
