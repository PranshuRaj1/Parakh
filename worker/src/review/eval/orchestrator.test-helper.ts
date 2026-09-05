import { judgeFindingTwice, type JudgeCache, type JudgeTransport } from './judge.js';
import {
  compareCaseMetrics,
  computeCaseMetrics,
  computeNoiseFloor,
} from './metrics.js';
import {
  assertComparableRuns,
  runEvalCase,
} from './runner.js';
import type {
  ComparisonAssessment,
  EvalCase,
  EvalCaseReport,
  EvalDefect,
  EvalPipeline,
  EvalRun,
  EvalRunConfig,
  EvaluatedRun,
  Finding,
  FindingAdjudication,
  PipelineVersion,
  ReviewCache,
  RunSlot,
} from './types.js';

function windowAroundLine(
  content: string,
  line: number,
  maxChars: number
): string {
  const lines = content.split('\n');
  const targetIndex = Math.max(
    0,
    Math.min(lines.length - 1, Math.max(1, line) - 1)
  );
  if (maxChars <= 0) return '';
  if (lines[targetIndex].length + 1 > maxChars) {
    return lines[targetIndex].slice(0, maxChars);
  }
  const before: string[] = [];
  const after: string[] = [];
  let used = lines[targetIndex].length + 1;
  let left = targetIndex - 1;
  let right = targetIndex + 1;
  while (used < maxChars && (left >= 0 || right < lines.length)) {
    if (left >= 0) {
      before.unshift(lines[left]);
      used += lines[left].length + 1;
      left--;
    }
    if (used >= maxChars) break;
    if (right < lines.length) {
      after.push(lines[right]);
      used += lines[right].length + 1;
      right++;
    }
  }
  return [...before, lines[targetIndex], ...after].join('\n');
}

function codeContext(
  testCase: EvalCase,
  finding: Finding,
  budget: number
): string {
  const maxChars = budget * 4;
  const entries = Object.entries(testCase.files).sort(([left], [right]) =>
    left === finding.file ? -1 : right === finding.file ? 1 : left.localeCompare(right)
  );
  if (entries.length === 0) return '';
  const [[file, content], ...rest] = entries;
  const fileContext = content.length <= maxChars
    ? content
    : windowAroundLine(content, finding.line ?? 1, maxChars);
  const remaining = Math.max(0, maxChars - fileContext.length);
  const restContext = rest
    .map(([path, content]) => `FILE: ${path}\n${content}`)
    .join('\n\n')
    .slice(0, remaining);
  if (!restContext) return fileContext;
  return `FILE: ${file}\n${fileContext}\n\n${restContext}`;
}

async function evaluateRun(input: {
  run: EvalRun;
  testCase: EvalCase;
  defects: EvalDefect[];
  judge: JudgeTransport;
  cache: JudgeCache;
  config: EvalRunConfig;
}): Promise<EvaluatedRun> {
  const adjudications: FindingAdjudication[] = [];
  const matchedDefectIds = new Set<string>();

  for (const finding of input.run.output.finalFindings) {
    const result = await judgeFindingTwice({
      caseId: input.testCase.id,
      goldSetVersion: input.run.goldSetVersion,
      judgePromptVersion: 'judge-v1',
      finding,
      defects: input.defects,
      codeContext: codeContext(
        input.testCase,
        finding,
        input.config.judgeContextBudget ?? input.config.contextBudget
      ),
    }, input.judge, input.cache, matchedDefectIds);
    const matchedDefectId = result.verdicts[0].matchedDefectId;
    adjudications.push({
      finding,
      outcome: result.outcome,
      matchedDefectId,
      verdicts: result.verdicts,
      reason: result.outcome === 'needs_human_review'
        ? 'Judge passes disagree or contain conflicting fields.'
        : result.verdicts[0].reason,
    });
    if (result.outcome === 'correct' && matchedDefectId) {
      matchedDefectIds.add(matchedDefectId);
    }
  }

  return {
    run: input.run,
    adjudications,
    metrics: computeCaseMetrics({
      run: input.run,
      defects: input.defects,
      adjudications,
    }),
  };
}

export function assessComparison(input: {
  comparison: ReturnType<typeof compareCaseMetrics>;
  oldNoise: ReturnType<typeof computeNoiseFloor>;
  newNoise: ReturnType<typeof computeNoiseFloor>;
}): ComparisonAssessment {
  const heldOutRate = Math.max(
    input.comparison.oldMetrics.heldOutRate,
    input.comparison.newMetrics.heldOutRate
  );
  if (heldOutRate > 0.2) return 'judge_unstable';

  if (input.comparison.f1Delta === null) {
    if (input.comparison.falsePositiveDelta < 0) return 'better';
    if (input.comparison.falsePositiveDelta > 0) return 'worse';
    const oldFp = input.comparison.oldMetrics.strictFalsePositives ?? 0;
    const newFp = input.comparison.newMetrics.strictFalsePositives ?? 0;
    return oldFp === 0 && newFp === 0 ? 'pass' : 'parity';
  }

  const noise = Math.max(
    Math.abs(input.oldNoise.f1Delta ?? 0),
    Math.abs(input.newNoise.f1Delta ?? 0)
  );
  if (Math.abs(input.comparison.f1Delta) <= noise) return 'parity';
  if (
    input.comparison.f1Delta > 0
    && input.comparison.falsePositiveDelta <= 0
  ) {
    return 'better';
  }
  if (
    input.comparison.f1Delta < 0
    && input.comparison.falsePositiveDelta >= 0
  ) {
    return 'worse';
  }
  return 'mixed';
}

export async function evaluateCase(input: {
  testCase: EvalCase;
  defects: EvalDefect[];
  goldSetVersion: string;
  oldPipeline: EvalPipeline;
  newPipeline: EvalPipeline;
  oldVersion: PipelineVersion;
  newVersion: PipelineVersion;
  config: EvalRunConfig;
  judge: JudgeTransport;
  cache: JudgeCache;
  reviewCache?: ReviewCache;
}): Promise<EvalCaseReport> {
  const run = (pipeline: EvalPipeline, version: PipelineVersion, slot: RunSlot) =>
    runEvalCase(
      pipeline,
      version,
      input.testCase,
      input.goldSetVersion,
      input.config,
      undefined,
      input.reviewCache,
      slot
    );
  const oldA = await run(input.oldPipeline, input.oldVersion, 'oldA');
  const oldB = await run(input.oldPipeline, input.oldVersion, 'oldB');
  const newA = await run(input.newPipeline, input.newVersion, 'newA');
  const newB = await run(input.newPipeline, input.newVersion, 'newB');

  assertComparableRuns(oldA, newA);
  assertComparableRuns(oldB, newB);

  const evaluate = (candidate: EvalRun) => evaluateRun({
    run: candidate,
    testCase: input.testCase,
    defects: input.defects,
    judge: input.judge,
    cache: input.cache,
    config: input.config,
  });
  const evaluatedOldA = await evaluate(oldA);
  const evaluatedOldB = await evaluate(oldB);
  const evaluatedNewA = await evaluate(newA);
  const evaluatedNewB = await evaluate(newB);
  const oldNoiseFloor = computeNoiseFloor({
    firstRun: oldA,
    secondRun: oldB,
    firstMetrics: evaluatedOldA.metrics,
    secondMetrics: evaluatedOldB.metrics,
  });
  const newNoiseFloor = computeNoiseFloor({
    firstRun: newA,
    secondRun: newB,
    firstMetrics: evaluatedNewA.metrics,
    secondMetrics: evaluatedNewB.metrics,
  });
  const comparison = compareCaseMetrics(
    evaluatedOldA.metrics,
    evaluatedNewA.metrics
  );

  return {
    caseId: input.testCase.id,
    oldNoiseFloor,
    newNoiseFloor,
    comparison,
    assessment: assessComparison({
      comparison,
      oldNoise: oldNoiseFloor,
      newNoise: newNoiseFloor,
    }),
    runs: {
      oldA: evaluatedOldA,
      oldB: evaluatedOldB,
      newA: evaluatedNewA,
      newB: evaluatedNewB,
    },
  };
}
