import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review } from '@parakh/shared';
import type { Env } from '../index.js';

vi.mock('../github/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../github/api.js')>();
  return { ...actual, removeCommentReaction: vi.fn(), addCommentReaction: vi.fn() };
});

vi.mock('../db/reviews.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/reviews.js')>();
  return { ...actual, updateTriggerCommentReactionId: vi.fn() };
});

import { swapCommentReaction } from './review.js';
import { removeCommentReaction, addCommentReaction } from '../github/api.js';
import { updateTriggerCommentReactionId } from '../db/reviews.js';

const mocked = {
  removeCommentReaction: vi.mocked(removeCommentReaction),
  addCommentReaction: vi.mocked(addCommentReaction),
  updateTriggerCommentReactionId: vi.mocked(updateTriggerCommentReactionId),
};

const env = { DATABASE_URL: 'postgres://x' } as unknown as Env;
const owner = 'acme';
const repo = 'app';
const token = 'token';

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'r1',
    trigger_comment_id: 100,
    trigger_comment_type: 'issue_comment',
    trigger_comment_reaction_id: 55,
    ...overrides,
  } as Review;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.removeCommentReaction.mockResolvedValue(undefined);
  mocked.addCommentReaction.mockResolvedValue(88);
  mocked.updateTriggerCommentReactionId.mockResolvedValue(undefined);
});

describe('swapCommentReaction', () => {
  it('does nothing when the review was not triggered by a comment', async () => {
    await swapCommentReaction(review({ trigger_comment_id: null, trigger_comment_type: null }), '+1', owner, repo, token, env);
    expect(mocked.removeCommentReaction).not.toHaveBeenCalled();
    expect(mocked.addCommentReaction).not.toHaveBeenCalled();
    expect(mocked.updateTriggerCommentReactionId).not.toHaveBeenCalled();
  });

  it('removes the live reaction then adds the new verdict reaction and tracks it', async () => {
    await swapCommentReaction(review(), '+1', owner, repo, token, env);

    expect(mocked.removeCommentReaction).toHaveBeenCalledWith(owner, repo, 100, 'issue_comment', 55, token);
    expect(mocked.addCommentReaction).toHaveBeenCalledWith(owner, repo, 100, 'issue_comment', '+1', token);
    expect(mocked.updateTriggerCommentReactionId).toHaveBeenCalledWith('r1', 88, env);
  });

  it('clears the tracked reaction when content is null without adding a new one', async () => {
    await swapCommentReaction(review(), null, owner, repo, token, env);

    expect(mocked.removeCommentReaction).toHaveBeenCalledTimes(1);
    expect(mocked.addCommentReaction).not.toHaveBeenCalled();
    expect(mocked.updateTriggerCommentReactionId).toHaveBeenCalledWith('r1', null, env);
  });

  it('still swaps the reaction when removing the previous one fails', async () => {
    mocked.removeCommentReaction.mockRejectedValue(new Error('not found'));

    await swapCommentReaction(review(), '-1', owner, repo, token, env);

    expect(mocked.addCommentReaction).toHaveBeenCalledWith(owner, repo, 100, 'issue_comment', '-1', token);
    expect(mocked.updateTriggerCommentReactionId).toHaveBeenCalledWith('r1', 88, env);
  });
});
