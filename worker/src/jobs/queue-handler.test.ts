import { describe, expect, it, vi } from 'vitest';
import type { JobPayload } from '@parakh/shared';
import type { Env } from '../index.js';

vi.mock('./review.js', () => ({ executeReviewJob: vi.fn() }));
vi.mock('./comment-response.js', () => ({ executeCommentResponseJob: vi.fn() }));
vi.mock('./contradiction.js', () => ({ executeContradictionJob: vi.fn() }));

import { handleQueueBatch } from './queue-handler.js';
import { executeReviewJob } from './review.js';
import { executeCommentResponseJob } from './comment-response.js';
import { executeContradictionJob } from './contradiction.js';

const reviewJob = vi.mocked(executeReviewJob);
const commentJob = vi.mocked(executeCommentResponseJob);
const contradictionJob = vi.mocked(executeContradictionJob);

const env = {} as unknown as Env;

function makeMessage(body: JobPayload) {
  return {
    id: 'm1',
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
    deduplicate: vi.fn(),
    log: vi.fn(),
  };
}

function makeBatch(bodies: JobPayload[]) {
  return { queue: 'watchdog', messages: bodies.map(makeMessage) } as unknown as Parameters<typeof handleQueueBatch>[0];
}

describe('handleQueueBatch', () => {
  it('dispatches each message to its handler and acks on success', async () => {
    reviewJob.mockResolvedValue(undefined);
    commentJob.mockResolvedValue(undefined);
    contradictionJob.mockResolvedValue(undefined);

    const batch = makeBatch([
      { type: 'REVIEW', installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, reviewId: 'r1' },
      { type: 'COMMENT_RESPONSE', installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, commentId: 9, commentBody: 'x', commentType: 'issue_comment', githubDeliveryId: 'd' },
      { type: 'CONTRADICTION', installationId: 0, owner: 'acme', repo: 'app', prNumber: 0, ruleId: 'rule-1', ruleBody: 'b', embedding: [1, 2] },
    ]);

    await handleQueueBatch(batch, env);

    expect(reviewJob).toHaveBeenCalledWith(batch.messages[0].body, env, 1);
    expect(commentJob).toHaveBeenCalledWith(batch.messages[1].body, env, 1);
    expect(contradictionJob).toHaveBeenCalledWith(batch.messages[2].body, env, 1);
    for (const m of batch.messages) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  it('passes the queue delivery count through to the job handlers', async () => {
    reviewJob.mockResolvedValue(undefined);
    commentJob.mockResolvedValue(undefined);
    contradictionJob.mockResolvedValue(undefined);
    const batch = makeBatch([
      { type: 'REVIEW', installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, reviewId: 'r1' },
      { type: 'COMMENT_RESPONSE', installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, commentId: 9, commentBody: 'x', commentType: 'issue_comment', githubDeliveryId: 'd' },
      { type: 'CONTRADICTION', installationId: 0, owner: 'acme', repo: 'app', prNumber: 0, ruleId: 'rule-1', ruleBody: 'b', embedding: [1, 2] },
    ]);
    batch.messages[0].attempts = 3;
    batch.messages[1].attempts = 2;
    batch.messages[2].attempts = 1;

    await handleQueueBatch(batch, env);

    expect(reviewJob).toHaveBeenCalledWith(batch.messages[0].body, env, 3);
    expect(commentJob).toHaveBeenCalledWith(batch.messages[1].body, env, 2);
    expect(contradictionJob).toHaveBeenCalledWith(batch.messages[2].body, env, 1);
    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(batch.messages[1].ack).toHaveBeenCalled();
    expect(batch.messages[2].ack).toHaveBeenCalled();
  });

  it('acks unknown job types without dispatching', async () => {
    const batch = makeBatch([{ type: 'UNKNOWN' } as unknown as JobPayload]);
    await handleQueueBatch(batch, env);
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(reviewJob).not.toHaveBeenCalled();
  });

  it('retries a message when its handler throws', async () => {
    reviewJob.mockRejectedValue(new Error('boom'));
    const batch = makeBatch([
      { type: 'REVIEW', installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, reviewId: 'r1' },
    ]);
    await handleQueueBatch(batch, env);
    expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].ack).not.toHaveBeenCalled();
  });
});
