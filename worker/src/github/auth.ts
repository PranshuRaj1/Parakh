/**
 * GitHub App Authentication Module
 *
 * Handles the JWT → installation token flow:
 * 1. Generate a JWT signed with the app's private key (RS256)
 * 2. Exchange JWT for an installation access token
 * 3. Cache tokens in Redis until near-expiry
 *
 * This module ONLY handles auth. No review logic, no LLM calls.
 */

import { TOKEN_CACHE_BUFFER_SECONDS } from '@parakh/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

interface InstallationToken {
  token: string;
  expires_at: string;
}

interface RedisClient {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
}

// ─── JWT Generation ──────────────────────────────────────────────────────────

/**
 * Generate a JWT for GitHub App authentication.
 * Uses Web Crypto API (Cloudflare Workers compatible — no Node.js crypto).
 *
 * JWT payload:
 * - iat: issued at (60 seconds in the past for clock drift)
 * - exp: expires in 10 minutes
 * - iss: GitHub App ID
 */
export async function generateJWT(appId: string, privateKeyPEM: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600, // 10 minutes
    iss: appId,
  };

  const key = await importPrivateKey(privateKeyPEM);

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  const encodedSignature = base64url(signature);
  return `${signingInput}.${encodedSignature}`;
}

// ─── Installation Token Exchange ─────────────────────────────────────────────

/**
 * Exchange a JWT for an installation access token.
 * POST /app/installations/{installation_id}/access_tokens
 */
export async function getInstallationToken(
  installationId: number,
  jwt: string
): Promise<InstallationToken> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Parakh-Bot',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token (${response.status}): ${body}`);
  }

  const data = (await response.json()) as InstallationToken;
  return data;
}

// ─── Cached Token Access ─────────────────────────────────────────────────────

/**
 * Get an installation access token, using Redis cache when available.
 *
 * Cache key: inst_token:{installationId}
 * Cache TTL: token expiry minus 5-minute buffer
 *
 * Flow:
 * 1. Check Redis for cached token
 * 2. If found and not expired → return cached
 * 3. If not found → generate JWT, exchange for token, cache, return
 */
export async function getCachedToken(
  installationId: number,
  appId: string,
  privateKey: string,
  redis: RedisClient
): Promise<string> {
  const cacheKey = `inst_token:${installationId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Cache miss — generate fresh token
  const jwt = await generateJWT(appId, privateKey);
  const { token, expires_at } = await getInstallationToken(installationId, jwt);

  // Cache with TTL = time until expiry minus buffer
  const expiresAtMs = new Date(expires_at).getTime();
  const nowMs = Date.now();
  const ttlSeconds = Math.max(
    0,
    Math.floor((expiresAtMs - nowMs) / 1000) - TOKEN_CACHE_BUFFER_SECONDS
  );

  if (ttlSeconds > 0) {
    await redis.set(cacheKey, token, { ex: ttlSeconds });
  }

  return token;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Import a PEM-encoded RSA private key for use with Web Crypto API.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM headers and decode base64
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
    .replace(/-----END RSA PRIVATE KEY-----/, '')
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  // Try PKCS8 first (BEGIN PRIVATE KEY), fall back to PKCS1 (BEGIN RSA PRIVATE KEY)
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    // If PKCS8 fails, wrap PKCS1 in PKCS8 envelope
    const pkcs8 = wrapPKCS1inPKCS8(binaryDer);
    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
}

/**
 * Wrap a PKCS#1 RSA private key in a PKCS#8 envelope.
 * Required because Web Crypto only accepts PKCS#8, but GitHub's PEM
 * may be in PKCS#1 format.
 */
function wrapPKCS1inPKCS8(pkcs1: Uint8Array): Uint8Array {
  // PKCS#8 header for RSA
  const header = new Uint8Array([
    0x30, 0x82, // SEQUENCE
    0x00, 0x00, // length placeholder (2 bytes, will be filled)
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x0d, // SEQUENCE (AlgorithmIdentifier)
    0x06, 0x09, // OID
    0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // rsaEncryption
    0x05, 0x00, // NULL
    0x04, 0x82, // OCTET STRING
    0x00, 0x00, // length placeholder (2 bytes, will be filled)
  ]);

  const totalLength = header.length + pkcs1.length;
  const result = new Uint8Array(totalLength);
  result.set(header, 0);
  result.set(pkcs1, header.length);

  // Fill length placeholders
  const innerLength = pkcs1.length;
  result[24] = (innerLength >> 8) & 0xff;
  result[25] = innerLength & 0xff;

  const outerLength = totalLength - 4;
  result[2] = (outerLength >> 8) & 0xff;
  result[3] = outerLength & 0xff;

  return result;
}

/**
 * Base64url encode a string or ArrayBuffer (no padding, URL-safe).
 */
function base64url(input: string | ArrayBuffer): string {
  let base64: string;
  if (typeof input === 'string') {
    base64 = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
