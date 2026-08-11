/**
 * Key Cooldown Store
 *
 * Tracks per-key cooldown state so a rate-limited key is parked instead of
 * re-hammered. The KEY improvement over the old in-memory Map: state is
 * persisted to Redis, so a queue redelivery that constructs a FRESH client
 * inherits the parked keys instead of burning all 7 Gemini keys again.
 *
 * Cooldowns are global (not per-repo): if review A exhausts every Gemini key,
 * review B must also skip them rather than fire 7 doomed requests.
 */

export interface CooldownEntry {
  /** Epoch-ms timestamp until which the key may not be retried. */
  until: number;
  /** True when parked for daily-quota exhaustion (long cooldown, won't recover soon). */
  dailyQuota: boolean;
}

export interface CooldownStore {
  /** Load persisted state into memory. Idempotent — safe to call per logical call. */
  load(): Promise<void>;
  /** Current entry for a key index, or null when not parked. */
  get(keyIndex: number): CooldownEntry | null;
  /** Park a key (memory only). Marks dirty if the entry actually changed. */
  park(keyIndex: number, entry: CooldownEntry): void;
  /** Clear a key's cooldown on success (memory only). */
  clear(keyIndex: number): void;
  /** Persist dirty state. No-op when nothing changed. */
  flush(): Promise<void>;
}

/** In-memory store (tests / no Redis). Behavior matches the original Map. */
export class MemoryCooldownStore implements CooldownStore {
  protected entries = new Map<number, CooldownEntry>();

  async load(): Promise<void> {}

  get(keyIndex: number): CooldownEntry | null {
    return this.entries.get(keyIndex) ?? null;
  }

  park(keyIndex: number, entry: CooldownEntry): void {
    this.entries.set(keyIndex, entry);
  }

  clear(keyIndex: number): void {
    this.entries.delete(keyIndex);
  }

  async flush(): Promise<void> {}
}

/**
 * Redis-backed store. Cooldown state is persisted as ONE Redis hash where each
 * key index is a hash field: `HGETALL` then read once a delivery, HSET/HDEL for
 * the individual keys that actually changed.
 *
 * Unlike a single JSON blob, this is NOT a read-modify-write over the whole
 * map: HSET(key){KEY_N} / HDEL(key){KEY_N} are atomic per-field writes, so two
 * workers parking DIFFERENT keys concurrently cannot clobber each other's
 * update. The stale read of the OTHER worker's just-written field is harmless —
 * worst case that key is re-read as not-parked once and retried. Same best-effort
 * semantics as before, minus the whole-map overwrite race.
 */
export class RedisCooldownStore extends MemoryCooldownStore {
  private loaded = false;
  private dirty = new Map<number, CooldownEntry | null>();

  constructor(
    private readonly redisKey: string,
    private readonly redisHGetAll: (key: string) => Promise<Record<string, string> | null>,
    private readonly redisHSet: (key: string, field: string, value: string) => Promise<unknown>,
    private readonly redisHDel: (key: string, field: string) => Promise<unknown>,
    private readonly redisExpire: (key: string, seconds: number) => Promise<unknown>,
    private readonly ttlSeconds = 7 * 24 * 60 * 60
  ) {
    super();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.redisHGetAll(this.redisKey);
      if (!raw) return;
      for (const [k, v] of Object.entries(raw)) {
        const idx = Number(k);
        if (Number.isFinite(idx) && v) {
          try {
            const parsed = JSON.parse(v) as { until: number; dailyQuota?: boolean };
            this.entries.set(idx, { until: parsed.until, dailyQuota: !!parsed.dailyQuota });
          } catch {
            // skip one corrupt field instead of failing the whole load
          }
        }
      }
    } catch (err) {
      console.warn(`[cooldown] Failed to load ${this.redisKey}:`, err);
    }
  }

  park(keyIndex: number, entry: CooldownEntry): void {
    const prev = this.entries.get(keyIndex);
    if (prev && prev.until === entry.until && prev.dailyQuota === entry.dailyQuota) return;
    this.entries.set(keyIndex, entry);
    this.dirty.set(keyIndex, entry);
  }

  clear(keyIndex: number): void {
    if (this.entries.delete(keyIndex)) this.dirty.set(keyIndex, null);
  }

  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const changes = new Map(this.dirty);
    this.dirty.clear();
    try {
      for (const [keyIndex, entry] of changes) {
        if (entry === null) {
          await this.redisHDel(this.redisKey, String(keyIndex));
        } else {
          await this.redisHSet(
            this.redisKey,
            String(keyIndex),
            JSON.stringify({ until: entry.until, dailyQuota: entry.dailyQuota })
          );
        }
      }
      await this.redisExpire(this.redisKey, this.ttlSeconds);
    } catch (err) {
      console.warn(`[cooldown] Failed to flush ${this.redisKey}:`, err);
      for (const [k, v] of changes) this.dirty.set(k, v);
    }
  }
}
