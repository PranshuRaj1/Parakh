import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateJWT, getCachedToken, getInstallationToken } from './auth.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function generateTestKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const base64 = Buffer.from(pkcs8).toString('base64');
  const body = base64.match(/.{1,64}/g)!.join('\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function verifyJwtSignature(
  jwt: string,
  publicKey: CryptoKey
): Promise<boolean> {
  const [header, payload, sig] = jwt.split('.');
  const key = await crypto.subtle.importKey(
    'spki',
    await crypto.subtle.exportKey('spki', publicKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${header}.${payload}`)
  );
}

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function errResponse(status: number): Response {
  return { ok: false, status, text: async () => 'nope' } as unknown as Response;
}

function makeRedis(overrides: { get?: () => Promise<string | null>; set?: () => Promise<unknown> } = {}) {
  return {
    get: overrides.get ?? vi.fn().mockResolvedValue(null),
    set: overrides.set ?? vi.fn().mockResolvedValue('OK'),
  };
}

let testKey: { pem: string; publicKey: CryptoKey };

beforeAll(async () => {
  testKey = await generateTestKey();
});

// ─── generateJWT ─────────────────────────────────────────────────────────────

describe('generateJWT', () => {
  it('produces a JWT with the app id and valid iat/exp claims', async () => {
    const jwt = await generateJWT('12345', testKey.pem);
    const [header, payload, sig] = jwt.split('.');

    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(sig).toBeDefined();

    const claims = JSON.parse(Buffer.from(b64urlToBytes(payload)).toString('utf8'));
    expect(claims.iss).toBe('12345');
    // iat = now - 60s, exp = now + 600s
    expect(claims.exp - claims.iat).toBe(660);
    const now = Math.floor(Date.now() / 1000);
    expect(claims.iat).toBeGreaterThan(now - 65);
    expect(claims.exp).toBeLessThan(now + 605);
  });

  it('produces a signature that verifies with the public key', async () => {
    const jwt = await generateJWT('12345', testKey.pem);
    await expect(verifyJwtSignature(jwt, testKey.publicKey)).resolves.toBe(true);
  });
});

// ─── getInstallationToken ────────────────────────────────────────────────────

describe('getInstallationToken', () => {
  it('throws when the exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401)));
    await expect(getInstallationToken(1, 'some.jwt.here')).rejects.toThrow('401');
  });

  it('returns the token on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okJson({ token: 'token-1', expires_at: new Date(Date.now() + 3600_000).toISOString() }))
    );
    const result = await getInstallationToken(1, 'jwt');
    expect(result.token).toBe('token-1');
  });
});

// ─── getCachedToken ──────────────────────────────────────────────────────────

describe('getCachedToken', () => {
  it('returns a cached token without hitting the GitHub API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const redis = makeRedis({ get: vi.fn().mockResolvedValue('cached-token') });
    const token = await getCachedToken(1, '12345', testKey.pem, redis);

    expect(token).toBe('cached-token');
    expect(redis.get).toHaveBeenCalledWith('inst_token:1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('fetches on cache miss and caches with a TTL minus the buffer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okJson({ token: 'fresh-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }))
    );

    const redis = makeRedis();
    const token = await getCachedToken(1, '12345', testKey.pem, redis);

    expect(token).toBe('fresh-token');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('/app/installations/1/access_tokens'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(redis.set).toHaveBeenCalledWith('inst_token:1', 'fresh-token', { ex: expect.any(Number) });
    // 3600s until expiry minus the 300s buffer (allow a second of clock drift)
    const ttl = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0][2].ex as number;
    expect(ttl).toBeGreaterThanOrEqual(3299);
    expect(ttl).toBeLessThanOrEqual(3300);
  });

  it('does not cache a token that expires within the buffer window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okJson({ token: 'short-token', expires_at: new Date(Date.now() + 60_000).toISOString() }))
    );

    const redis = makeRedis();
    const token = await getCachedToken(1, '12345', testKey.pem, redis);

    expect(token).toBe('short-token');
    expect(redis.set).not.toHaveBeenCalled();
  });
});
