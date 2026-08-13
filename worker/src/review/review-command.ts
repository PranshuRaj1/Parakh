import type { ReviewMode } from '@parakh/shared';

/** Parse only canonical commands. Free-form requests continue through intent classification. */
export function parseReviewCommand(comment: string): ReviewMode | null {
  const normalized = comment
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();

  if (!normalized.startsWith('@parakh')) return null;
  const command = normalized.replace(/^@parakh\b/, '').trim();
  if (command === 'full review' || command === 'review full') return 'full';
  if (command === 'review' || command === 're-review' || command === 'rereview') {
    return 'incremental';
  }
  return null;
}
