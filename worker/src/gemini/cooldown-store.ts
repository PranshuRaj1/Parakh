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
 *
 * Redis representation: a single STRING key containing a JSON object where
 * each key is the key index (as a string) and each value is
 * `{ until: number, dailyQuota?: boolean }`. This matches the original format
 * created by the legacy GET/SET implementation and avoids WRONGTYPE errors
 * against existing STRING-typed keys in production.
 */

/** TTL for the persisted cooldown blob — parked keys stay until cooldowns are stale. */
export const COOLDOWN_HASH_TTL_SECONDS = 7 * 24 * 60 * 60;

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
 * Redis-backed store using a single STRING key with JSON serialization.
 *
 * `load()` reads the whole blob once per delivery; `flush()` writes it back
 * only when something changed — so a full key pool parked during a storm
 * costs ONE Redis GET + ONE Redis SET per delivery, not 7.
 *
 * Trade-off vs HSET: a full-map write on every flush, but the map is tiny
 * (≤7 keys for Gemini, ≤3 for Groq) and the SET is atomic so two workers
 * can't produce a torn write.
 */
export class RedisCooldownStore extends MemoryCooldownStore {
  private loaded = false;
  private dirty = false;
  private loadWarningEmitted = false;
  private flushWarningEmitted = false;

  constructor(private readonly options: {
    redisKey: string;
    redisGet: (key: string) => Promise<string | null>;
    redisSet: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>;
    ttlSeconds?: number;
    /** Optional subrequest budget — Redis calls count as subrequests on CF Workers. */
    budget?: { spend(n?: number): void };
  }) {
    super();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.options.budget?.spend(1);
      const raw = await this.options.redisGet(this.options.redisKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { until?: number; dailyQuota?: boolean }>;
      for (const [k, v] of Object.entries(parsed)) {
        const idx = Number(k);
        if (!Number.isFinite(idx) || !v || typeof v.until !== 'number') continue;
        this.entries.set(idx, { until: v.until, dailyQuota: !!v.dailyQuota });
      }
    } catch (err) {
      if (!this.loadWarningEmitted) {
        this.loadWarningEmitted = true;
        console.warn(
          `[cooldown] Failed to load ${this.options.redisKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
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
      this.options.budget?.spend(1);
      const obj: Record<string, { until: number; dailyQuota: boolean }> = {};
      for (const [k, v] of this.entries) {
        obj[k] = { until: v.until, dailyQuota: v.dailyQuota };
      }
      await this.options.redisSet(
        this.options.redisKey,
        JSON.stringify(obj),
        { ex: this.options.ttlSeconds ?? COOLDOWN_HASH_TTL_SECONDS }
      );
    } catch (err) {
      if (!this.flushWarningEmitted) {
        this.flushWarningEmitted = true;
        console.warn(
          `[cooldown] Failed to flush ${this.options.redisKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
      // Restore dirty flag so next flush retries the write.
      this.dirty = true;
    }
  }
}
