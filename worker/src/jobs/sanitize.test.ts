import { describe, expect, it } from 'vitest';
import { sanitizeErrorText } from './sanitize.js';

describe('sanitizeErrorText', () => {
  it('redacts GitHub personal access tokens', () => {
    expect(sanitizeErrorText('auth failed for ghp_abcdefghijklmnopqrstuvwxyz1234567890'))
      .toContain('[redacted]');
    expect(sanitizeErrorText('auth failed for ghp_abcdefghijklmnopqrstuvwxyz1234567890'))
      .not.toContain('ghp_');
  });

  it('redacts Google / Gemini API keys', () => {
    const text = 'AIzaSyA0123456789abcdefghijklmnopqrstuvwxyz';
    expect(sanitizeErrorText(`key=${text}`)).toContain('[redacted]');
    expect(sanitizeErrorText(`key=${text}`)).not.toContain(text);
  });

  it('redacts bearer tokens case-insensitively', () => {
    expect(sanitizeErrorText('Authorization: Bearer abc.def-ghi_123')).toBe('Authorization: [redacted]');
    expect(sanitizeErrorText('authorization: bearer XyZ')).toBe('authorization: [redacted]');
  });

  it('redacts PEM private keys', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpA==\n-----END RSA PRIVATE KEY-----`;
    const result = sanitizeErrorText(`stack with ${pem}`);
    expect(result).toContain('[redacted]');
    expect(result).not.toContain('MIIEpA==');
  });

  it('redacts multiple secrets in one message', () => {
    const result = sanitizeErrorText('token ghp_abcdefghijklmnopqrstuvwxyz1234567890 and AIzaSyA0123456789abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toMatch(/ghp_/);
    expect(result).not.toMatch(/AIza/);
  });

  it('leaves plain messages unchanged', () => {
    expect(sanitizeErrorText('Simple internal error')).toBe('Simple internal error');
  });
});
