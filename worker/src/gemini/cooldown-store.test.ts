import { describe, expect, it } from 'vitest';
import { MemoryCooldownStore, RedisCooldownStore } from './cooldown-store.js';

describe('MemoryCooldownStore', () => {
  it('starts empty and returns null for unknown keys', () => {
    const store = new MemoryCooldownStore();
    expect(store.get(0)).toBeNull();
  });

  it('parks and retrieves entries', () => {
    const store = new MemoryCooldownStore();
    const entry = { until: Date.now() + 1000, dailyQuota: false };
    store.park(0, entry);
    expect(store.get(0)).toEqual(entry);
  });

  it('clears entries on success', () => {
    const store = new MemoryCooldownStore();
    store.park(0, { until: Date.now() + 1000, dailyQuota: false });
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
    const until = Date.now() + 5000;
    const { store } = makeStore(JSON.stringify({ '0': { until, dailyQuota: true } }));
    await store.load();
    expect(store.get(0)).toEqual({ until, dailyQuota: true });
    expect(store.get(1)).toBeNull();
  });

  it('loads only once — subsequent calls are no-ops', async () => {
    const { store, calls } = makeStore(null);
    await store.load();
    await store.load();
    expect(calls.filter(c => c.op === 'get')).toHaveLength(1);
  });

  it('only writes when something changed (dirty tracking)', async () => {
    const { store, calls } = makeStore(null);
    await store.load();
    await store.flush();
    expect(calls.filter(c => c.op === 'set')).toHaveLength(0);

    store.park(0, { until: Date.now() + 1000, dailyQuota: false });
    await store.flush();
    expect(calls.filter(c => c.op === 'set')).toHaveLength(1);

    // No change → no second write.
    await store.flush();
    expect(calls.filter(c => c.op === 'set')).toHaveLength(1);
  });

  it('survives corrupted redis state', async () => {
    const { store } = makeStore('not-json{');
    await store.load();
    expect(store.get(0)).toBeNull();
  });
});
