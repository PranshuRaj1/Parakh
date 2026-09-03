import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadBranchPipeline } from './branch-pipeline.test-helper.js';
import { loadEvalCorpus } from './corpus.test-helper.js';
import { FileJudgeCache } from './file-judge-cache.test-helper.js';
import { FileReviewCache } from './file-review-cache.test-helper.js';
import {
  resolveGitPipelineVersion,
  withDetachedWorktree,
} from './git-worktree.test-helper.js';
import {
  DEFAULT_EVAL_JUDGE_MODEL,
  GroqJudgeTransport,
} from './groq-judge.js';
import { fetchPrSnapshot, SnapshotCache } from './github-snapshot.js';
import {
  buildCorpusFromMartian,
  filterToRelevantCategories,
  loadMartianFile,
  summarizeImport,
} from './martian-importer.js';
import { evaluateCase } from './orchestrator.test-helper.js';
import {
  generateAdjudicationReview,
  generateMarkdownReport,
} from './report.js';
import type {
  ComparisonAssessment,
  EvalCorpus,
  EvalReport,
  EvalRunConfig,
} from './types.js';

const optionNames = new Map([
  ['--old-ref', 'oldRef'],
  ['--new-ref', 'newRef'],
  ['--corpus', 'corpus'],
  ['--case', 'caseId'],
  ['--output', 'output'],
  ['--output-md', 'outputMd'],
  ['--output-review', 'outputReview'],
  ['--reviewer-model', 'reviewerModel'],
  ['--judge-model', 'judgeModel'],
  ['--context-budget', 'contextBudget'],
  ['--judge-context-budget', 'judgeContextBudget'],
  ['--timeout-ms', 'timeoutMs'],
  ['--import-martian', 'importMartian'],
  ['--martian-out', 'martianOut'],
  ['--gold-version', 'goldVersion'],
  ['--old-strategy', 'oldStrategy'],
  ['--new-strategy', 'newStrategy'],
] as const);

function parseArgs(args: string[]) {
  const reviewerModelDefault =
    process.env.GEMINI_GENERATION_MODEL ?? 'gemini-2.5-flash';
  const values: Record<string, string | boolean> = {
    oldRef: 'main',
    newRef: 'pranshu/better-implementation',
    corpus: 'worker/src/review/eval/fixtures/gold-v1.json',
    caseId: '',
    output: '.eval-cache/reports/latest.json',
    outputMd: '',
    outputReview: '',
    reviewerModel: reviewerModelDefault,
    judgeModel: DEFAULT_EVAL_JUDGE_MODEL,
    contextBudget: '20000',
    judgeContextBudget: '2000',
    timeoutMs: '600000',
    verifyRefs: false,
    importMartian: '',
    martianOut: 'worker/src/review/eval/fixtures/martian-corpus.json',
    goldVersion: 'martian-gold-v1',
    oldStrategy: 'file',
    newStrategy: 'grouped',
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') continue;
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
    caseId: string;
    output: string;
    outputMd: string;
    outputReview: string;
    reviewerModel: string;
    judgeModel: string;
    contextBudget: string;
    judgeContextBudget: string;
    timeoutMs: string;
    verifyRefs: boolean;
    importMartian: string;
    martianOut: string;
    goldVersion: string;
    oldStrategy: 'file' | 'grouped';
    newStrategy: 'file' | 'grouped';
  };
}

function strategy(value: string, name: string): 'file' | 'grouped' {
  if (value === 'file' || value === 'grouped') return value;
  throw new Error(`${name} must be file or grouped`);
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function groqApiKeys(): string[] {
  const keys = process.env.GROQ_API_KEYS?.split(',').map((item) => item.trim()).filter(Boolean)
    ?? (process.env.GROQ_API_KEY ? [process.env.GROQ_API_KEY] : []);
  if (keys.length === 0) {
    throw new Error('Missing GROQ_API_KEY or GROQ_API_KEYS');
  }
  return keys;
}

async function runMartianImport(args: ReturnType<typeof parseArgs>, repoRoot: string): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN;
  const prs = await loadMartianFile(resolve(repoRoot, args.importMartian));
  const result = filterToRelevantCategories(prs);
  process.stdout.write(summarizeImport(result) + '\n\n');

  if (githubToken) {
    process.stdout.write('Fetching PR snapshots from GitHub...\n');
    const cache = new SnapshotCache();
    const cachePath = resolve(repoRoot, '.eval-cache', 'snapshots.json');
    await cache.load(cachePath);

    const snapshotFetcher = async (
      owner: string,
      repo: string,
      number: number
    ) => {
      const key = `${owner}/${repo}#${number}`;
      return cache.getOrFetch(key, () =>
        fetchPrSnapshot(owner, repo, number, githubToken, {
          fetchFiles: true,
          fileBudget: 30,
        })
      );
    };

    for (const pr of result.prs) {
      const parsed = pr.original_url ?? pr.url;
      const match = parsed.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (match) {
        process.stdout.write(`  Fetching ${match[1]}/${match[2]}#${match[3]}...\n`);
        await snapshotFetcher(match[1], match[2], Number(match[3]));
      }
    }

    await cache.save(cachePath);
    process.stdout.write(`Saved ${cache.size} snapshots to ${cachePath}\n\n`);
  } else {
    process.stdout.write(
      'No GITHUB_TOKEN found. Corpus will have placeholder SHAs.\n'
      + 'Set GITHUB_TOKEN to fetch real PR snapshots.\n\n'
    );
  }

  const corpus = await buildCorpusFromMartian(
    result.prs,
    args.goldVersion,
    githubToken
      ? async (owner, repo, number) => {
          const cache = new SnapshotCache();
          const cachePath = resolve(repoRoot, '.eval-cache', 'snapshots.json');
          await cache.load(cachePath);
          const key = `${owner}/${repo}#${number}`;
          return cache.getOrFetch(key, () =>
            fetchPrSnapshot(owner, repo, number, githubToken!, {
              fetchFiles: true,
              fileBudget: 30,
            })
          );
        }
      : undefined
  );

  await validateCorpus(corpus);

  const outPath = resolve(repoRoot, args.martianOut);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(corpus, null, 2));
  process.stdout.write(
    `Wrote corpus: ${corpus.cases.length} cases, ${corpus.defects.length} defects\n`
    + `  to ${outPath}\n`
  );
}

async function validateCorpus(corpus: EvalCorpus): Promise<void> {
  const { validateEvalCorpus } = await import('./corpus.test-helper.js');
  validateEvalCorpus(corpus);
}

async function runEval(args: ReturnType<typeof parseArgs>, repoRoot: string): Promise<void> {
  const corpus = await loadEvalCorpus(resolve(repoRoot, args.corpus));
  const casesToRun = args.caseId
    ? corpus.cases.filter((testCase) => testCase.id === args.caseId)
    : corpus.cases;
  if (args.caseId && casesToRun.length === 0) {
    throw new Error(`Case not found in corpus: ${args.caseId}`);
  }
  if (args.caseId) {
    const missingDefects = corpus.defects.filter(
      (defect) => defect.caseId === args.caseId
    );
    if (missingDefects.length === 0) process.stdout.write(
      `Note: no defects found for case ${args.caseId}\n`
    );
  }
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
  oldPipeline.strategy = strategy(args.oldStrategy, 'old-strategy');
  newPipeline.strategy = strategy(args.newStrategy, 'new-strategy');
  const config: EvalRunConfig = {
    reviewerModel: args.reviewerModel,
    contextBudget: positiveNumber(args.contextBudget, 'context-budget'),
    judgeContextBudget: positiveNumber(args.judgeContextBudget, 'judge-context-budget'),
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
          loadBranchPipeline({ worktreePath: oldPath, apiKey, apiKeys, strategy: oldPipeline.strategy }),
          loadBranchPipeline({ worktreePath: newPath, apiKey, apiKeys, strategy: newPipeline.strategy }),
        ]);
        if (args.verifyRefs) return [];

        if (!apiKey && !apiKeys) {
          throw new Error('Missing GEMINI_API_KEY or GEMINI_API_KEYS');
        }
        const judge = new GroqJudgeTransport(
          groqApiKeys(),
          args.judgeModel
        );
        const cache = new FileJudgeCache(
          resolve(repoRoot, '.eval-cache', 'judge-verdicts.json')
        );
        const reviewCache = new FileReviewCache(
          resolve(repoRoot, '.eval-cache', 'review-runs.json')
        );
        const reports = [];
        for (const testCase of casesToRun) {
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
            reviewCache,
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
  process.stdout.write(`Wrote JSON report to ${output}\n`);

  if (args.outputMd) {
    const mdPath = resolve(repoRoot, args.outputMd);
    await mkdir(dirname(mdPath), { recursive: true });
    await writeFile(mdPath, generateMarkdownReport(report));
    process.stdout.write(`Wrote Markdown report to ${mdPath}\n`);
  }

  if (args.outputReview) {
    const reviewPath = resolve(repoRoot, args.outputReview);
    await mkdir(dirname(reviewPath), { recursive: true });
    await writeFile(reviewPath, generateAdjudicationReview(report));
    process.stdout.write(`Wrote adjudication review to ${reviewPath}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  if (args.importMartian) {
    await runMartianImport(args, repoRoot);
    return;
  }

  await runEval(args, repoRoot);
}

await main();
