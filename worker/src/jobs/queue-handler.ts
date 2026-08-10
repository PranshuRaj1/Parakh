/**
 * Queue Handler
 *
 * Dispatches queued job messages to the appropriate job handler.
 * This module ONLY handles dispatch and rate limiting.
 */

import type { JobPayload } from '@parakh/shared';
import { executeReviewJob } from './review.js';
import { executeCommentResponseJob } from './comment-response.js';
import { executeContradictionJob } from './contradiction.js';
import type { Env } from '../index.js';

/**
 * Process a batch of queued messages.
 * Each message is dispatched to the appropriate job handler based on type.
 */
export async function handleQueueBatch(
  batch: MessageBatch<JobPayload>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body;

    try {
      switch (payload.type) {
        case 'REVIEW':
          console.log(`[queue] Processing REVIEW job: ${payload.owner}/${payload.repo}#${payload.prNumber} (attempt ${message.attempts})`);
          await executeReviewJob(payload, env, message.attempts);
          message.ack();
          break;

        case 'COMMENT_RESPONSE':
          console.log(`[queue] Processing COMMENT_RESPONSE job: ${payload.owner}/${payload.repo}#${payload.prNumber}`);
          await executeCommentResponseJob(payload, env);
          message.ack();
          break;

        case 'CONTRADICTION':
          console.log(`[queue] Processing CONTRADICTION job for rule ${payload.ruleId}`);
          await executeContradictionJob(payload, env);
          message.ack();
          break;

        default:
          console.warn(`[queue] Unknown job type: ${(payload as JobPayload).type}`);
          message.ack(); // Don't retry unknown types
      }
    } catch (err) {
      console.error(`[queue] Job failed:`, err);
      message.retry();
    }
  }
}
