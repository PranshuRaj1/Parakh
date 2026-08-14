import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// repo-auth.ts keeps a module-level permission cache; reload the module for
// every test so the cache never leaks across cases.
let mod: typeof import('./repo-auth');
async function load() {
  vi.resetModules();
  mod = await import('./repo-auth');
}

function mockGithubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  ));
}

const sessions = {
  alice: { user: { login: 'alice' }, accessToken: 'token-alice' },
  bob: { user: { login: 'bob' }, accessToken: 'token-bob' },
};

beforeEach(async () => {
  await load();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isRepoString', () => {
  it('accepts owner/repo shapes', () => {
    expect(mod.isRepoString('acme/app')).toBe(true);
    expect(mod.isRepoString('PranshuRaj1/Parakh')).toBe(true);
    expect(mod.isRepoString('org.name/repo-2')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(mod.isRepoString('no-slash')).toBe(false);
    expect(mod.isRepoString('a/b/c')).toBe(false);
    expect(mod.isRepoString('../etc/passwd')).toBe(false);
    expect(mod.isRepoString('.hidden/repo')).toBe(false);
    expect(mod.isRepoString('')).toBe(false);
  });
});

describe('getRepoPermission', () => {
  it('maps GitHub permission levels', async () => {
    mockGithubFetch(200, { permission: 'admin' });
    expect(await mod.getRepoPermission('acme/admin-app', 'alice', 't')).toBe('admin');

    mockGithubFetch(200, { permission: 'write' });
    expect(await mod.getRepoPermission('acme/write-app', 'alice', 't')).toBe('write');

    mockGithubFetch(200, { permission: 'read' });
    expect(await mod.getRepoPermission('acme/read-app', 'alice', 't')).toBe('read');
  });

  it('denies on 404 (not a collaborator) and 403 (no scope)', async () => {
    mockGithubFetch(404, {});
    expect(await mod.getRepoPermission('acme/app', 'bob', 't')).toBe('none');

    mockGithubFetch(403, {});
    expect(await mod.getRepoPermission('acme/app', 'bob', 't')).toBe('none');
  });

  it('denies malformed repo strings without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await mod.getRepoPermission('../bad', 'alice', 't')).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('requireRepoPermission (tenant isolation)', () => {
  it('lets alice read a repo where she is a read collaborator', async () => {
    mockGithubFetch(200, { permission: 'read' });
    expect(await mod.requireRepoPermission('acme/app', 'read', sessions.alice)).toBe(true);
  });

  it('blocks alice from a repo where she is not a collaborator', async () => {
    mockGithubFetch(404, {});
    expect(await mod.requireRepoPermission('acme/app', 'read', sessions.alice)).toBe(false);
  });

  it('blocks a read collaborator from write actions', async () => {
    mockGithubFetch(200, { permission: 'read' });
    expect(await mod.requireRepoPermission('acme/app', 'write', sessions.alice)).toBe(false);
  });

  it('lets an admin/write collaborator perform write actions', async () => {
    mockGithubFetch(200, { permission: 'admin' });
    expect(await mod.requireRepoPermission('acme/app', 'write', sessions.alice)).toBe(true);
  });

  it('keeps alice and bob isolated across two repos', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const permission = url.includes('acme') && url.includes('alice') ? 'write'
        : url.includes('rival') && url.includes('bob') ? 'admin'
        : null;
      return new Response(JSON.stringify({ permission }), {
        status: permission ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    expect(await mod.requireRepoPermission('acme/app', 'read', sessions.alice)).toBe(true);
    expect(await mod.requireRepoPermission('rival/app', 'read', sessions.alice)).toBe(false);
    expect(await mod.requireRepoPermission('acme/app', 'read', sessions.bob)).toBe(false);
    expect(await mod.requireRepoPermission('rival/app', 'read', sessions.bob)).toBe(true);
  });

  it('denies when the session has no token or login', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await mod.requireRepoPermission('acme/app', 'read', null)).toBe(false);
    expect(await mod.requireRepoPermission('acme/app', 'read', { user: { login: 'alice' }, accessToken: null })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches permission lookups per user+repo', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ permission: 'read' }), { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    await mod.requireRepoPermission('acme/app', 'read', sessions.alice);
    await mod.requireRepoPermission('acme/app', 'read', sessions.alice);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Different user, different cache key
    await mod.requireRepoPermission('acme/app', 'write', sessions.bob);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getUserRepos', () => {
  it('returns full names from /user/repos', async () => {
    mockGithubFetch(200, [{ full_name: 'acme/app' }, { full_name: 'rival/app' }]);
    expect(await mod.getUserRepos('token')).toEqual(['acme/app', 'rival/app']);
  });

  it('returns an empty list on failure', async () => {
    mockGithubFetch(403, {});
    expect(await mod.getUserRepos('token')).toEqual([]);
  });
});