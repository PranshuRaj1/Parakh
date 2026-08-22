/**
 * Smoke fixture for the conventions feature (#34).
 *
 * Deliberately plain: this file exists so a review has a real TypeScript diff
 * to anchor on while the repo's AGENTS.md conventions are exercised.
 */

export function summarizeCounts(counts: number[]): { total: number; count: number } {
  const total = counts.reduce((sum, n) => sum + n, 0);
  return { total, count: counts.length };
}
