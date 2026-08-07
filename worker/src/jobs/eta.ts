import type { Env } from '../index.js';
import {
  getReview,
  countCompletedReviews,
  getAvgDurationByStep,
  getAvgMsPerFile,
  getCompletedStepsForReview,
  getLatestReviewingFilesDetail
} from '../db/reviews.js';

const MIN_SAMPLES_FOR_ESTIMATE = 5;
const MIN_SAMPLES_FOR_REPO_SPECIFIC = 5;

interface EtaResult {
  totalMs: number | null;
  basis: 'repo' | 'global' | 'insufficient_data';
  sampleCount: number;
}

export async function computeEta(reviewId: string, repo: string, env: Env): Promise<EtaResult> {
  const review = await getReview(reviewId, env);
  if (!review) return { totalMs: null, basis: 'insufficient_data', sampleCount: 0 };

  const repoSamples = await countCompletedReviews(repo, env);
  const useRepoSpecific = repoSamples >= MIN_SAMPLES_FOR_REPO_SPECIFIC;
  const scope = useRepoSpecific ? repo : null;

  const globalSamples = await countCompletedReviews(null, env);
  if (!useRepoSpecific && globalSamples < MIN_SAMPLES_FOR_ESTIMATE) {
    return { totalMs: null, basis: 'insufficient_data', sampleCount: globalSamples };
  }

  const fixedStepAverages = await getAvgDurationByStep(scope, env);
  const avgMsPerFile = await getAvgMsPerFile(scope, env);

  const doneSteps = await getCompletedStepsForReview(reviewId, env);
  const doneStepNames = new Set(doneSteps.map(s => s.step));
  const elapsedMs = doneSteps.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);

  let remainingMs = 0;
  for (const [step, avgMs] of fixedStepAverages) {
    if (step !== 'REVIEWING_FILES' && !doneStepNames.has(step)) {
      remainingMs += avgMs;
    }
  }

  const latestFilesDetail = await getLatestReviewingFilesDetail(reviewId, env);
  const filesRemaining = latestFilesDetail
    ? latestFilesDetail.totalCount - latestFilesDetail.completedCount
    : 0;
  remainingMs += filesRemaining * avgMsPerFile;

  return {
    totalMs: elapsedMs + remainingMs,
    basis: useRepoSpecific ? 'repo' : 'global',
    sampleCount: useRepoSpecific ? repoSamples : globalSamples,
  };
}
