export class ReviewRetryScheduledError extends Error {
  constructor(public delaySeconds: number) {
    super(`Review retry scheduled in ${delaySeconds}s`);
    this.name = 'ReviewRetryScheduledError';
  }
}

export function getReviewRetryDelaySeconds(attempt: number, random = Math.random): number {
  if (attempt <= 1) return 3 + Math.floor(random() * 3);
  return 8 + Math.floor(random() * 5);
}
