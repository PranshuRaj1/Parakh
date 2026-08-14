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
}));
vi.mock('../db/reviews.js', () => ({
  getRepoSettings: vi.fn(),
}));
vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
}));
vi.mock('./review.js', () => ({ triggerReview: vi.fn() }));
vi.mock('./correction.js', () => ({ saveCorrectionAsRule: vi.fn() }));

import { executeCommentResponseJob } from './comment-response.js';
import { postComment, replyToReviewComment } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings } from '../db/reviews.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule } from './correction.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  getRepoSettings: vi.mocked(getRepoSettings),
  postComment: vi.mocked(postComment),
  replyToReviewComment: vi.mocked(replyToReviewComment),
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
  mocked.triggerReview.mockResolvedValue('ENQUEUED');
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

  it('starts an incremental review for an LLM-classified request', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');

    await executeCommentResponseJob(payload(), env);

    expect(mocked.triggerReview).toHaveBeenCalledWith(
      {
        installationId: 1,
        owner: 'acme',
        repo: 'app',
        prNumber: 7,
        reason: 'manual_mention',
        requestedMode: 'incremental',
        githubDeliveryId: 'del',
        commentId: 100,
        commentType: 'issue_comment',
      },
      env
    );
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, 'On it — starting an incremental review 👀', 'token'
    );
  });

  it('parses a canonical full review command without an LLM classification call', async () => {
    await executeCommentResponseJob(payload({ commentBody: '@PARAKH  FULL   REVIEW!' }), env);

    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(mocked.triggerReview).toHaveBeenCalledWith(
      expect.objectContaining({ requestedMode: 'full' }), env
    );
  });

  it('reports that an identical review is already active', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');
    mocked.triggerReview.mockResolvedValue('ALREADY_ACTIVE');

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, 'A review for this commit and mode is already in progress.', 'token'
    );
  });

  it('explains how to retry when another commit or mode is active', async () => {
    classifyIntentMock.mockResolvedValue('REVIEW_REQUEST');
    mocked.triggerReview.mockResolvedValue('BUSY');

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('@parakh full review'), 'token'
    );
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
