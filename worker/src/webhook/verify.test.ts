import { describe, expect, it } from 'vitest';
import { verifySignature } from './verify.js';

/**
 * Compute the same HMAC-SHA256 hex signature GitHub sends.
 * Uses Web Crypto directly so the test verifies against an independent
 * implementation of the same algorithm (not the code under test).
 */
async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

describe('verifySignature', () => {
  const payload = JSON.stringify({ action: 'opened' });
  const secret = 'webhook-secret';

  it('accepts a correctly signed payload', async () => {
    const signature = await sign(payload, secret);
    await expect(verifySignature(payload, signature, secret)).resolves.toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const signature = await sign(payload, secret);
    await expect(verifySignature(`${payload}x`, signature, secret)).resolves.toBe(false);
  });

  it('rejects a signature produced with the wrong secret', async () => {
    const signature = await sign(payload, 'other-secret');
    await expect(verifySignature(payload, signature, secret)).resolves.toBe(false);
  });

  it('rejects malformed signatures (missing or non-sha256-prefixed)', async () => {
    await expect(verifySignature(payload, '', secret)).resolves.toBe(false);
    await expect(verifySignature(payload, 'sha1=deadbeef', secret)).resolves.toBe(false);
    await expect(verifySignature(payload, 'not-a-signature', secret)).resolves.toBe(false);
    await expect(verifySignature(payload, 'sha256=', secret)).resolves.toBe(false);
  });
});
