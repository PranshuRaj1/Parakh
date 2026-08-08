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
 * Redis-backed store. `load()` reads the whole map once; `flush()` writes it
 * back only when something changed — so a full key pool parked during a storm
 * costs ONE Redis GET + ONE Redis SET per delivery, not 7.
 */
export class RedisCooldownStore extends MemoryCooldownStore {
  private loaded = false;
  private dirty = false;

  constructor(
    private readonly redisKey: string,
    private readonly redisGet: (key: string) => Promise<string | null>,
    private readonly redisSet: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>,
    private readonly ttlSeconds = 7 * 24 * 60 * 60
  ) {
    super();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.redisGet(this.redisKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { until: number; dailyQuota?: boolean }>;
      for (const [k, v] of Object.entries(parsed)) {
        const idx = Number(k);
        if (Number.isFinite(idx) && v && typeof v.until === 'number') {
          this.entries.set(idx, { until: v.until, dailyQuota: !!v.dailyQuota });
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
    this.dirty = true;
  }

  clear(keyIndex: number): void {
    if (this.entries.delete(keyIndex)) this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const obj: Record<string, { until: number; dailyQuota: boolean }> = {};
      for (const [k, v] of this.entries) {
        obj[String(k)] = { until: v.until, dailyQuota: v.dailyQuota };
      }
      await this.redisSet(this.redisKey, JSON.stringify(obj), { ex: this.ttlSeconds });
    } catch (err) {
      console.warn(`[cooldown] Failed to flush ${this.redisKey}:`, err);
      this.dirty = true;
    }
  }
}
