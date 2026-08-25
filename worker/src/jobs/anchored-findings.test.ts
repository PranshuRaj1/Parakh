import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import type { LedgerFinding } from '../review/incremental/ledger.js';

vi.mock('@parakh/shared', async () => ({
  ...(await vi.importActual<typeof import('@parakh/shared')>('@parakh/shared')),
  MAX_FINDINGS_AS_COMMENTS: 5,
}));

vi.mock('../github/api.js', () => ({
  postComment: vi.fn(),
  postReviewComment: vi.fn(),
  listReviewComments: vi.fn(),
  getPRFiles: vi.fn(),
}));
vi.mock('../redis.js', () => ({
  createRedisSet: vi.fn(),
}));

import { postAnchoredFindings, findingMappingKey, findingAnchorMarker, parseNewSideLines } from './anchored-findings.js';
import { getPRFiles, postReviewComment, listReviewComments } from '../github/api.js';
import { createRedisSet } from '../redis.js';

const mocked = {
  postReviewComment: vi.mocked(postReviewComment),
  listReviewComments: vi.mocked(listReviewComments),
  getPRFiles: vi.mocked(getPRFiles),
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
  mocked.listReviewComments.mockReset().mockResolvedValue([]);
  mocked.getPRFiles.mockReset().mockRejectedValue(new Error('no file metadata'));
  mocked.createRedisSet.mockReset().mockReturnValue((async () => undefined) as never);
});

describe('postAnchoredFindings', () => {
  it('posts unresolved findings from earlier reviews as well as new findings', async () => {
    const findings = [
      ledgerFinding(),
      ledgerFinding({ finding_id: 'f-old', first_seen_head_sha: 'oldsha', last_validated_head_sha: HEAD_SHA }),
    ];

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(2);
    expect(mocked.postReviewComment).toHaveBeenCalledTimes(2);
    const [owner, repo, pr, sha, file, line, body] = mocked.postReviewComment.mock.calls[0];
    expect([owner, repo, pr, sha, file, line]).toEqual(['acme', 'app', 7, HEAD_SHA, 'src/app.ts', 10]);
    expect(String(body)).toContain('handle the error');
    expect(String(body)).toContain('<!-- parakh-anchor:f-1 -->');
  });

  it('does not re-post a finding whose anchor marker already exists (redelivery dedupe)', async () => {
    const findings = [ledgerFinding()];
    mocked.listReviewComments.mockResolvedValue([
      { id: 900, body: 'handle the error\n\n<!-- parakh-anchor:review-1:src/app.ts:10:f-1 -->' },
    ]);

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(0);
    expect(mocked.postReviewComment).not.toHaveBeenCalled();
  });

  it('still posts when the dedupe list call fails (best-effort dedupe)', async () => {
    const findings = [ledgerFinding()];
    mocked.listReviewComments.mockRejectedValue(new Error('GitHub API error (500)'));

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(1);
    expect(mocked.postReviewComment).toHaveBeenCalledTimes(1);
  });

  it('does not repost a deferred finding after its legacy marker exists', async () => {
    const findings = [
      ledgerFinding({ finding_id: 'f-old', first_seen_head_sha: 'oldsha', last_validated_head_sha: HEAD_SHA }),
    ];
    mocked.listReviewComments.mockResolvedValue([
      { id: 901, body: '<!-- parakh-anchor:review-1:src/app.ts:10:f-old -->' },
    ]);

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

  it('posts at most five findings in severity order and leaves the rest eligible', async () => {
    const findings = [
      ...Array.from({ length: 2 }, (_, i) => ledgerFinding({ finding_id: `medium-${i}`, severity: 'MEDIUM' })),
      ...Array.from({ length: 7 }, (_, i) => ledgerFinding({ finding_id: `critical-${i}`, severity: 'CRITICAL' })),
    ];

    const posted = await postAnchoredFindings('review-1', findings, 'acme', 'app', 7, HEAD_SHA, 'token', env);

    expect(posted).toBe(5);
    expect(mocked.postReviewComment.mock.calls.map((call) => String(call[6]))).toEqual([
      expect.stringContaining('critical-0'),
      expect.stringContaining('critical-1'),
      expect.stringContaining('critical-2'),
      expect.stringContaining('critical-3'),
      expect.stringContaining('critical-4'),
    ]);
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

  it('retries an out-of-diff anchor at the nearest hunk line and maps the posted line', async () => {
    // Patch covers new-side lines 12..16 only; the finding points at line 30.
    mocked.getPRFiles.mockResolvedValue([{
      sha: 'x', filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, changes: 1,
      patch: '@@ -10,3 +12,5 @@ fn()\n context\n+added\n context\n context\n context',
    }]);
    const setMock = vi.fn().mockResolvedValue(undefined);
    mocked.createRedisSet.mockReturnValue(setMock);
    mocked.postReviewComment
      .mockRejectedValueOnce(new Error('422 line is not part of the diff'))
      .mockResolvedValueOnce({ id: 503 });

    const posted = await postAnchoredFindings(
      'review-1', [ledgerFinding({ line: 30 })], 'acme', 'app', 7, HEAD_SHA, 'token', env
    );

    expect(posted).toBe(1);
    expect(mocked.postReviewComment).toHaveBeenCalledTimes(2);
    expect(mocked.postReviewComment.mock.calls[0][5]).toBe(30);
    expect(mocked.postReviewComment.mock.calls[1][5]).toBe(16);
    expect(JSON.parse(setMock.mock.calls[0][1])).toMatchObject({ file: 'src/app.ts', line: 16 });
  });

  it('parseNewSideLines tracks added and context lines, not deletions', () => {
    const lines = parseNewSideLines([
      '@@ -1,4 +10,4 @@ header',
      ' context',       // 10
      '-deleted',       // does not advance
      '+added',         // 11
      '\\ No newline at end of file',
      ' more',          // 12
      '@@ -50,1 +60,1 @@ next hunk',
      '+tail',          // 60
    ].join('\n'));
    expect(lines).toEqual([10, 11, 12, 60]);
  });
});
