import type {
  EvalCase,
  EvalPipeline,
  EvalRun,
  EvalRunConfig,
  PipelineLabel,
  PipelineVersion,
} from './types.js';

export async function hashEvalCase(testCase: EvalCase): Promise<string> {
  const snapshot = JSON.stringify({
    repo: testCase.repo,
    baseSha: testCase.baseSha,
    headSha: testCase.headSha,
    diff: testCase.diff,
    files: Object.entries(testCase.files).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshot)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function resolvePipelineVersion(
  label: PipelineLabel,
  branchRef: string,
  resolveSha: (ref: string) => Promise<string>
): Promise<PipelineVersion> {
  const resolvedSha = (await resolveSha(branchRef)).trim();
  if (!/^[0-9a-f]{40}$/i.test(resolvedSha)) {
    throw new Error(`Could not resolve pipeline ref ${branchRef} to a commit SHA`);
  }
  return { label, branchRef, resolvedSha };
}

export async function runEvalCase(
  pipeline: EvalPipeline,
  version: PipelineVersion,
  testCase: EvalCase,
  goldSetVersion: string,
  config: EvalRunConfig,
  now: () => number = Date.now
): Promise<EvalRun> {
  const startedAt = now();
  const output = await pipeline.review(testCase, config);
  return {
    caseId: testCase.id,
    caseSnapshotHash: await hashEvalCase(testCase),
    goldSetVersion,
    pipeline: version,
    config,
    output,
    latencyMs: Math.max(0, now() - startedAt),
  };
}

export function assertComparableRuns(left: EvalRun, right: EvalRun): void {
  if (left.caseId !== right.caseId) {
    throw new Error(`Eval case mismatch: ${left.caseId} != ${right.caseId}`);
  }
  if (left.caseSnapshotHash !== right.caseSnapshotHash) {
    throw new Error(`Eval snapshot mismatch for case ${left.caseId}`);
  }
  if (left.goldSetVersion !== right.goldSetVersion) {
    throw new Error(
      `Gold set mismatch: ${left.goldSetVersion} != ${right.goldSetVersion}`
    );
  }
  if (JSON.stringify(left.config) !== JSON.stringify(right.config)) {
    throw new Error(`Eval config mismatch for case ${left.caseId}`);
  }
}

export async function runPairedCase(input: {
  oldPipeline: EvalPipeline;
  newPipeline: EvalPipeline;
  oldVersion: PipelineVersion;
  newVersion: PipelineVersion;
  testCase: EvalCase;
  goldSetVersion: string;
  config: EvalRunConfig;
}): Promise<{ oldRun: EvalRun; newRun: EvalRun }> {
  if (input.oldVersion.label !== 'old' || input.newVersion.label !== 'new') {
    throw new Error('Paired eval requires old and new pipeline labels');
  }

  const [oldRun, newRun] = await Promise.all([
    runEvalCase(
      input.oldPipeline,
      input.oldVersion,
      input.testCase,
      input.goldSetVersion,
      input.config
    ),
    runEvalCase(
      input.newPipeline,
      input.newVersion,
      input.testCase,
      input.goldSetVersion,
      input.config
    ),
  ]);
  assertComparableRuns(oldRun, newRun);
  return { oldRun, newRun };
}
