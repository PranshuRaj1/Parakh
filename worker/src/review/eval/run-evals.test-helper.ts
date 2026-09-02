import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadBranchPipeline } from './branch-pipeline.test-helper.js';
import { loadEvalCorpus } from './corpus.test-helper.js';
import { FileJudgeCache } from './file-judge-cache.test-helper.js';
import {
  resolveGitPipelineVersion,
  withDetachedWorktree,
} from './git-worktree.test-helper.js';
import {
  DEFAULT_EVAL_JUDGE_MODEL,
  GroqJudgeTransport,
} from './groq-judge.js';
import { evaluateCase } from './orchestrator.test-helper.js';
import type {
  ComparisonAssessment,
  EvalReport,
  EvalRunConfig,
} from './types.js';

const optionNames = new Map([
  ['--old-ref', 'oldRef'],
  ['--new-ref', 'newRef'],
  ['--corpus', 'corpus'],
  ['--output', 'output'],
  ['--reviewer-model', 'reviewerModel'],
  ['--judge-model', 'judgeModel'],
  ['--context-budget', 'contextBudget'],
  ['--timeout-ms', 'timeoutMs'],
] as const);

function parseArgs(args: string[]) {
  const values: Record<string, string | boolean> = {
    oldRef: 'main',
    newRef: 'pranshu/better-implementation',
    corpus: 'worker/src/review/eval/fixtures/gold-v1.json',
    output: '.eval-cache/reports/latest.json',
    reviewerModel: 'gemini-2.5-flash',
    judgeModel: DEFAULT_EVAL_JUDGE_MODEL,
    contextBudget: '20000',
    timeoutMs: '120000',
    verifyRefs: false,
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--verify-refs') {
      values.verifyRefs = true;
      continue;
    }
    const name = optionNames.get(args[index] as keyof typeof optionNames);
    const value = args[index + 1];
    if (!name || !value) throw new Error(`Invalid eval argument: ${args[index]}`);
    values[name] = value;
    index++;
  }
  return values as {
    oldRef: string;
    newRef: string;
    corpus: string;
    output: string;
    reviewerModel: string;
    judgeModel: string;
    contextBudget: string;
    timeoutMs: string;
    verifyRefs: boolean;
  };
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function groqApiKey(): string {
  const key = process.env.GROQ_API_KEY
    ?? process.env.GROQ_API_KEYS?.split(',').map((item) => item.trim()).find(Boolean);
  if (!key) {
    throw new Error('Missing GROQ_API_KEY or GROQ_API_KEYS');
  }
  return key;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const corpus = await loadEvalCorpus(resolve(repoRoot, args.corpus));
  const oldPipeline = await resolveGitPipelineVersion(
    'old',
    args.oldRef,
    repoRoot
  );
  const newPipeline = await resolveGitPipelineVersion(
    'new',
    args.newRef,
    repoRoot
  );
  const config: EvalRunConfig = {
    reviewerModel: args.reviewerModel,
    contextBudget: positiveNumber(args.contextBudget, 'context-budget'),
    tools: [],
    rulesHash: 'none',
    timeoutMs: positiveNumber(args.timeoutMs, 'timeout-ms'),
  };

  const cases = await withDetachedWorktree({
    repoRoot,
    version: oldPipeline,
    run: async (oldPath) => withDetachedWorktree({
      repoRoot,
      version: newPipeline,
      run: async (newPath) => {
        const apiKey = args.verifyRefs
          ? 'verification-only'
          : process.env.GEMINI_API_KEY;
        const apiKeys = args.verifyRefs
          ? undefined
          : process.env.GEMINI_API_KEYS;
        const [oldAdapter, newAdapter] = await Promise.all([
          loadBranchPipeline({ worktreePath: oldPath, apiKey, apiKeys }),
          loadBranchPipeline({ worktreePath: newPath, apiKey, apiKeys }),
        ]);
        if (args.verifyRefs) return [];

        if (!apiKey && !apiKeys) {
          throw new Error('Missing GEMINI_API_KEY or GEMINI_API_KEYS');
        }
        const judge = new GroqJudgeTransport(
          groqApiKey(),
          args.judgeModel
        );
        const cache = new FileJudgeCache(
          resolve(repoRoot, '.eval-cache', 'judge-verdicts.json')
        );
        const reports = [];
        for (const testCase of corpus.cases) {
          reports.push(await evaluateCase({
            testCase,
            defects: corpus.defects.filter(
              (defect) => defect.caseId === testCase.id
            ),
            goldSetVersion: corpus.goldSetVersion,
            oldPipeline: oldAdapter,
            newPipeline: newAdapter,
            oldVersion: oldPipeline,
            newVersion: newPipeline,
            config,
            judge,
            cache,
          }));
        }
        return reports;
      },
    }),
  });

  if (args.verifyRefs) {
    process.stdout.write(
      `Verified ${args.oldRef}@${oldPipeline.resolvedSha} and `
      + `${args.newRef}@${newPipeline.resolvedSha}\n`
    );
    return;
  }

  const assessments: ComparisonAssessment[] = [
    'better',
    'worse',
    'mixed',
    'inconclusive',
    'judge_unstable',
  ];
  const report: EvalReport = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    goldSetVersion: corpus.goldSetVersion,
    oldPipeline,
    newPipeline,
    judgeModel: args.judgeModel,
    judgeTier: 'free',
    config,
    cases,
    summary: Object.fromEntries(
      assessments.map((assessment) => [
        assessment,
        cases.filter((item) => item.assessment === assessment).length,
      ])
    ) as Record<ComparisonAssessment, number>,
  };
  const output = resolve(repoRoot, args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  process.stdout.write(`Wrote eval report to ${output}\n`);
}

await main();
