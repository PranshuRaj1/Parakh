/**
 * Code-host provider registry.
 *
 * The single place providers register. Adding GitLab/Bitbucket = create the
 * adapter file and add one entry here.
 */

import type { CodeHostProvider } from './types.js';
import { githubProvider } from './github.js';

export const providers: CodeHostProvider[] = [githubProvider];

export function getProvider(id: string): CodeHostProvider | null {
  return providers.find((provider) => provider.id === id) ?? null;
}

export function getProviderByEvent(eventType: string): CodeHostProvider | null {
  return providers.find((provider) => provider.isEvent(eventType)) ?? null;
}