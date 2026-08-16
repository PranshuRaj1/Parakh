import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import type { LedgerFinding } from '../review/incremental/ledger.js';

vi.mock('../github/api.js', () => ({
  postComment: vi.fn(),
  postReviewComment: vi.fn(),
}));
vi.mock('../redis.js', () => ({
  createRedisSet: vi.fn(),
}));

import { postAnchoredFindings, findingMappingKey } from './anchored-findings.js';
import { postReviewComment } from '../github/api.js';
import { createRedisSet } from '../redis.js';

const mocked = {
  postReviewComment: vi.mocked(postReviewComment),
  createRedisSet: vi.mocked(createRedisSet),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
} as unknown as Env;

const HEAD_SHA = 'abc123';

function ledgerFinding(overrides: Partial<LedgerFinding> = {}): LedgerFinding {
  return {
    severity: 'MEDIUM',
    file: 'src/app.ts',
    line: 10,
    body: 'handle the error',
    suggestion: null,
    rule_id: null,
    finding_id: 'f-1',
    first_seen_head_sha: HEAD_SHA,
    last_validated_head_sha: HEAD_SHA,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocked.postReviewComment.mockReset().mockResolvedValue({ id: 500 });
  mocked.createRedisSet.mockReset().mockReturnValue((async () => undefined) as never);
});

describe('postAnchoredFindings', () => {
  it('posts only findings first seen at this head sha as anchored diff comments', async () => {
    const findings = [
      ledgerFinding(),
      ledgerFinding({ finding_id: 'f-old', first_seen_head_sha: 'oldsha', last_validated_head_sha: HEAD_SHA }),
    ];

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(1);
    expect(mocked.postReviewComment).toHaveBeenCalledTimes(1);
    expect(mocked.postReviewComment).toHaveBeenCalledWith(
      'acme', 'app', 7, HEAD_SHA, 'src/app.ts', 10, 'handle the error', 'token'
    );
  });

  it('returns 0 and posts nothing when no findings are new', async () => {
    const findings = [
      ledgerFinding({ finding_id: 'f-old', first_seen_head_sha: 'oldsha', last_validated_head_sha: HEAD_SHA }),
    ];

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(0);
    expect(mocked.postReviewComment).not.toHaveBeenCalled();
  });

  it('keeps posting the remaining findings when one is rejected (allSettled)', async () => {
    mocked.postReviewComment
      .mockRejectedValueOnce(new Error('422: line is outside the diff'))
      .mockResolvedValueOnce({ id: 501 });

    const findings = [
      ledgerFinding({ finding_id: 'f-a' }),
      ledgerFinding({ finding_id: 'f-b', line: 20 }),
    ];

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(1);
    expect(mocked.postReviewComment).toHaveBeenCalledTimes(2);
  });

  it('maps each posted comment to its finding in Redis with a TTL', async () => {
    mocked.postReviewComment.mockResolvedValueOnce({ id: 502 });

    const setMock = vi.fn().mockResolvedValue(undefined);
    mocked.createRedisSet.mockReturnValue(setMock);

    await postAnchoredFindings('review-1', [ledgerFinding()], 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(mocked.createRedisSet).toHaveBeenCalledWith(env);
    expect(setMock).toHaveBeenCalledWith(
      findingMappingKey(502),
      JSON.stringify({ reviewId: 'review-1', file: 'src/app.ts', line: 10, body: 'handle the error' }),
      { ex: 90 * 24 * 60 * 60 }
    );
  });

  it('does not write a Redis mapping for rejected comments', async () => {
    mocked.postReviewComment.mockRejectedValue(new Error('422'));

    const setMock = vi.fn();
    mocked.createRedisSet.mockReturnValue(setMock);

    await postAnchoredFindings('review-1', [ledgerFinding()], 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(setMock).not.toHaveBeenCalled();
  });
});