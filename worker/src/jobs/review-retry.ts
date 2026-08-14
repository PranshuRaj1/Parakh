export class ReviewRetryScheduledError extends Error {
  constructor(public delaySeconds: number) {
    super(`Review retry scheduled in ${delaySeconds}s`);
    this.name = 'ReviewRetryScheduledError';
  }
}

export class ReviewExecutionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewExecutionActiveError';
  }
}

export class ReviewFailurePersistenceError extends Error {
  constructor(
    public originalError: unknown,
    public persistenceError: unknown
  ) {
    const original = originalError instanceof Error ? originalError.message : String(originalError);
    const persistence = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
    super(`Review failed with "${original}" and failure persistence also failed with "${persistence}"`, {
      cause: originalError,
    });
    this.name = 'ReviewFailurePersistenceError';
  }
}

const UNEXPECTED_RETRY_DELAYS_SECONDS = [5, 15, 30, 60, 60, 120, 120, 300] as const;

export function getUnexpectedRetryDelaySeconds(attempt: number): number | null {
  return UNEXPECTED_RETRY_DELAYS_SECONDS[attempt - 1] ?? null;
}

export function getReviewRetryDelaySeconds(attempt: number, random = Math.random): number {
  if (attempt <= 1) return 3 + Math.floor(random() * 3);
  return 8 + Math.floor(random() * 5);
}
