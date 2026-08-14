/**
 * DB Retry Wrapper
 *
 * Adds exponential backoff retry logic for transient Neon DB failures
 * (timeouts, connection errors, 5xx). Prevents a single slow query from
 * crashing the entire review pipeline.
 */

export interface RetryOptions {
  /** Max retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms between retries (default: 200) */
  baseDelayMs?: number;
  /** Max delay in ms (default: 5000) */
  maxDelayMs?: number;
  /** Optional predicate to decide if error is retryable (default: all errors) */
  isRetryable?: (error: unknown) => boolean;
  /** Optional label for logging */
  label?: string;
}

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'label'>> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  isRetryable: () => true,
};

/**
 * Determine if a Neon/DB error is transient and worth retrying.
 * Covers: timeouts, connection resets, 5xx, and abort errors.
 */
export function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Timeout / abort
  if (name === 'aborterror' || name === 'timeouterror') return true;
  if (msg.includes('timeout') || msg.includes('aborted')) return true;

  // Connection issues
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('connection')) return true;

  // Neon-specific
  if (msg.includes('neondberror') && msg.includes('timeout')) return true;

  // HTTP 5xx (sometimes surfaced as status in error)
  if (msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;

  return false;
}

/**
 * Execute an async operation with exponential backoff retry.
 * Returns the result on success, or throws the last error after all retries fail.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const isRetryable = options.isRetryable ?? isTransientDbError;
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxAttempts || !isRetryable(error)) {
        throw error;
      }

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4),
        opts.maxDelayMs
      );
      console.warn(
        `[db-retry] ${opts.label ?? 'operation'} failed (attempt ${attempt}/${opts.maxAttempts}): ` +
        `${error instanceof Error ? error.message : String(error)} — retrying in ${Math.round(delay)}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
