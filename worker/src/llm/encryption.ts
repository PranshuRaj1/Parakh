/**
 * API Key Encryption
 *
 * User-supplied LLM API keys are stored encrypted at rest (AES-256-GCM) so
 * plaintext keys never touch the database or the dashboard. The encryption key
 * is derived from the LLM_KEY_ENCRYPTION_SECRET worker secret (SHA-256).
 *
 * Envelope format: "{ivBase64}.{ciphertextBase64}" where ciphertext already
 * includes the GCM auth tag (WebCrypto appends it). A separate `hint` is
 * stored alongside for display: the last 4 chars, masked when the key is too
 * short to be recognizable.
 */

const encoder = new TextEncoder();

/** Derive an AES-GCM CryptoKey from the worker secret. */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypt an API key. Returns the envelope string to persist. */
export async function encryptKey(apiKey: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(apiKey)
  );
  return `${toBase64(iv)}.${toBase64(ciphertext)}`;
}

/** Decrypt an API key from a stored envelope string. */
export async function decryptKey(envelope: string, secret: string): Promise<string> {
  const [ivB64, dataB64] = envelope.split('.');
  if (!ivB64 || !dataB64) throw new Error('malformed encrypted key envelope');
  const key = await deriveKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivB64) },
    key,
    fromBase64(dataB64)
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Display hint for a stored key: the last 4 characters, or a fully masked
 * placeholder when the key is too short to be recognizable.
 */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length > 4 ? `••••${trimmed.slice(-4)}` : '••••••••';
}