/**
 * Webhook Signature Verification
 *
 * Verifies GitHub webhook payloads using HMAC-SHA256.
 * Uses Web Crypto API (Cloudflare Workers compatible — no Node.js crypto).
 *
 * This module ONLY does signature verification. No routing, no business logic.
 */

/**
 * Verify the HMAC-SHA256 signature of a GitHub webhook payload.
 *
 * @param payload - Raw request body string
 * @param signature - Value of the X-Hub-Signature-256 header (format: "sha256=<hex>")
 * @param secret - Webhook secret configured in the GitHub App
 * @returns true if signature is valid
 */
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  if (!signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const expectedHex = signature.slice('sha256='.length);

  // Import the secret as an HMAC key
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the payload
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  );

  // Convert to hex string
  const computedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(computedHex, expectedHex);
}

/**
 * Constant-time string comparison.
 * Prevents timing attacks by always comparing all characters.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
