import type { Env } from './index.js';

export function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    const data = (await response.json()) as { result: string | null };
    return data.result;
  };
}

export function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${key}/${value}/EX/${opts.ex}` : `/${key}/${value}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    return response.json();
  };
}
