import { describe, expect, it } from 'vitest';
import { createLLMClients } from './factory.js';
import type { Env } from '../index.js';

const baseEnv = {
  GEMINI_API_KEY: 'shared-gemini',
  GROQ_API_KEY: 'shared-groq',
  CF_ACCOUNT_ID: 'shared-account',
  CF_API_TOKEN: 'shared-cf-token',
  OPENROUTER_API_KEY: 'shared-or',
  UPSTASH_REDIS_URL: '',
  UPSTASH_REDIS_TOKEN: '',
} as unknown as Env;

function keysOf(client: unknown): string[] {
  return (client as { keys: string[] }).keys;
}

describe('createLLMClients with user creds (BYO-keys)', () => {
  it('replaces every provider with the user keys, never the shared env keys', () => {
    const { gemini, groq, cfai, openrouter } = createLLMClients(baseEnv, undefined, {
      githubLogin: 'user',
      geminiKeys: ['user-gemini'],
      groqKeys: ['user-groq'],
      cfaiAccountId: 'user-account',
      cfaiToken: 'user-cf-token',
      openrouterKey: 'user-or',
    });

    expect(keysOf(gemini)).toEqual(['user-gemini']);
    expect(groq).not.toBeNull();
    expect(keysOf(groq)).toEqual(['user-groq']);
    expect(cfai).not.toBeNull();
    expect(openrouter).not.toBeNull();
  });

  it('drops providers the user has no keys for even when the shared env has them', () => {
    const { gemini, groq, cfai, openrouter } = createLLMClients(baseEnv, undefined, {
      githubLogin: 'user',
      geminiKeys: ['user-gemini'],
      groqKeys: [],
      cfaiAccountId: null,
      cfaiToken: null,
      openrouterKey: null,
    });

    expect(keysOf(gemini)).toEqual(['user-gemini']);
    expect(groq).toBeNull();
    expect(cfai).toBeNull();
    expect(openrouter).toBeNull();
  });

  it('leaves shared env providers untouched when no creds are passed', () => {
    const { gemini, groq, cfai, openrouter } = createLLMClients(baseEnv);

    expect(keysOf(gemini)).toEqual(['shared-gemini']);
    expect(keysOf(groq as never)).toEqual(['shared-groq']);
    expect(cfai).not.toBeNull();
    expect(openrouter).not.toBeNull();
  });
});