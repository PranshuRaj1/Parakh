import { hashResumeValidationDiff } from '../resume-validation-hash.js';

export interface FixtureInvariants {
  parsedFiles: string[];
  reviewableFiles: string[];
  ignoredFiles: string[];
  logicalReviewCalls: number;
}

export interface FixtureCase {
  id: string;
  description: string;
  purpose: string;
  currentBehavior: string[];
  content: string;
  expectedInvariants: FixtureInvariants;
}

export interface LoadedFixture extends FixtureCase {
  resumeValidationHash: string;
}

function diffLines(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function modifiedFile(
  path: string,
  patch: string[],
  beforeHash = '1111111',
  afterHash = '2222222'
): string {
  return diffLines(
    `diff --git a/${path} b/${path}`,
    `index ${beforeHash}..${afterHash} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...patch
  );
}

function addedFile(path: string, patch: string[]): string {
  return diffLines(
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    ...patch
  );
}

function deletedFile(path: string, patch: string[]): string {
  return diffLines(
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 2222222..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    ...patch
  );
}

function renamedFile(beforePath: string, afterPath: string, patch: string[]): string {
  return diffLines(
    `diff --git a/${beforePath} b/${afterPath}`,
    'similarity index 82%',
    `rename from ${beforePath}`,
    `rename to ${afterPath}`,
    'index 1111111..2222222 100644',
    `--- a/${beforePath}`,
    `+++ b/${afterPath}`,
    ...patch
  );
}

function fixture(
  id: string,
  description: string,
  purpose: string,
  currentBehavior: string,
  content: string,
  expectedInvariants: FixtureInvariants
): FixtureCase {
  return {
    id,
    description,
    purpose,
    currentBehavior: [currentBehavior],
    content,
    expectedInvariants,
  };
}

function invariants(parsedFiles: string[], ignoredFiles: string[] = []): FixtureInvariants {
  const ignored = new Set(ignoredFiles);
  const reviewableFiles = parsedFiles.filter((path) => !ignored.has(path));
  return {
    parsedFiles,
    reviewableFiles,
    ignoredFiles,
    logicalReviewCalls: reviewableFiles.length,
  };
}

export function buildLargeGeneratedDiff(lines = 1_000): string {
  const additions = Array.from(
    { length: lines },
    (_, index) => `+export const generated_${index} = ${index};`
  );

  return diffLines(
    'diff --git a/dist/generated.ts b/dist/generated.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/dist/generated.ts',
    `@@ -0,0 +1,${lines} @@`,
    ...additions
  );
}

const normalEdit = modifiedFile('src/example.ts', [
  '@@ -1,3 +1,3 @@',
  '-export const timeout = 1000;',
  '+export const timeout = 2000;',
  ' export const enabled = true;',
]);

const multipleHunks = modifiedFile('src/service.ts', [
  '@@ -1,3 +1,3 @@',
  '-const retries = 1;',
  '+const retries = 3;',
  ' export function start() {}',
  '@@ -20,3 +20,3 @@',
  '-export const secure = false;',
  '+export const secure = true;',
  ' export function stop() {}',
]);

const newAndDeletedFiles = [
  addedFile('src/new.ts', [
    '@@ -0,0 +1 @@',
    '+export const created = true;',
  ]),
  deletedFile('src/old.ts', [
    '@@ -1 +0,0 @@',
    '-export const obsolete = true;',
  ]),
].join('');

const rename = renamedFile('src/old-name.ts', 'src/new-name.ts', [
  '@@ -1 +1 @@',
  "-export const name = 'old';",
  "+export const name = 'new';",
]);

const pathWithSpaces = modifiedFile('src/my file.ts', [
  '@@ -1 +1 @@',
  "-export const label = 'before';",
  "+export const label = 'after';",
]);

const repeatedBlocks = modifiedFile('src/repeated.ts', [
  '@@ -1,6 +1,6 @@',
  "-register('alpha');",
  "-register('beta');",
  " register('common');",
  " register('common');",
  "+register('alpha');",
  "+register('beta');",
]);

const crossFileMove = [
  modifiedFile('src/old-location.ts', [
    '@@ -1,4 +0,0 @@',
    '-export function calculateTotal(values: number[]) {',
    '-  return values.reduce((sum, value) => sum + value, 0);',
    '-}',
    '-',
  ]),
  modifiedFile('src/new-location.ts', [
    '@@ -1,0 +1,4 @@',
    '+export function calculateTotal(values: number[]) {',
    '+  return values.reduce((sum, value) => sum + value, 0);',
    '+}',
    '+',
  ], '3333333', '4444444'),
].join('');

const behaviorAuthFlow = [
  modifiedFile('src/routes/login.ts', [
    '@@ -1 +1,2 @@',
    "+import { beginLogin } from '../auth/provider';",
    " export const loginRoute = '/login';",
  ]),
  modifiedFile('src/auth/provider.ts', [
    '@@ -1 +1,3 @@',
    "-export const provider = 'none';",
    '+export function beginLogin() {',
    "+  return 'oauth';",
    '+}',
  ]),
  modifiedFile('src/config/auth.ts', [
    '@@ -1 +1 @@',
    "-export const callbackUrl = '';",
    "+export const callbackUrl = '/auth/callback';",
  ]),
  modifiedFile('tests/login.test.ts', [
    '@@ -1 +1,2 @@',
    " test('login', () => {",
    "+  expect(beginLogin()).toBe('oauth');",
    ' });',
  ]),
].join('');

const lockfileOnly = modifiedFile('package-lock.json', [
  '@@ -1 +1 @@',
  '-{"lockfileVersion":2}',
  '+{"lockfileVersion":3}',
]);

const lockfileWithSource = [
  lockfileOnly,
  modifiedFile('src/index.ts', [
    '@@ -1 +1 @@',
    '-export const version = 1;',
    '+export const version = 2;',
  ]),
].join('');

const unicodePath = modifiedFile('src/नमस्ते.ts', [
  '@@ -1 +1 @@',
  "-export const greeting = 'hello';",
  "+export const greeting = 'नमस्ते 🐍';",
]);

const moreThanOneBatch = ['one', 'two', 'three', 'four', 'five', 'six']
  .map((name, index) => modifiedFile(`src/${name}.ts`, [
    '@@ -1 +1 @@',
    '-export const value = 0;',
    `+export const value = ${index + 1};`,
  ]))
  .join('');

const binaryFile = diffLines(
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ'
);

const noNewlineMarker = diffLines(
  'diff --git a/src/eof.ts b/src/eof.ts',
  'index 1111111..2222222 100644',
  '--- a/src/eof.ts',
  '+++ b/src/eof.ts',
  '@@ -1 +1 @@',
  '-export const eof = false;',
  '\\ No newline at end of file',
  '+export const eof = true;',
  '\\ No newline at end of file'
);

const modeOnlyChange = diffLines(
  'diff --git a/scripts/deploy.sh b/scripts/deploy.sh',
  'old mode 100644',
  'new mode 100755'
);

const malformedHunk = diffLines(
  'diff --git a/src/broken.ts b/src/broken.ts',
  'index 1111111..2222222 100644',
  '--- a/src/broken.ts',
  '+++ b/src/broken.ts',
  '@@ -1,4 +1,4 @@',
  '-export const broken = false;',
  '+export const broken = true;'
);

const submodulePointer = diffLines(
  'diff --git a/vendor/library b/vendor/library',
  'index 1111111..2222222 160000',
  '--- a/vendor/library',
  '+++ b/vendor/library',
  '@@ -1 +1 @@',
  '-Subproject commit 1111111111111111111111111111111111111111',
  '+Subproject commit 2222222222222222222222222222222222222222'
);

export const FIXTURE_CASES: FixtureCase[] = [
  fixture(
    'normal-edit',
    'One ordinary TypeScript edit',
    'Establish the smallest successful current review',
    'One file is sent to one logical review call',
    normalEdit,
    invariants(['src/example.ts'])
  ),
  fixture(
    'multiple-hunks',
    'Two distant hunks in one file',
    'Prove the current unit is a file rather than a hunk',
    'Both hunks are sent in one file review',
    multipleHunks,
    invariants(['src/service.ts'])
  ),
  fixture(
    'new-and-deleted-files',
    'One new file and one deleted file',
    'Capture /dev/null headers and independent file review',
    'New and deleted files are reviewed independently',
    newAndDeletedFiles,
    invariants(['src/new.ts', 'src/old.ts'])
  ),
  fixture(
    'renamed-file',
    'A renamed file with a small edit',
    'Record the path selected by the current parser',
    'The file is keyed by its new path',
    rename,
    invariants(['src/new-name.ts'])
  ),
  fixture(
    'path-with-spaces',
    'A source path containing spaces',
    'Prevent accidental whitespace splitting',
    'Spaces remain part of the parsed path',
    pathWithSpaces,
    invariants(['src/my file.ts'])
  ),
  fixture(
    'binary-file',
    'A binary image change',
    'Record that the current parser treats binary metadata as a file diff',
    'Binary metadata reaches one logical review call',
    binaryFile,
    invariants(['assets/logo.png'])
  ),
  fixture(
    'no-newline-marker',
    "A diff containing Git's no-newline marker",
    'Capture raw prompt input and existing finding suppression',
    'The marker remains in the file patch',
    noNewlineMarker,
    invariants(['src/eof.ts'])
  ),
  fixture(
    'repeated-blocks',
    'Repeated identical statements in one file',
    'Provide a future false-positive case for move detection',
    'No move detection is performed',
    repeatedBlocks,
    invariants(['src/repeated.ts'])
  ),
  fixture(
    'cross-file-move',
    'An unchanged function moved between files',
    'Quantify the future semantic move reduction',
    'Deletion and addition are two independent reviews',
    crossFileMove,
    invariants(['src/old-location.ts', 'src/new-location.ts'])
  ),
  fixture(
    'behavior-auth-flow',
    'Route, provider, configuration, and test changes for one sign-in behavior',
    'Measure the future behavior-grouping improvement',
    'Four related files are reviewed independently',
    behaviorAuthFlow,
    invariants([
      'src/routes/login.ts',
      'src/auth/provider.ts',
      'src/config/auth.ts',
      'tests/login.test.ts',
    ])
  ),
  fixture(
    'empty-diff',
    'An empty diff payload',
    'Cover PRs with no reviewable textual changes',
    'No files or review calls are produced',
    '',
    invariants([])
  ),
  fixture(
    'large-generated',
    'A deterministic thousand-line generated file',
    'Measure current input growth without committing a huge fixture',
    'Unrecognized generated files are reviewed',
    buildLargeGeneratedDiff(),
    invariants(['dist/generated.ts'])
  ),
  fixture(
    'lockfile-only',
    'A package-lock-only update',
    'Freeze the current ignored-file policy',
    'The lockfile is parsed and then ignored',
    lockfileOnly,
    invariants(['package-lock.json'], ['package-lock.json'])
  ),
  fixture(
    'lockfile-with-source',
    'A lockfile and source edit together',
    'Verify ignored and reviewable files can coexist',
    'Only the source file is reviewed',
    lockfileWithSource,
    invariants(['package-lock.json', 'src/index.ts'], ['package-lock.json'])
  ),
  fixture(
    'mode-only-change',
    'An executable-bit-only change',
    'Record current treatment of a diff with no hunks',
    'The metadata-only file is reviewed',
    modeOnlyChange,
    invariants(['scripts/deploy.sh'])
  ),
  fixture(
    'unicode-path',
    'Unicode path and source content',
    'Exercise UTF-8 hashing and path preservation',
    'Unicode remains in the path and patch',
    unicodePath,
    invariants(['src/नमस्ते.ts'])
  ),
  fixture(
    'malformed-hunk',
    'A truncated hunk body',
    'Record that the current splitter does not validate hunks',
    'The file chunk is still returned',
    malformedHunk,
    invariants(['src/broken.ts'])
  ),
  fixture(
    'submodule-pointer',
    'A Git submodule commit-pointer update',
    'Record current treatment of submodule metadata',
    'The submodule diff receives one review',
    submodulePointer,
    invariants(['vendor/library'])
  ),
  fixture(
    'more-than-one-batch',
    'Six changed source files',
    'Exercise the current five-file batch boundary',
    'All six files are reviewed across two batches',
    moreThanOneBatch,
    invariants([
      'src/one.ts',
      'src/two.ts',
      'src/three.ts',
      'src/four.ts',
      'src/five.ts',
      'src/six.ts',
    ])
  ),
];

export async function loadFixtureCorpus(): Promise<LoadedFixture[]> {
  const ids = new Set<string>();
  const loaded: LoadedFixture[] = [];

  for (const fixtureCase of FIXTURE_CASES) {
    if (ids.has(fixtureCase.id)) throw new Error(`duplicate fixture id: ${fixtureCase.id}`);
    if (fixtureCase.content.includes('\r\n')) throw new Error(`fixture ${fixtureCase.id} contains CRLF`);
    ids.add(fixtureCase.id);
    loaded.push({
      ...fixtureCase,
      resumeValidationHash: await hashResumeValidationDiff(fixtureCase.content),
    });
  }

  return loaded.sort((left, right) => left.id.localeCompare(right.id));
}
