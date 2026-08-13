export const OUTBOUND_REQUEST_TIMEOUT_MS = 15_000;

export function createRequestSignal(timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
