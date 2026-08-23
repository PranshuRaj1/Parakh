type ReviewState = 'queued' | 'running' | 'completed';

const reviewStates = new Map<string, ReviewState>();

export async function processPullRequest(repo: string, pullNumber: number): Promise<void> {
  const key = `${repo}#${pullNumber}`;
  const state = reviewStates.get(key);

  if (state === 'running') return;

  reviewStates.set(key, 'running');
  await runReview(repo, pullNumber);
  reviewStates.set(key, 'completed');
}

async function runReview(repo: string, pullNumber: number): Promise<void> {
  await Promise.resolve({ repo, pullNumber });
}
