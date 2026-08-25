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

const env = { LLM_KEY_ENCRYPTION_SECRET: 'secret' } as never;
const stored = {
  githubId: 1,
  githubLogin: 'PranshuRaj1',
  geminiKeys: [{ enc: 'gemini', hint: 'mini' }],
  groqKeys: [],
  cfaiKeys: [],
  cfaiAccountId: null,
  openrouterKeys: [],
  updatedAt: '',
};

describe('resolveUserCreds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shares PranshuRaj1 keys with pranshu3961-lang', async () => {
    getInstallation.mockResolvedValue({ installedBy: 'pranshu3961-lang' });
    getKeys.mockImplementation(async (login: string) => login === 'PranshuRaj1' ? stored : null);

    await expect(resolveUserCreds('pranshu3961-lang', env)).resolves.toMatchObject({
      githubLogin: 'PranshuRaj1',
      geminiKeys: ['gemini'],
    });
    expect(getKeys).toHaveBeenNthCalledWith(2, 'PranshuRaj1', env);
  });

  it('does not share keys with other users', async () => {
    getInstallation.mockResolvedValue({ installedBy: 'someone-else' });
    getKeys.mockResolvedValue(null);

    await expect(resolveUserCreds('someone-else', env)).resolves.toBeNull();
    expect(getKeys).toHaveBeenCalledOnce();
    expect(getKeys).toHaveBeenCalledWith('someone-else', env);
  });
});
