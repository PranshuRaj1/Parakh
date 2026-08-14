export const OUTBOUND_REQUEST_TIMEOUT_MS = 20_000;

export function createRequestSignal(timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
