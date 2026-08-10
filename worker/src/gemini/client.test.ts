import { describe, expect, it, vi } from 'vitest';
import { AllKeysExhaustedError } from './keyPool.js';

const { keyCalls } = vi.hoisted(() => ({ keyCalls: [] as string[] }));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    apiKey: string;
    constructor(apiKey: string) {
      this.apiKey = apiKey;
      keyCalls.push(apiKey);
    }
    getGenerativeModel() {
      return {
        generateContent: async () => {
          if (this.apiKey === 'bad') {
            throw new Error('429 RESOURCE_EXHAUSTED quota exceeded');
          }
          if (this.apiKey === 'broken') {
            throw new Error('Invalid argument');
          }
          if (this.apiKey === 'unavail') {
            throw new Error('404 model no longer available to new users');
          }
          return {
            response: { text: () => JSON.stringify({ genericFindings: [], ruleFindings: [] }) },
          };
        },
      };
    }
  },
}));

import { extractResponseWithThinking, GeminiClient } from './client.js';

function makeEnv(keys?: string): { GEMINI_API_KEYS?: string; GEMINI_API_KEY: string } {
  return { GEMINI_API_KEYS: keys, GEMINI_API_KEY: 'fallback' };
}

describe('extractResponseWithThinking', () => {
  it('separates thinking parts from the JSON text parts', () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'I think this is a bug' },
              { text: '{"genericFindings":[],"ruleFindings":[]}' },
            ],
          },
        },
      ],
    };
    expect(extractResponseWithThinking(response)).toEqual({
      jsonText: '{"genericFindings":[],"ruleFindings":[]}',
      thinking: 'I think this is a bug',
    });
  });

  it('joins multiple text parts and multiple thinking parts', () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'thought one' },
              { text: '{"a":1}' },
              { thought: true, text: 'thought two' },
              { text: '{"b":2}' },
            ],
          },
        },
      ],
    };
    expect(extractResponseWithThinking(response)).toEqual({
      jsonText: '{"a":1}\n{"b":2}',
      thinking: 'thought one\nthought two',
    });
  });

  it('handles absent candidates and non-text parts', () => {
    expect(extractResponseWithThinking({})).toEqual({ jsonText: '', thinking: '' });
    expect(
      extractResponseWithThinking({ candidates: [{ content: { parts: [{ foo: 1 }] } }] })
    ).toEqual({ jsonText: '', thinking: '' });
  });
});

describe('GeminiClient key rotation', () => {
  it('falls through to the next key when the first is rate-limited', async () => {
    keyCalls.length = 0;
    const client = new GeminiClient(makeEnv('bad,good'));
    const result = await client.reviewDiff('file.ts', 'diff', []);
    expect(result.genericFindings).toEqual([]);
    expect(result.ruleFindings).toEqual([]);
    expect(keyCalls).toEqual(['bad', 'good']);
  });

  it('throws AllKeysExhaustedError when every key is rate-limited', async () => {
    keyCalls.length = 0;
    const client = new GeminiClient(makeEnv('bad,bad'));
    await expect(client.reviewDiff('file.ts', 'diff', [])).rejects.toBeInstanceOf(AllKeysExhaustedError);
    expect(keyCalls).toEqual(['bad', 'bad']);
  });

  it('propagates non-rate-limit errors without trying other keys', async () => {
    keyCalls.length = 0;
    const client = new GeminiClient(makeEnv('broken,good'));
    await expect(client.reviewDiff('file.ts', 'diff', [])).rejects.toThrow('Invalid argument');
    expect(keyCalls).toEqual(['broken']);
  });

  it('skips keys that cannot serve the model instead of aborting the call', async () => {
    keyCalls.length = 0;
    const client = new GeminiClient(makeEnv('unavail,good'));
    const result = await client.reviewDiff('file.ts', 'diff', []);
    expect(result.genericFindings).toEqual([]);
    expect(keyCalls).toEqual(['unavail', 'good']);
  });
});
