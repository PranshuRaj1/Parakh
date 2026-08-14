import { describe, expect, it, vi } from 'vitest';
import { MemoryCooldownStore, RedisCooldownStore, COOLDOWN_HASH_TTL_SECONDS } from './cooldown-store.js';

const FIXED_NOW = 1_700_000_000_000;

/** Fake Redis STRING backend for testing. */
function makeStringBackend() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'set'; key: string; value?: string }> = [];
  return {
    calls,
    store,
    get: async (key: string) => {
      calls.push({ op: 'get', key });
      return store.get(key) ?? null;
    },
    set: async (key: string, value: string, opts?: { ex?: number }) => {
      calls.push({ op: 'set', key, value });
      store.set(key, value);
    },
    peek(key: string): string | null {
      return store.get(key) ?? null;
    },
  };
}

async function makeStore(backend: ReturnType<typeof makeStringBackend>, initial?: string) {
  if (initial) {
    backend.store.set('test-key', initial);
  }
  return new RedisCooldownStore({
    redisKey: 'test-key',
    redisGet: backend.get,
    redisSet: backend.set,
  });
}

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
  it('loads persisted entries from redis string key', async () => {
    const until = FIXED_NOW + 5000;
    const blob = JSON.stringify({ '0': { until, dailyQuota: true } });
    const backend = makeStringBackend();
    const store = await makeStore(backend, blob);
    await store.load();
    expect(backend.calls.find(c => c.op === 'get')?.key).toBe('test-key');
    expect(store.get(0)).toEqual({ until, dailyQuota: true });
    expect(store.get(1)).toBeNull();
  });

  it('loads only once — subsequent calls are no-ops', async () => {
    const backend = makeStringBackend();
    const store = await makeStore(backend);
    await store.load();
    await store.load();
    expect(backend.calls.filter(c => c.op === 'get')).toHaveLength(1);
  });

  it('only writes when dirty (dirty tracking)', async () => {
    const backend = makeStringBackend();
    const store = await makeStore(backend);
    await store.load();
    await store.flush();
    expect(backend.calls.filter(c => c.op === 'set')).toHaveLength(0);

    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    await store.flush();
    const writes = backend.calls.filter(c => c.op === 'set');
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe('test-key');

    // No change → no second write.
    await store.flush();
    expect(backend.calls.filter(c => c.op === 'set')).toHaveLength(1);
  });

  it('clears a key via full-map rewrite on flush', async () => {
    const blob = JSON.stringify({ '0': { until: FIXED_NOW + 5000, dailyQuota: false }, '1': { until: FIXED_NOW + 3000, dailyQuota: false } });
    const backend = makeStringBackend();
    const store = await makeStore(backend, blob);
    await store.load();
    store.clear(0);
    await store.flush();
    const written = JSON.parse(backend.peek('test-key')!);
    expect(written['0']).toBeUndefined();
    expect(written['1']).toEqual({ until: FIXED_NOW + 3000, dailyQuota: false });
  });

  it('survives corrupted redis state', async () => {
    const backend = makeStringBackend();
    const store = await makeStore(backend, 'not-json{');
    await store.load();
    expect(store.get(0)).toBeNull();
  });

  it('skips entries that lack a numeric until', async () => {
    const blob = JSON.stringify({ '0': { notUntil: 1 }, '1': { until: FIXED_NOW + 5000, dailyQuota: false } });
    const backend = makeStringBackend();
    const store = await makeStore(backend, blob);
    await store.load();
    expect(store.get(0)).toBeNull();
    expect(store.get(1)).toEqual({ until: FIXED_NOW + 5000, dailyQuota: false });
  });

  it('does not clobber a newer park when a failed flush restores dirty flag', async () => {
    let failNextSet = true;
    const backend = makeStringBackend();
    const originalSet = backend.set;
    backend.set = async (key, value, opts) => {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('boom');
      }
      return originalSet(key, value, opts);
    };
    const store = new RedisCooldownStore({
      redisKey: 'test-key',
      redisGet: backend.get,
      redisSet: backend.set,
    });
    await store.load();
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    const firstFlush = store.flush();

    // Newer update lands while the first flush is still awaiting Redis.
    store.park(0, { until: FIXED_NOW + 9999, dailyQuota: true });
    await firstFlush;

    // A second flush must persist the NEWER value, not the failed snapshot.
    await store.flush();
    const written = JSON.parse(backend.peek('test-key')!);
    expect(written['0']).toEqual({ until: FIXED_NOW + 9999, dailyQuota: true });
  });

  it('logs repeated flush failures only once per store', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = makeStringBackend();
    backend.set = async () => { throw new Error('redis unavailable'); };
    const store = new RedisCooldownStore({
      redisKey: 'test-key',
      redisGet: backend.get,
      redisSet: backend.set,
    });
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: true });

    await store.flush();
    await store.flush();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('writes the full map atomically as JSON', async () => {
    const backend = makeStringBackend();
    const store = await makeStore(backend);
    await store.load();
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    store.park(1, { until: FIXED_NOW + 5000, dailyQuota: true });
    await store.flush();
    const written = JSON.parse(backend.peek('test-key')!);
    expect(written).toEqual({
      '0': { until: FIXED_NOW + 1000, dailyQuota: false },
      '1': { until: FIXED_NOW + 5000, dailyQuota: true },
    });
  });

  it('sets TTL via EX option on flush', async () => {
    const backend = makeStringBackend();
    const store = await makeStore(backend);
    await store.load();
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    await store.flush();
    // The SET call should include EX parameter
    const setCall = backend.calls.find(c => c.op === 'set');
    expect(setCall).toBeDefined();
  });

  it('round-trips through the same code path used in production', async () => {
    // This is the regression test: write a cooldown, read it back through
    // the same load/park/flush cycle, and assert no WRONGTYPE error.
    const backend = makeStringBackend();
    const store = await makeStore(backend);

    // Simulate a rate-limited key
    store.park(0, { until: FIXED_NOW + 60_000, dailyQuota: false });
    store.park(2, { until: FIXED_NOW + 21_600_000, dailyQuota: true });
    await store.flush();

    // Simulate a fresh worker inheriting the state
    const store2 = await makeStore(backend);
    await store2.load();
    expect(store2.get(0)).toEqual({ until: FIXED_NOW + 60_000, dailyQuota: false });
    expect(store2.get(1)).toBeNull();
    expect(store2.get(2)).toEqual({ until: FIXED_NOW + 21_600_000, dailyQuota: true });
  });
});
