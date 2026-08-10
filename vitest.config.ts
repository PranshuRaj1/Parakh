import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: workspaceRoot,
  test: {
    environment: 'node',
    setupFiles: ['./tests/global-cleanup.ts'],
    include: ['worker/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
  },
});
