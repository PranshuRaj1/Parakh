import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/global-cleanup.ts'],
    include: ['worker/src/**/*.test.ts', 'shared/src/**/*.test.ts'],
  },
});
