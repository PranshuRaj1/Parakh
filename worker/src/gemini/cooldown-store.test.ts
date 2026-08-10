import { describe, expect, it } from 'vitest';
import { MemoryCooldownStore, RedisCooldownStore } from './cooldown-store.js';

const FIXED_NOW = 1_700_000_000_000;

describe('MemoryCooldownStore', () => {
  it('starts empty and returns null for unknown keys', () => {
    const store = new MemoryCooldownStore();
    expect(store.get(0)).toBeNull();
  });

  it('parks and retrieves entries', () => {
    const store = new MemoryCooldownStore();
    const entry = { until: FIXED_NOW + 1000, dailyQuota: false };
    store.park(0, entry);
    expect(store.get(0)).toEqual(entry);
  });

  it('clears entries on success', () => {
    const store = new MemoryCooldownStore();
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    store.clear(0);
    expect(store.get(0)).toBeNull();
  });
});

describe('RedisCooldownStore', () => {
  function makeStore(initialRaw: string | null) {
    const calls: Array<{ op: 'get' | 'set'; key: string; value?: string; opts?: { ex?: number } }> = [];
    const store = new RedisCooldownStore(
      'test-key',
      async (key) => {
        calls.push({ op: 'get', key });
        return initialRaw;
      },
      async (key, value, opts) => {
        calls.push({ op: 'set', key, value, opts });
      }
    );
    return { store, calls };
  }

  it('loads persisted entries from redis', async () => {
    const until = FIXED_NOW + 5000;
    const { store, calls } = makeStore(JSON.stringify({ '0': { until, dailyQuota: true } }));
    await store.load();
    expect(calls.find(c => c.op === 'get')?.key).toBe('test-key');
    expect(store.get(0)).toEqual({ until, dailyQuota: true });
    expect(store.get(1)).toBeNull();
  });

  it('loads only once — subsequent calls are no-ops', async () => {
    const { store, calls } = makeStore(null);
    await store.load();
    await store.load();
    expect(calls.filter(c => c.op === 'get')).toHaveLength(1);
    expect(calls.filter(c => c.op === 'get')[0].key).toBe('test-key');
  });

  it('only writes when something changed (dirty tracking)', async () => {
    const { store, calls } = makeStore(null);
    await store.load();
    await store.flush();
    expect(calls.filter(c => c.op === 'set')).toHaveLength(0);

    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    await store.flush();
    expect(calls.filter(c => c.op === 'set')).toHaveLength(1);
    expect(calls.filter(c => c.op === 'set')[0].key).toBe('test-key');

    // No change → no second write.
    await store.flush();
    expect(calls.filter(c => c.op === 'set')).toHaveLength(1);
  });

  it('survives corrupted redis state', async () => {
    const { store } = makeStore('not-json{');
    await store.load();
    expect(store.get(0)).toBeNull();
  });

  it('rewrites the whole cooldown blob on flush (documented design)', async () => {
    // The Redis store persists ALL cooldowns as a single JSON blob under one
    // key. A flush writes the entire map back — not a per-key patch. This is a
    // deliberate tradeoff (one GET + one SET per delivery, not N); cooldowns
    // are best-effort, so a lost update only costs one extra key retry.
    const { store, calls } = makeStore(null);
    await store.load();
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    store.park(1, { until: FIXED_NOW + 5000, dailyQuota: true });
    await store.flush();

    const set = calls.filter(c => c.op === 'set');
    expect(set).toHaveLength(1);
    expect(set[0].key).toBe('test-key');
    expect(JSON.parse(set[0].value as string)).toEqual({
      '0': { until: FIXED_NOW + 1000, dailyQuota: false },
      '1': { until: FIXED_NOW + 5000, dailyQuota: true },
    });
    expect(set[0].opts?.ex).toBeDefined();
  });
});
