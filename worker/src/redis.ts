import type { Env } from './index.js';

export function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`Redis GET failed (${response.status}) for key ${key}`);
    }
    const data = (await response.json()) as { result: string | null };
    return data.result;
  };
}

export function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${opts.ex}` : `/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`Redis SET failed (${response.status}) for key ${key}`);
    }
    return response.json();
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
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` } }
    );
    if (!response.ok) {
      throw new Error(`Redis SETNX failed (${response.status}) for key ${key}`);
    }
    const data = (await response.json()) as { result: string | null };
    return data.result === 'OK';
  };
}

/**
 * DEL — delete a key. Used for lock release and stale state cleanup.
 */
export function createRedisDel(env: Env): (key: string) => Promise<void> {
  return async (key: string) => {
    const response = await fetch(
      `${env.UPSTASH_REDIS_URL}/del/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` } }
    );
    if (!response.ok) {
      throw new Error(`Redis DEL failed (${response.status}) for key ${key}`);
    }
  };
}
