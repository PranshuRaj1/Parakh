export type LLMOperation = 'review' | 'incremental_review' | 'intent' | 'relationship' | 'priority' | 'reply' | 'embedding';

export interface LLMRequestContext {
  signal?: AbortSignal;
  timeoutMs?: number;
  operation?: LLMOperation;
}

export class ProviderTimeoutError extends Error {
  constructor(public provider: string, public timeoutMs: number, options?: { cause?: unknown }) {
    super(`${provider} timed out after ${timeoutMs}ms`, options);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderHealthError extends Error {
  constructor(public provider: string, public status: number | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderHealthError';
  }
}

export class ProviderResponseError extends Error {
  constructor(
    public provider: string,
    message: string,
    public reason: 'missing' | 'malformed' = 'malformed',
    public response?: unknown,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ProviderResponseError';
  }
}

export class AllProvidersFailedError extends Error {
  constructor(public lastError: Error | null, public providers: string[]) {
    super(`All configured providers failed: ${providers.join(', ')}`, { cause: lastError ?? undefined });
    this.name = 'AllProvidersFailedError';
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ProviderTimeoutError || error instanceof ProviderHealthError || error instanceof ProviderResponseError;
}

export function normalizeProviderError(provider: string, error: unknown, timeoutMs: number, timedOut: boolean): Error {
  if (timedOut || error instanceof Error && (error.name === 'AbortError' || error.name === 'GoogleGenerativeAIAbortError')) {
    return new ProviderTimeoutError(provider, timeoutMs, { cause: error });
  }
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
    ? error.status
    : null;
  if (status === 408 || status === 429 || status === 524 || status !== null && status >= 500) {
    return new ProviderHealthError(provider, status, `${provider} returned retryable HTTP ${status}`, { cause: error });
  }
  if (error instanceof TypeError) {
    return new ProviderHealthError(provider, null, `${provider} network request failed`, { cause: error });
  }
  if (error instanceof SyntaxError) {
    return new ProviderResponseError(provider, `${provider} returned malformed JSON`, 'malformed', undefined, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function composeAbortSignals(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeoutReached = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

export function classifyFetchFailure(provider: string, error: unknown, timeoutMs: number, timedOut: boolean): Error {
  if (timedOut || error instanceof Error && error.name === 'AbortError') {
    return new ProviderTimeoutError(provider, timeoutMs, { cause: error });
  }
  if (error instanceof TypeError) {
    return new ProviderHealthError(provider, null, `${provider} network request failed`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function classifyHttpFailure(provider: string, status: number): Error {
  if (status === 408 || status === 429 || status === 524 || status >= 500) {
    return new ProviderHealthError(provider, status, `${provider} returned retryable HTTP ${status}`);
  }
  return new Error(`${provider} returned HTTP ${status}`);
}
