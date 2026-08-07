import { getReview } from '../db/reviews.js';
import { triggerReview } from './review.js';
import type { Env } from '../index.js';

export async function handleRetryReview(
  reviewId: string,
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  try {
    const review = await getReview(reviewId, env);
    if (!review) {
      return new Response(JSON.stringify({ error: 'Review not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!['FAILED', 'PAUSED_RATE_LIMITED'].includes(review.status)) {
      return new Response(
        JSON.stringify({ error: `cannot retry a review with status ${review.status}` }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const [owner, repo] = review.repo.split('/');
    if (!owner || !repo || !review.installation_id) {
       return new Response(
        JSON.stringify({ error: 'Missing repository details or installation id' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (_ctx) {
      _ctx.waitUntil(
        triggerReview(
          review.installation_id,
          owner,
          repo,
          review.pr_number,
          'manual_mention',
          env,
          review.id,
          false,
          review.github_delivery_id ?? undefined
        ).catch(err => {
          console.error('[retry-api] Failed to execute triggerReview:', err);
        })
      );
    }

    return new Response(JSON.stringify({ status: 'retry_enqueued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[retry-api] Error:', err);
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
