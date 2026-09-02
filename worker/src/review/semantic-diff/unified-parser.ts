export type EvidenceKind = 'edit' | 'add' | 'delete' | 'move' | 'context';

export interface EvidenceRef {
  file: string;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  patchHash: string;
  kind: EvidenceKind;
}

export interface SemanticHunk {
  file: string;
  oldPath: string | null;
  newPath: string | null;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: string[];
  evidence: EvidenceRef;
}

export interface SemanticFileDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: SemanticHunk[];
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquotePath(value: string): string {
  const path = value.trim();
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1)
    .replace(/\\([\\"])/g, '$1')
    .replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function stripPrefix(path: string | null, prefix: string): string | null {
  if (!path || path === '/dev/null') return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parseHeaderPaths(line: string): [string | null, string | null] {
  const match = line.match(/^diff --git (.+)$/);
  if (!match) return [null, null];
  const paths = match[1].match(/^("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/);
  if (!paths) return [null, null];
  return [stripPrefix(unquotePath(paths[1]), 'a/'), stripPrefix(unquotePath(paths[2]), 'b/')];
}

function parsePatchPaths(section: string, headerPaths: [string | null, string | null]): [string | null, string | null] {
  const oldPath = section.match(/^--- (.+)$/m)?.[1] ?? null;
  const newPath = section.match(/^\+\+\+ (.+)$/m)?.[1] ?? null;
  return [
    stripPrefix(oldPath ? unquotePath(oldPath.split('\t')[0]) : headerPaths[0], 'a/'),
    stripPrefix(newPath ? unquotePath(newPath.split('\t')[0]) : headerPaths[1], 'b/'),
  ];
}

function hunkKind(oldCount: number, newCount: number): EvidenceKind {
  if (oldCount === 0) return 'add';
  if (newCount === 0) return 'delete';
  return 'edit';
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function parseSection(section: string): Promise<SemanticFileDiff> {
  const [headerOldPath, headerNewPath] = parseHeaderPaths(section.split('\n', 1)[0] ?? '');
  const [oldPath, newPath] = parsePatchPaths(section, [headerOldPath, headerNewPath]);
  const lines = section.split('\n');
  const hunks: SemanticHunk[] = [];

  for (let index = 0; index < lines.length; index++) {
    const header = lines[index];
    const match = header.match(HUNK_HEADER);
    if (!match) continue;
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    const hunkLines: string[] = [];
    let oldLine = oldStart;
    let newLine = newStart;
    for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break;
      if (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' ') && line !== '\\ No newline at end of file') break;
      hunkLines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) newLine++;
      else if (line.startsWith('-') && !line.startsWith('---')) oldLine++;
      else if (line.startsWith(' ')) { oldLine++; newLine++; }
    }
    const rawHunk = [header, ...hunkLines].join('\n');
    hunks.push({
      file: newPath ?? oldPath ?? 'unknown',
      oldPath,
      newPath,
      oldStart,
      oldCount,
      newStart,
      newCount,
      header,
      lines: hunkLines,
      evidence: {
        file: newPath ?? oldPath ?? 'unknown',
        oldStart: oldCount > 0 ? oldStart : undefined,
        oldEnd: oldCount > 0 ? oldStart + oldCount - 1 : undefined,
        newStart: newCount > 0 ? newStart : undefined,
        newEnd: newCount > 0 ? newStart + newCount - 1 : undefined,
        patchHash: await sha256(rawHunk),
        kind: hunkKind(oldCount, newCount),
      },
    });
  }

  return {
    oldPath,
    newPath,
    hunks,
    binary: /^Binary files /m.test(section),
  };
}

export async function parseUnifiedDiff(diff: string): Promise<SemanticFileDiff[]> {
  const sections = diff.split(/^diff --git /m).slice(1).map((section) => `diff --git ${section}`);
  return Promise.all(sections.map(parseSection));
}
