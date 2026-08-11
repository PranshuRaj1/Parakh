/**
 * Global test cleanup.
 *
 * Loaded as a vitest setupFile for every test in the repo. Runs after each
 * test so mocks, global stubs, and timers can never leak into another test.
 */
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
});
