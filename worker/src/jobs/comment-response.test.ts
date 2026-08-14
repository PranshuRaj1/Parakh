import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import type { Intent } from '@parakh/shared';

const { classifyIntentMock, draftReplyMock, geminiMock, groqMock } = vi.hoisted(() => {
  const providerShape = () => ({
    reviewDiff: vi.fn(),
    classifyIntent: vi.fn(),
    classifyRelationship: vi.fn(),
    classifyPriority: vi.fn(),
    draftReply: vi.fn(),
    generateEmbedding: vi.fn(),
  });
  return {
    classifyIntentMock: vi.fn(),
    draftReplyMock: vi.fn(),
    geminiMock: providerShape(),
    groqMock: providerShape(),
  };
});

// Stub the LLM factory: classifyIntent + draftReply drive the comment-response
// paths under test. llm/gemini/groq get full LLMProvider-shaped vi.fn()s so any
// future call into them fails loudly instead of a silent TypeError on {}. The
// provider mocks are hoisted so they stay stable/trackable across calls.
vi.mock('../llm/factory.js', () => ({
  createLLMClients: () => ({
    llm: {
      reviewDiff: vi.fn(),
      classifyIntent: classifyIntentMock,
      classifyRelationship: vi.fn(),
      classifyPriority: vi.fn(),
      draftReply: draftReplyMock,
      generateEmbedding: vi.fn(),
    },
    gemini: geminiMock,
    groq: groqMock,
  }),
}));

vi.mock('../github/auth.js', () => ({ getCachedToken: vi.fn() }));
vi.mock('../github/api.js', () => ({
  postComment: vi.fn(),
  replyToReviewComment: vi.fn(),
  addCommentReaction: vi.fn(),
}));
vi.mock('../db/reviews.js', () => ({
  getRepoSettings: vi.fn(),
  getResumableReview: vi.fn(),
}));
vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
}));
vi.mock('./review.js', () => ({ triggerReview: vi.fn() }));
vi.mock('./correction.js', () => ({ saveCorrectionAsRule: vi.fn() }));

import { executeCommentResponseJob } from './comment-response.js';
import { postComment, replyToReviewComment, addCommentReaction } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings, getResumableReview } from '../db/reviews.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule } from './correction.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  getRepoSettings: vi.mocked(getRepoSettings),
  getResumableReview: vi.mocked(getResumableReview),
  postComment: vi.mocked(postComment),
  replyToReviewComment: vi.mocked(replyToReviewComment),
  addCommentReaction: vi.mocked(addCommentReaction),
  triggerReview: vi.mocked(triggerReview),
  saveCorrectionAsRule: vi.mocked(saveCorrectionAsRule),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
} as unknown as Env;

function payload(overrides: Partial<{ commentBody: string; commentType: 'issue_comment' | 'pull_request_review_comment' }> = {}) {
  return {
    type: 'COMMENT_RESPONSE' as const,
    installationId: 1,
    owner: 'acme',
    repo: 'app',
    prNumber: 7,
    commentId: 100,
    commentBody: 'hello',
    commentType: 'issue_comment' as const,
    githubDeliveryId: 'del',
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  classifyIntentMock.mockReset();
  draftReplyMock.mockReset();
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.getCachedToken.mockResolvedValue('token');
  mocked.triggerReview.mockResolvedValue(true);
  mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'all_comments', stuck_timeout_seconds: null });
});

describe('executeCommentResponseJob', () => {
  it('skips comments that do not mention @parakh in mentioned_only mode', async () => {
    mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'mentioned_only', stuck_timeout_seconds: null });

    await executeCommentResponseJob(payload({ commentBody: 'nice catch' }), env);

    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(mocked.postComment).not.toHaveBeenCalled();
    expect(mocked.triggerReview).not.toHaveBeenCalled();
  });

  it('responds to any comment in all_comments mode (case-insensitive mention check)', async () => {
    classifyIntentMock.mockResolvedValue('GENERAL');

    await executeCommentResponseJob(payload({ commentBody: '@PARAKH please review' }), env);
    expect(classifyIntentMock).toHaveBeenCalledWith('@PARAKH please review', '');

    mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'all_comments', stuck_timeout_seconds: null });
    await executeCommentResponseJob(payload({ commentBody: 'no mention here' }), env);
    expect(classifyIntentMock).toHaveBeenCalledWith('no mention here', '');
  });

  it('resumes the previous review when a resumable review exists on REVIEW_REQUEST', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');
    mocked.getResumableReview.mockResolvedValue({ id: 'existing-review' } as never);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'On it — resuming the previous review 👀', 'token');
    expect(mocked.triggerReview).toHaveBeenCalledWith(
      1, 'acme', 'app', 7, 'manual_mention', env,
      'existing-review', 'del'
    );
  });

  it('starts a fresh review when no resumable review exists on REVIEW_REQUEST', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');
    mocked.getResumableReview.mockResolvedValue(null);
    mocked.addCommentReaction.mockResolvedValue(777);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'On it — re-reviewing 👀', 'token');
    expect(mocked.addCommentReaction).toHaveBeenCalledWith('acme', 'app', 100, 'issue_comment', 'eyes', 'token');
    expect(mocked.triggerReview).toHaveBeenCalledWith(
      1, 'acme', 'app', 7, 'manual_mention', env,
      undefined, 'del', 100, 'issue_comment', 777
    );
  });

  it('still starts a fresh review when adding the trigger reaction fails (best-effort)', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');
    mocked.getResumableReview.mockResolvedValue(null);
    mocked.addCommentReaction.mockRejectedValue(new Error('reaction failed'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.triggerReview).toHaveBeenCalledWith(
      1, 'acme', 'app', 7, 'manual_mention', env,
      undefined, 'del', 100, 'issue_comment', undefined
    );
  });

  it('posts a waiting warning when the lock is held and no review is enqueued', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');
    mocked.getResumableReview.mockResolvedValue(null);
    mocked.triggerReview.mockResolvedValue(false);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, '⚠️ A review is already in progress, please wait and try again.', 'token'
    );
    expect(mocked.addCommentReaction).toHaveBeenCalledWith('acme', 'app', 100, 'issue_comment', 'eyes', 'token');
  });

  it('saves CORRECTION intents as active rules and confirms', async () => {
    classifyIntentMock.mockResolvedValueOnce('CORRECTION');
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-9', body: 'never flag EOF newlines', priority: 'normal',
    } as never);

    await executeCommentResponseJob(payload({ commentBody: '@parakh we never flag EOF newline issues' }), env);

    expect(mocked.saveCorrectionAsRule).toHaveBeenCalledWith(
      { installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, commentBody: '@parakh we never flag EOF newline issues' },
      env
    );
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Learned'), 'token'
    );
  });

  it('acknowledges suppression directives with the instruction wording', async () => {
    classifyIntentMock.mockResolvedValueOnce('CORRECTION');
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-9', body: 'stop flagging "No newline at the end of the file"', priority: 'normal', kind: 'instruction',
    } as never);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining("won't raise"), 'token'
    );
  });

  it('replies gracefully when saving a CORRECTION fails', async () => {
    classifyIntentMock.mockResolvedValueOnce('CORRECTION');
    mocked.saveCorrectionAsRule.mockRejectedValue(new Error('embedding failed'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining("Couldn't save that right now"), 'token'
    );
  });

  it('acknowledges EXPLANATION/DISMISSAL intents with canned replies', async () => {
    for (const intent of ['EXPLANATION', 'DISMISSAL'] as Intent[]) {
      classifyIntentMock.mockResolvedValueOnce(intent);
      await executeCommentResponseJob(payload(), env);
    }
    const notedReplies = mocked.postComment.mock.calls.filter(([, , , body]) => body === '👍 Noted.');
    expect(notedReplies).toHaveLength(2);
  });

  it('answers QUESTIONS with a drafted reply', async () => {
    classifyIntentMock.mockResolvedValue('QUESTION');
    draftReplyMock.mockResolvedValue('Here is the answer...');

    await executeCommentResponseJob(payload(), env);

    expect(draftReplyMock).toHaveBeenCalledWith('', 'hello');
    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'Here is the answer...', 'token');
  });

  it('stays silent for GENERAL intent', async () => {
    classifyIntentMock.mockResolvedValue('GENERAL');

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).not.toHaveBeenCalled();
  });

  it('replies into the diff thread for pull_request_review_comment events', async () => {
    classifyIntentMock.mockResolvedValue('QUESTION');
    draftReplyMock.mockResolvedValue('reply body');

    await executeCommentResponseJob(
      payload({ commentType: 'pull_request_review_comment' }),
      env
    );

    expect(mocked.replyToReviewComment).toHaveBeenCalledWith('acme', 'app', 7, 100, 'reply body', 'token');
    expect(mocked.postComment).not.toHaveBeenCalled();
  });
});
