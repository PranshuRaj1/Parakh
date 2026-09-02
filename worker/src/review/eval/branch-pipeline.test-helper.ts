import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Finding, Rule } from '@parakh/shared';
import type { ReviewResult } from '../../gemini/client.js';
import type {
  EvalCase,
  EvalPipeline,
  EvalRunConfig,
  PipelineOutput,
} from './types.js';

interface ReviewModule {
  parseDiffByFile(diff: string): Map<string, string>;
  isIgnoredLockfile(file: string): boolean;
  resolveReviewResult(
    result: ReviewResult,
    file: string,
    rules: Rule[],
    suppressPatterns: RegExp[]
  ): { findings: Finding[] };
}

interface GeminiLike {
  reviewDiff(
    file: string,
    diff: string,
    rules: Rule[],
    context?: unknown,
    referenceFileContent?: string
  ): Promise<ReviewResult>;
}

interface GeminiModule {
  GeminiClient: new (env: {
    GEMINI_API_KEY?: string;
    GEMINI_API_KEYS?: string;
    GEMINI_GENERATION_MODEL?: string;
  }) => GeminiLike;
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error(`Eval review timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createBranchPipelineFromModules(input: {
  review: ReviewModule;
  gemini: GeminiModule;
  apiKey?: string;
  apiKeys?: string;
}): EvalPipeline {
  return {
    async review(testCase: EvalCase, config: EvalRunConfig): Promise<PipelineOutput> {
      if (config.tools.length > 0 || config.rulesHash !== 'none') {
        throw new Error('Eval v1 supports only empty tools and rules');
      }
      const client = new input.gemini.GeminiClient({
        GEMINI_API_KEY: input.apiKey,
        GEMINI_API_KEYS: input.apiKeys,
        GEMINI_GENERATION_MODEL: config.reviewerModel,
      });
      const rawFindings: Finding[] = [];
      const finalFindings: Finding[] = [];
      let inputCharacters = 0;
      let outputCharacters = 0;
      let providerCalls = 0;

      for (const [file, diff] of input.review.parseDiffByFile(testCase.diff)) {
        if (input.review.isIgnoredLockfile(file)) continue;
        const maxCharacters = config.contextBudget * 4;
        const boundedDiff = diff.slice(0, maxCharacters);
        const reference = testCase.files[file]?.slice(
          0,
          Math.max(0, maxCharacters - boundedDiff.length)
        );
        const result = await withTimeout(
          (signal) => client.reviewDiff(
            file,
            boundedDiff,
            [],
            { signal, timeoutMs: config.timeoutMs },
            reference
          ),
          config.timeoutMs
        );
        providerCalls++;
        inputCharacters += boundedDiff.length + (reference?.length ?? 0);

        const raw = result.genericFindings.map((finding) => ({
          ...finding,
          file: finding.file || file,
          suggestion: finding.suggestion || null,
          rule_id: null,
        }));
        rawFindings.push(...raw);
        finalFindings.push(
          ...input.review.resolveReviewResult(result, file, [], []).findings
        );
        outputCharacters += JSON.stringify(result).length;
      }

      return {
        rawFindings,
        finalFindings,
        inputTokens: Math.ceil(inputCharacters / 4),
        outputTokens: Math.ceil(outputCharacters / 4),
        providerCalls,
      };
    },
  };
}

export async function loadBranchPipeline(input: {
  worktreePath: string;
  apiKey?: string;
  apiKeys?: string;
}): Promise<EvalPipeline> {
  const moduleUrl = (path: string) =>
    pathToFileURL(join(input.worktreePath, path)).href;
  const [review, gemini] = await Promise.all([
    import(moduleUrl('worker/src/jobs/review.ts')) as Promise<ReviewModule>,
    import(moduleUrl('worker/src/gemini/client.ts')) as Promise<GeminiModule>,
  ]);
  return createBranchPipelineFromModules({
    review,
    gemini,
    apiKey: input.apiKey,
    apiKeys: input.apiKeys,
  });
}
