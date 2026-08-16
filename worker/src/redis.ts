import type { Env } from './index.js';
import { createRequestSignal } from './request-timeout.js';

async function parseRedisResponse(response: Response, op: string, key: string): Promise<{ result: unknown }> {
  try {
    return (await response.json()) as { result: unknown };
  } catch {
    throw new Error(`Redis ${op} failed: invalid JSON response for key ${key}`);
  }
}

export function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
      signal: createRequestSignal(),
    });
    if (!response.ok) {
      throw new Error(`Redis GET failed (${response.status}) for key ${key}`);
    }
    const { result } = await parseRedisResponse(response, 'GET', key);
    return result as string | null;
  };
}

export function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${opts.ex}` : `/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
      signal: createRequestSignal(),
    });
    if (!response.ok) {
      throw new Error(`Redis SET failed (${response.status}) for key ${key}`);
    }
    return parseRedisResponse(response, 'SET', key);
  };
}

/**
 * HGETALL — read all fields of a Redis hash. Used so cooldown state can be
 * persisted as per-key hash fields instead of a single JSON blob, letting
 * concurrent workers park/clear individual keys without clobbering each other.
 */
export function createRedisHGetAll(env: Env): (key: string) => Promise<Record<string, string> | null> {
  return async (key: string) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/hgetall/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis HGETALL failed (${response.status}) for key ${key}`);
    }
    const { result } = await parseRedisResponse(response, 'HGETALL', key);
    if (!result || !Array.isArray(result) || result.length === 0) return null;
    // HGETALL returns [field1, value1, field2, value2, ...]. Guard against an
    // odd-length payload so the trailing field never maps to `undefined`.
    const obj: Record<string, string> = {};
    const fields = result as string[];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  };
}

/**
 * HSET — atomically set a single field of a Redis hash. No read-modify-write,
 * so an HSET for key N can never overwrite another worker's HSET for key M.
 */
export function createRedisHSet(env: Env): (key: string, field: string, value: string) => Promise<unknown> {
  return async (key: string, field: string, value: string) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/hset/${encodeURIComponent(key)}/${encodeURIComponent(field)}/${encodeURIComponent(value)}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis HSET failed (${response.status}) for key ${key}`);
    }
    return parseRedisResponse(response, 'HSET', key);
  };
}

/**
 * HDEL — atomically remove a single field of a Redis hash.
 */
export function createRedisHDel(env: Env): (key: string, field: string) => Promise<unknown> {
  return async (key: string, field: string) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/hdel/${encodeURIComponent(key)}/${encodeURIComponent(field)}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis HDEL failed (${response.status}) for key ${key}`);
    }
    return parseRedisResponse(response, 'HDEL', key);
  };
}

/**
 * EXPIRE — set a TTL on a key. Applied after a cooldown flush so a parked hash
 * stops existing once cooldowns are stale, matching the old blob-TTL semantics.
 */
export function createRedisExpire(env: Env): (key: string, seconds: number) => Promise<unknown> {
  return async (key: string, seconds: number) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/expire/${encodeURIComponent(key)}/${seconds}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis EXPIRE failed (${response.status}) for key ${key}`);
    }
    return parseRedisResponse(response, 'EXPIRE', key);
  };
}

/**
 * Atomic SET NX EX — acquires a lock. Returns true if lock acquired, false if already held.
 * Used for session locking to prevent double-trigger races.
 */
export function createRedisSetNX(env: Env): (key: string, value: string, exSeconds: number) => Promise<boolean> {
  return async (key: string, value: string, exSeconds: number) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/set/${encodeURIComponent(key)}/${value}/EX/${exSeconds}/NX`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis SETNX failed (${response.status}) for key ${key}`);
    }
    const { result } = await parseRedisResponse(response, 'SET', key);
    return result === 'OK';
  };
}

/**
 * INCR — atomically increment a key and return the new value.
 * Used for per-repo/hour chat-spend budget counters. TTL is applied by the
 * caller (via createRedisExpire) so a fresh window resets the counter.
 */
export function createRedisIncr(env: Env): (key: string) => Promise<number> {
  return async (key: string) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/incr/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis INCR failed (${response.status}) for key ${key}`);
    }
    const { result } = await parseRedisResponse(response, 'INCR', key);
    return result as number;
  };
}

/**
 * DEL — delete a key. Used for lock release and stale state cleanup.
 */
export function createRedisDel(env: Env): (key: string) => Promise<void> {
  return async (key: string) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/del/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` }, signal: createRequestSignal() }
    );
    if (!response.ok) {
      throw new Error(`Redis DEL failed (${response.status}) for key ${key}`);
    }
  };
}
