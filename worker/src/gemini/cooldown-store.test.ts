import { describe, expect, it } from 'vitest';
import { MemoryCooldownStore, RedisCooldownStore } from './cooldown-store.js';

const FIXED_NOW = 1_700_000_000_000;

/** Shared fake Redis hash backend so multiple stores can share one "redis". */
function makeHashBackend() {
  const fields = new Map<string, Map<string, string>>();
  const calls: Array<{ op: 'hgetall' | 'hset' | 'hdel' | 'expire'; key: string; field?: string; value?: string }> = [];
  return {
    calls,
    hgetall: async (key: string) => {
      calls.push({ op: 'hgetall', key });
      const h = fields.get(key);
      return h ? Object.fromEntries(h) : null;
    },
    hset: async (key: string, field: string, value: string) => {
      calls.push({ op: 'hset', key, field, value });
      if (!fields.has(key)) fields.set(key, new Map());
      fields.get(key)!.set(field, value);
    },
    hdel: async (key: string, field: string) => {
      calls.push({ op: 'hdel', key, field });
      fields.get(key)?.delete(field);
    },
    expire: async (key: string, seconds: number) => {
      calls.push({ op: 'expire', key, value: String(seconds) });
    },
    peek(key: string, field: string): string | null {
      return fields.get(key)?.get(field) ?? null;
    },
  };
}

function makeStore(backend: ReturnType<typeof makeHashBackend>, initial?: Record<string, string>) {
  if (initial) {
    for (const [k, v] of Object.entries(initial)) void backend.hset('test-key', k, v);
  }
  return new RedisCooldownStore(
    'test-key',
    backend.hgetall,
    backend.hset,
    backend.hdel,
    backend.expire
  );
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
  it('loads persisted entries from redis hash fields', async () => {
    const until = FIXED_NOW + 5000;
    const backend = makeHashBackend();
    const store = makeStore(backend, { '0': JSON.stringify({ until, dailyQuota: true }) });
    await store.load();
    expect(backend.calls.find(c => c.op === 'hgetall')?.key).toBe('test-key');
    expect(store.get(0)).toEqual({ until, dailyQuota: true });
    expect(store.get(1)).toBeNull();
  });

  it('loads only once — subsequent calls are no-ops', async () => {
    const backend = makeHashBackend();
    const store = makeStore(backend);
    await store.load();
    await store.load();
    expect(backend.calls.filter(c => c.op === 'hgetall')).toHaveLength(1);
  });

  it('only writes changed fields (dirty tracking)', async () => {
    const backend = makeHashBackend();
    const store = makeStore(backend);
    await store.load();
    await store.flush();
    expect(backend.calls.filter(c => c.op === 'hset' || c.op === 'hdel')).toHaveLength(0);

    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    await store.flush();
    const writes = backend.calls.filter(c => c.op === 'hset');
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe('test-key');
    expect(writes[0].field).toBe('0');

    // No change → no second write.
    await store.flush();
    expect(backend.calls.filter(c => c.op === 'hset')).toHaveLength(1);
  });

  it('clears a key via HDEL on flush', async () => {
    const backend = makeHashBackend();
    const store = makeStore(backend, { '0': JSON.stringify({ until: FIXED_NOW + 5000, dailyQuota: false }) });
    await store.load();
    store.clear(0);
    await store.flush();
    const hdel = backend.calls.find(c => c.op === 'hdel');
    expect(hdel?.key).toBe('test-key');
    expect(hdel?.field).toBe('0');
    expect(backend.peek('test-key', '0')).toBeNull();
  });

  it('survives corrupted redis state', async () => {
    const backend = makeHashBackend();
    const store = makeStore(backend, { '0': 'not-json{', '1': JSON.stringify({ until: FIXED_NOW + 5000, dailyQuota: false }) });
    await store.load();
    expect(store.get(0)).toBeNull();
    expect(store.get(1)).toEqual({ until: FIXED_NOW + 5000, dailyQuota: false });
  });

  it('writes per-key fields atomically, so concurrent writers do not clobber each other', async () => {
    // Simulates the race the old whole-blob store had: two workers park DIFFERENT
    // keys from the same cached state. With per-field HSET, both updates land.
    const backend = makeHashBackend();
    const workerA = makeStore(backend);
    const workerB = makeStore(backend);
    await workerA.load();
    await workerB.load();

    workerA.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    workerB.park(1, { until: FIXED_NOW + 5000, dailyQuota: true });
    await workerA.flush();
    await workerB.flush();

    expect(backend.peek('test-key', '0')).toBe(JSON.stringify({ until: FIXED_NOW + 1000, dailyQuota: false }));
    expect(backend.peek('test-key', '1')).toBe(JSON.stringify({ until: FIXED_NOW + 5000, dailyQuota: true }));
  });

  it('refreshes the hash TTL on flush', async () => {
    const backend = makeHashBackend();
    const store = makeStore(backend);
    await store.load();
    store.park(0, { until: FIXED_NOW + 1000, dailyQuota: false });
    await store.flush();
    const expire = backend.calls.find(c => c.op === 'expire');
    expect(expire?.key).toBe('test-key');
    expect(expire?.value).toBe(String(7 * 24 * 60 * 60));
  });
});