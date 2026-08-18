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

  // NEON HTTP 5xx — the `500`-style status can surface as "HTTP status 520",
  // "error code: 520", or bare "502"/"503"/"504". 520 is Neon's generic
  // server-side fault (proxy/host glitch) and is always safe to retry.
  if (msg.includes('520')) return true;
  if (msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (/\bhttp status 5\d\d\b/.test(msg) || /\berror code: 5\d\d\b/.test(msg)) return true;

  return false;
}

/**
 * True when the failure (or its `cause` chain) is a DATABASE CONNECT failure:
 * the Neon HTTP driver timed out establishing the request, e.g.
 *   NeonDbError: Error connecting to database: The operation was aborted due to timeout
 *
 * This is an infrastructure outage, not a review-specific failure: retrying it
 * is always safe and the queue must NOT drop the job while the DB is down.
 */
export function isDbConnectFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<Error>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const msg = current.message.toLowerCase();
    if (
      msg.includes('error connecting to database') ||
      msg.includes('the operation was aborted due to timeout')
    ) {
      return true;
    }
    current = current.cause;
  }
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
