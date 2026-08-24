import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getInstallation, getKeys, decrypt } = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  getKeys: vi.fn(),
  decrypt: vi.fn(async (value: string) => value),
}));

vi.mock('../db/installations.js', () => ({ getInstallationByOwner: getInstallation }));
vi.mock('../db/user-llm-keys.js', () => ({ getStoredUserLLMKeysByLogin: getKeys }));
vi.mock('./encryption.js', () => ({ decryptKey: decrypt }));

import { resolveUserCreds } from './user-creds.js';

const env = {
  LLM_KEY_ENCRYPTION_SECRET: 'secret',
  GEMINI_API_KEYS: 'gemini-1, gemini-2',
  GROQ_API_KEY: 'groq-1',
  CF_ACCOUNT_ID: 'cf-account',
  CF_API_TOKEN: 'cf-token',
  OPENROUTER_API_KEY: 'openrouter-1',
} as never;
describe('resolveUserCreds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses Worker env keys for PranshuRaj1 without an installation row', async () => {
    await expect(resolveUserCreds('PranshuRaj1', env)).resolves.toMatchObject({
      githubLogin: 'PranshuRaj1',
      geminiKeys: ['gemini-1', 'gemini-2'],
      groqKeys: ['groq-1'],
      cfaiAccountId: 'cf-account',
      cfaiToken: 'cf-token',
      openrouterKey: 'openrouter-1',
    });
    expect(getInstallation).not.toHaveBeenCalled();
    expect(getKeys).not.toHaveBeenCalled();
  });

  it('does not share keys with other users', async () => {
    getInstallation.mockResolvedValue({ installedBy: 'someone-else' });
    getKeys.mockResolvedValue(null);

    await expect(resolveUserCreds('someone-else', env)).resolves.toBeNull();
    expect(getKeys).toHaveBeenCalledOnce();
    expect(getKeys).toHaveBeenCalledWith('someone-else', env);
  });
});
