const WORKER_TIMEOUT_MS = 8000;

export class WorkerError extends Error {
  constructor(
    public readonly status: number,
    message = 'Worker request failed'
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

/**
 * Fetch a worker API endpoint with the bearer secret, a hard timeout, and a
 * JSON response guard. Throws WorkerError instead of leaking worker internals
 * to clients: callers map status → generic message.
 */
export async function fetchWorkerJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const workerUrl = process.env.WORKER_API_URL;
  const workerSecret = process.env.WORKER_API_SECRET;
  if (!workerUrl || !workerSecret) {
    throw new WorkerError(500, 'Worker not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${workerUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${workerSecret}`,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch {
    throw new WorkerError(502, 'Worker unreachable');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new WorkerError(res.status);

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new WorkerError(res.status, 'Unexpected worker response');
  }
  return res.json();
}