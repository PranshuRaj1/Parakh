/** Hash used to decide whether a Redis review checkpoint matches a raw diff. */
export type ResumeValidationHash = string;

/**
 * Hash the exact raw GitHub diff payload used for queue resume validation.
 *
 * This hash is deliberately order- and whitespace-sensitive: any payload
 * change invalidates the checkpoint. It must not be used for semantic caching
 * or cross-PR equality. A future canonical change-set hash must operate on
 * parsed, normalized, deterministically ordered evidence instead.
 */
export async function hashResumeValidationDiff(
  rawDiff: string
): Promise<ResumeValidationHash> {
  const data = new TextEncoder().encode(rawDiff);
  const digest = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
