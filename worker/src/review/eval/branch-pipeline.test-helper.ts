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

function isRetryableReviewError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : 0;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return status === 429
    || status === 503
    || message.includes('429')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('resource exhausted')
    || message.includes('503')
    || message.includes('service unavailable')
    || message.includes('high demand');
}

export function createBranchPipelineFromModules(input: {
  review: ReviewModule;
  gemini: GeminiModule;
  apiKey?: string;
  apiKeys?: string;
}): EvalPipeline {
  const keys = input.apiKeys?.split(',').map((key) => key.trim()).filter(Boolean)
    ?? (input.apiKey ? [input.apiKey] : [undefined]);
  let keyHint = 0;

  return {
    async review(testCase: EvalCase, config: EvalRunConfig): Promise<PipelineOutput> {
      if (config.tools.length > 0 || config.rulesHash !== 'none') {
        throw new Error('Eval v1 supports only empty tools and rules');
      }
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
        let result: ReviewResult | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < keys.length; attempt++) {
          const keyIndex = (keyHint + attempt) % keys.length;
          const client = new input.gemini.GeminiClient({
            GEMINI_API_KEY: keys[keyIndex],
            GEMINI_GENERATION_MODEL: config.reviewerModel,
          });
          try {
            result = await withTimeout(
              (signal) => client.reviewDiff(
                file,
                boundedDiff,
                [],
                { signal, timeoutMs: config.timeoutMs },
                reference
              ),
              config.timeoutMs
            );
            keyHint = keyIndex;
            break;
          } catch (error) {
            if (!isRetryableReviewError(error)) throw error;
            lastError = error;
          }
        }
        if (!result) throw lastError;
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
