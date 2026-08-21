import { describe, expect, it } from 'vitest';
import { encryptKey, decryptKey, keyHint } from './encryption.js';

describe('encryptKey / decryptKey', () => {
  it('round-trips a key with the same secret', async () => {
    const envelope = await encryptKey('AIzaSyFakeKey123456', 'test-secret');
    await expect(decryptKey(envelope, 'test-secret')).resolves.toBe('AIzaSyFakeKey123456');
  });

  it('produces distinct envelopes per call (random IV)', async () => {
    const a = await encryptKey('same-key', 'same-secret');
    const b = await encryptKey('same-key', 'same-secret');
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong secret', async () => {
    const envelope = await encryptKey('secret-key', 'right-secret');
    await expect(decryptKey(envelope, 'wrong-secret')).rejects.toThrow();
  });

  it('rejects malformed envelopes', async () => {
    await expect(decryptKey('not-an-envelope', 'secret')).rejects.toThrow('malformed');
  });

  it('does not persist the plaintext anywhere in the envelope', async () => {
    const envelope = await encryptKey('AIzaSySecretKey', 'secret');
    expect(envelope).not.toContain('AIzaSySecretKey');
  });
});

describe('keyHint', () => {
  it('shows the last 4 chars of long keys', () => {
    expect(keyHint('AIzaSyABCDEF1234')).toBe('••••1234');
  });

  it('fully masks short keys', () => {
    expect(keyHint('ab')).toBe('••••••••');
    expect(keyHint('')).toBe('••••••••');
  });
});