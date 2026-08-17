import { describe, expect, it } from 'vitest';
import { DB_REQUEST_TIMEOUT_MS, createDbRequestSignal } from './client.js';
import { OUTBOUND_REQUEST_TIMEOUT_MS } from '../request-timeout.js';

describe('db client request budget', () => {
  it('gives Neon a longer budget than generic outbound calls (cold-start tolerance)', () => {
    expect(DB_REQUEST_TIMEOUT_MS).toBeGreaterThan(OUTBOUND_REQUEST_TIMEOUT_MS);
    expect(DB_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('returns a fresh, not-yet-aborted signal per call (fresh budget per retry attempt)', () => {
    const first = createDbRequestSignal();
    const second = createDbRequestSignal();
    expect(first).not.toBe(second);
    expect(first.aborted).toBe(false);
    expect(second.aborted).toBe(false);
  });
});