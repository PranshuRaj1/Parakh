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
  FindingAdjudication,
  PipelineVersion,
} from './types.js';

function codeContext(testCase: EvalCase, file: string, budget: number): string {
  return Object.entries(testCase.files)
    .sort(([left], [right]) =>
      left === file ? -1 : right === file ? 1 : left.localeCompare(right)
    )
    .map(([path, content]) => `FILE: ${path}\n${content}`)
    .join('\n\n')
    .slice(0, budget * 4);
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
        finding.file,
        input.config.contextBudget
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
    return 'inconclusive';
  }

  const noise = Math.max(
    Math.abs(input.oldNoise.f1Delta ?? 0),
    Math.abs(input.newNoise.f1Delta ?? 0)
  );
  if (Math.abs(input.comparison.f1Delta) <= noise) return 'inconclusive';
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
}): Promise<EvalCaseReport> {
  const run = (pipeline: EvalPipeline, version: PipelineVersion) =>
    runEvalCase(
      pipeline,
      version,
      input.testCase,
      input.goldSetVersion,
      input.config
    );
  const oldA = await run(input.oldPipeline, input.oldVersion);
  const oldB = await run(input.oldPipeline, input.oldVersion);
  const newA = await run(input.newPipeline, input.newVersion);
  const newB = await run(input.newPipeline, input.newVersion);

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
