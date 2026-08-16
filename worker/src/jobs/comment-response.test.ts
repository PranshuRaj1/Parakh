import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import type { CommentAnalysis, CorrectionRuleInput, Intent } from '@parakh/shared';

/** Folded response the mocked classifyIntent resolves with. */
function analysis(
  intent: Intent,
  rules: CorrectionRuleInput[] = [],
  ignored: string[] = []
): CommentAnalysis {
  return { intent, rules, ignored };
}

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
  resolveReviewCommentRoot: vi.fn(),
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
import { postComment, replyToReviewComment, resolveReviewCommentRoot, addCommentReaction } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings, getResumableReview } from '../db/reviews.js';
import { createRedisGet, createRedisSet } from '../redis.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule } from './correction.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  getRepoSettings: vi.mocked(getRepoSettings),
  getResumableReview: vi.mocked(getResumableReview),
  postComment: vi.mocked(postComment),
  replyToReviewComment: vi.mocked(replyToReviewComment),
  resolveReviewCommentRoot: vi.mocked(resolveReviewCommentRoot),
  addCommentReaction: vi.mocked(addCommentReaction),
  createRedisGet: vi.mocked(createRedisGet),
  createRedisSet: vi.mocked(createRedisSet),
  triggerReview: vi.mocked(triggerReview),
  saveCorrectionAsRule: vi.mocked(saveCorrectionAsRule),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
} as unknown as Env;

function payload(overrides: Partial<{ commentBody: string; commentType: 'issue_comment' | 'pull_request_review_comment'; inReplyToCommentId: number }> = {}) {
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
  // Default: no finding mapping found (redis returns null).
  mocked.createRedisGet.mockReturnValue((async () => null) as never);
  mocked.createRedisSet.mockReturnValue((async () => undefined) as never);
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
    classifyIntentMock.mockResolvedValue(analysis('GENERAL'));

    await executeCommentResponseJob(payload({ commentBody: '@PARAKH please review' }), env);
    expect(classifyIntentMock).toHaveBeenCalledWith('@PARAKH please review', '');

    mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'all_comments', stuck_timeout_seconds: null });
    await executeCommentResponseJob(payload({ commentBody: 'no mention here' }), env);
    expect(classifyIntentMock).toHaveBeenCalledWith('no mention here', '');
  });

  it('resumes the previous review when a resumable review exists on REVIEW_REQUEST', async () => {
    classifyIntentMock.mockResolvedValue(analysis('REVIEW_REQUEST'));
    mocked.getResumableReview.mockResolvedValue({ id: 'existing-review' } as never);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'On it — resuming the previous review 👀', 'token');
    expect(mocked.triggerReview).toHaveBeenCalledWith(
      1, 'acme', 'app', 7, 'manual_mention', env,
      'existing-review', 'del'
    );
  });

  it('starts a fresh review when no resumable review exists on REVIEW_REQUEST', async () => {
    classifyIntentMock.mockResolvedValue(analysis('REVIEW_REQUEST'));
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
    classifyIntentMock.mockResolvedValue(analysis('REVIEW_REQUEST'));
    mocked.getResumableReview.mockResolvedValue(null);
    mocked.addCommentReaction.mockRejectedValue(new Error('reaction failed'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.triggerReview).toHaveBeenCalledWith(
      1, 'acme', 'app', 7, 'manual_mention', env,
      undefined, 'del', 100, 'issue_comment', undefined
    );
  });

  it('posts a waiting warning when the lock is held and no review is enqueued', async () => {
    classifyIntentMock.mockResolvedValue(analysis('REVIEW_REQUEST'));
    mocked.getResumableReview.mockResolvedValue(null);
    mocked.triggerReview.mockResolvedValue(false);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, '⚠️ A review is already in progress, please wait and try again.', 'token'
    );
    expect(mocked.addCommentReaction).toHaveBeenCalledWith('acme', 'app', 100, 'issue_comment', 'eyes', 'token');
  });

  it('saves CORRECTION intents as active rules and confirms', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [{ body: 'never flag EOF newline issues', priority: 'normal' }])
    );
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-9', body: 'never flag EOF newline issues', priority: 'normal',
    } as never);

    await executeCommentResponseJob(payload({ commentBody: '@parakh we never flag EOF newline issues' }), env);

    expect(mocked.saveCorrectionAsRule).toHaveBeenCalledWith(
      { installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, ruleBody: 'never flag EOF newline issues', priority: 'normal' },
      env
    );
    expect(mocked.addCommentReaction).toHaveBeenCalledWith('acme', 'app', 100, 'issue_comment', '+1', 'token');
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Learned'), 'token'
    );
  });

  it('splits a multi-standard comment into one ACTIVE rule per standard', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [
        { body: 'use Zustand for state management', priority: 'normal' },
        { body: 'use snake_case for database columns', priority: 'normal' },
      ])
    );
    mocked.saveCorrectionAsRule
      .mockResolvedValueOnce({ id: 'rule-a', body: 'use Zustand for state management', priority: 'normal' } as never)
      .mockResolvedValueOnce({ id: 'rule-b', body: 'use snake_case for database columns', priority: 'normal' } as never);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.saveCorrectionAsRule).toHaveBeenCalledTimes(2);
    expect(mocked.saveCorrectionAsRule).toHaveBeenNthCalledWith(
      1,
      { installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, ruleBody: 'use Zustand for state management', priority: 'normal' },
      env
    );
    expect(mocked.saveCorrectionAsRule).toHaveBeenNthCalledWith(
      2,
      { installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, ruleBody: 'use snake_case for database columns', priority: 'normal' },
      env
    );
    expect(mocked.addCommentReaction).toHaveBeenCalledTimes(1);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('Learned 2 rules'),
      'token'
    );
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('use Zustand for state management'),
      'token'
    );
  });

  it('surfaces per-rule save failures and the ignored fragments in the reply', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [
        { body: 'use Zustand for state management', priority: 'high' },
        { body: 'use snake_case for database columns', priority: 'normal' },
      ], ['this check is useless for us'])
    );
    mocked.saveCorrectionAsRule
      .mockResolvedValueOnce({ id: 'rule-1', body: 'use Zustand for state management', priority: 'high' } as never)
      .mockRejectedValueOnce(new Error('embedding failed'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.addCommentReaction).toHaveBeenCalledTimes(1);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining("Couldn't save: *use snake_case for database columns*"),
      'token'
    );
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('Skipped (not actionable): this check is useless for us'),
      'token'
    );
  });

  it('falls back to the whole comment when CORRECTION produced no extracted rules', async () => {
    classifyIntentMock.mockResolvedValueOnce(analysis('CORRECTION'));
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-fb', body: '@parakh we never flag EOF newline issues', priority: 'normal',
    } as never);

    await executeCommentResponseJob(payload({ commentBody: '@parakh we never flag EOF newline issues' }), env);

    expect(mocked.saveCorrectionAsRule).toHaveBeenCalledWith(
      { installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, ruleBody: 'we never flag EOF newline issues', priority: 'normal' },
      env
    );
  });

  it('posts the thumbs-up on diff-thread corrections too', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [{ body: 'never flag EOF newline issues', priority: 'normal' }])
    );
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-10', body: 'never flag EOF newline issues', priority: 'normal',
    } as never);
    mocked.resolveReviewCommentRoot.mockResolvedValue(100);

    await executeCommentResponseJob(
      payload({ commentType: 'pull_request_review_comment' }),
      env
    );

    expect(mocked.addCommentReaction).toHaveBeenCalledWith(
      'acme', 'app', 100, 'pull_request_review_comment', '+1', 'token'
    );
  });

  it('still confirms the correction when the thumbs-up reaction fails (best-effort)', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [{ body: 'never flag EOF newline issues', priority: 'normal' }])
    );
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-11', body: 'never flag EOF newline issues', priority: 'normal',
    } as never);
    mocked.addCommentReaction.mockRejectedValue(new Error('reaction failed'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Learned'), 'token'
    );
  });

  it('acknowledges suppression directives with the instruction wording', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [{ body: 'stop flagging "No newline at the end of the file"', priority: 'normal' }])
    );
    mocked.saveCorrectionAsRule.mockResolvedValue({
      id: 'rule-9', body: 'stop flagging "No newline at the end of the file"', priority: 'normal', kind: 'instruction',
    } as never);

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining("won't raise"), 'token'
    );
  });

  it('replies gracefully when saving a CORRECTION fails', async () => {
    classifyIntentMock.mockResolvedValueOnce(
      analysis('CORRECTION', [{ body: 'never flag EOF newline issues', priority: 'normal' }])
    );
    mocked.saveCorrectionAsRule.mockRejectedValue(new Error('embedding failed'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining("Couldn't save that right now"), 'token'
    );
  });

  it('acknowledges EXPLANATION/DISMISSAL intents with canned replies', async () => {
    for (const intent of ['EXPLANATION', 'DISMISSAL'] as Intent[]) {
      classifyIntentMock.mockResolvedValueOnce(analysis(intent));
      await executeCommentResponseJob(payload(), env);
    }
    const notedReplies = mocked.postComment.mock.calls.filter(([, , , body]) => body === '👍 Noted.');
    expect(notedReplies).toHaveLength(2);
  });

  it('answers QUESTIONS with a drafted reply', async () => {
    classifyIntentMock.mockResolvedValue(analysis('QUESTION'));
    draftReplyMock.mockResolvedValue('Here is the answer...');

    await executeCommentResponseJob(payload(), env);

    expect(draftReplyMock).toHaveBeenCalledWith('', 'hello');
    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'Here is the answer...', 'token');
  });

  it('posts issue_comment replies as flat comments (no threading on the Conversation tab)', async () => {
    classifyIntentMock.mockResolvedValue(analysis('QUESTION'));
    draftReplyMock.mockResolvedValue('flat reply');

    await executeCommentResponseJob(payload({ inReplyToCommentId: 99 }), env);

    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'flat reply', 'token');
    expect(mocked.resolveReviewCommentRoot).not.toHaveBeenCalled();
    expect(mocked.replyToReviewComment).not.toHaveBeenCalled();
  });

  it('stays silent for GENERAL intent', async () => {
    classifyIntentMock.mockResolvedValue(analysis('GENERAL'));

    await executeCommentResponseJob(payload(), env);

    expect(mocked.postComment).not.toHaveBeenCalled();
  });

  it('replies into the diff thread for pull_request_review_comment events', async () => {
    classifyIntentMock.mockResolvedValue(analysis('QUESTION'));
    draftReplyMock.mockResolvedValue('reply body');
    mocked.resolveReviewCommentRoot.mockResolvedValue(100);

    await executeCommentResponseJob(
      payload({ commentType: 'pull_request_review_comment' }),
      env
    );

    expect(mocked.resolveReviewCommentRoot).toHaveBeenCalledWith('acme', 'app', 100, undefined, 'token');
    expect(mocked.replyToReviewComment).toHaveBeenCalledWith('acme', 'app', 7, 100, 'reply body', 'token');
    expect(mocked.postComment).not.toHaveBeenCalled();
  });

  it('anchors the reply at the thread root when the comment is itself a reply', async () => {
    classifyIntentMock.mockResolvedValue(analysis('QUESTION'));
    draftReplyMock.mockResolvedValue('reply body');
    mocked.resolveReviewCommentRoot.mockResolvedValue(200);

    await executeCommentResponseJob(
      payload({ commentType: 'pull_request_review_comment', inReplyToCommentId: 150 }),
      env
    );

    expect(mocked.resolveReviewCommentRoot).toHaveBeenCalledWith('acme', 'app', 100, 150, 'token');
    expect(mocked.replyToReviewComment).toHaveBeenCalledWith('acme', 'app', 7, 200, 'reply body', 'token');
  });

  it('uses the anchored finding as context when replying inside a finding thread', async () => {
    classifyIntentMock.mockResolvedValue(analysis('QUESTION'));
    draftReplyMock.mockResolvedValue('context-aware answer');
    mocked.resolveReviewCommentRoot.mockResolvedValue(100);
    mocked.createRedisGet.mockReturnValue(
      (async () => JSON.stringify({ reviewId: 'review-1', file: 'src/app.ts', line: 10, body: 'handle the error at src/app.ts:10' })) as never
    );

    await executeCommentResponseJob(
      payload({ commentType: 'pull_request_review_comment', inReplyToCommentId: 500 }),
      env
    );

    // The lookup targets the parent comment (the anchored finding comment).
    expect(mocked.createRedisGet).toHaveBeenCalledWith(env);
    expect(classifyIntentMock).toHaveBeenCalledWith('hello', 'handle the error at src/app.ts:10');
    expect(draftReplyMock).toHaveBeenCalledWith('handle the error at src/app.ts:10', 'hello');
    expect(mocked.replyToReviewComment).toHaveBeenCalledWith('acme', 'app', 7, 100, 'context-aware answer', 'token');
  });

  it('falls back to empty context when the finding mapping is missing or malformed', async () => {
    classifyIntentMock.mockResolvedValue(analysis('QUESTION'));
    draftReplyMock.mockResolvedValue('answer');
    mocked.resolveReviewCommentRoot.mockResolvedValue(100);
    mocked.createRedisGet.mockReturnValue(
      (async () => 'not-json') as never
    );

    await executeCommentResponseJob(
      payload({ commentType: 'pull_request_review_comment', inReplyToCommentId: 500 }),
      env
    );

    expect(classifyIntentMock).toHaveBeenCalledWith('hello', '');
  });
});
