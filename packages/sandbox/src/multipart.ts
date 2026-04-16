/** Max parts allowed per multipart upload (Blaxel constraint). */
export const MAX_PARTS = 10_000;

/** Default number of retries for a single failed part upload. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default initial retry backoff in milliseconds. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 50;

/** HTTP status codes worth retrying. 4xx are user errors unless explicitly transient. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Error thrown by multipart HTTP methods when the server returns a non-2xx.
 * Exposes `status` + `retryAfterMs` (parsed from `Retry-After`) so callers
 * and the retry loop can make informed decisions.
 */
export class SandboxHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "SandboxHttpError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse a `Retry-After` header value. Supports both forms:
 *  - delta-seconds integer (e.g. `"30"`)
 *  - HTTP-date (e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"`)
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Wrap a `fetch` response: if non-2xx, throw a `SandboxHttpError` carrying
 * the status + Retry-After, otherwise return the response for the caller to
 * parse.
 */
export async function ensureOk(
  response: Response,
  errorPrefix: string,
): Promise<Response> {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  throw new SandboxHttpError(
    `${errorPrefix}: ${response.status} ${text}`,
    response.status,
    retryAfterMs,
  );
}

export interface RetryOptions {
  /** Max number of retry attempts after the initial try. @default 3 */
  maxRetries?: number;

  /** Initial backoff in ms. Doubles each retry with up to `base` ms jitter. @default 50 */
  retryBaseDelayMs?: number;

  /** AbortSignal to cancel the retry loop. */
  signal?: AbortSignal;
}

/** Whether this error is worth retrying. */
function isRetryable(err: unknown): boolean {
  if (err instanceof SandboxHttpError) return RETRYABLE_STATUS.has(err.status);
  // Network-level failures (fetch rejected): typically TypeError "fetch failed"
  // or AbortError. Retry non-abort errors.
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    return true;
  }
  return false;
}

/**
 * Retry `fn` up to `maxRetries` times on retryable errors with jittered
 * exponential backoff. Honors `Retry-After` when the server provides one.
 * Respects `signal` for prompt cancellation during the backoff wait.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const base = opts?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const signal = opts?.signal;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err) || signal?.aborted) {
        throw err;
      }
      const backoff =
        err instanceof SandboxHttpError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : base * 2 ** attempt + Math.random() * base;
      await sleepWithSignal(backoff, signal);
    }
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Default part size: 5 MiB. Bottom of Blaxel's recommended 5–10 MB range
 * and well clear of the Sapiom ingress 8 MiB body-size ceiling (with
 * room left for multipart form-data overhead).
 */
export const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

/** Default number of parallel part uploads. */
export const DEFAULT_CONCURRENCY = 4;

/** Default file permissions (Blaxel default). */
export const DEFAULT_PERMISSIONS = "0644";

/**
 * Normalize any supported content type into a `Blob`.
 * `Blob.slice()` gives us random-access + lazy reads, so large inputs don't
 * have to sit materialized in memory.
 */
export function toBlob(content: Blob | Uint8Array | string): Blob {
  if (content instanceof Blob) return content;
  if (typeof content === "string") {
    return new Blob([new TextEncoder().encode(content)]);
  }
  return new Blob([content]);
}

export interface PartPlan {
  partNumber: number;
  start: number;
  end: number;
}

/**
 * Split a byte range into part plans.
 * Always emits at least one part (even for zero-byte inputs) so the caller
 * still goes through the initiate/upload/complete handshake.
 */
export function planParts(totalBytes: number, partSize: number): PartPlan[] {
  if (!Number.isFinite(partSize) || partSize <= 0) {
    throw new Error(`partSize must be a positive integer (got ${partSize})`);
  }

  const count = totalBytes === 0 ? 1 : Math.ceil(totalBytes / partSize);

  if (count > MAX_PARTS) {
    const minPartSize = Math.ceil(totalBytes / MAX_PARTS);
    throw new Error(
      `File of ${totalBytes} bytes would require ${count} parts at partSize=${partSize}, ` +
        `but the server accepts at most ${MAX_PARTS}. Increase partSize to at least ${minPartSize}.`,
    );
  }

  const plans: PartPlan[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * partSize;
    const end = Math.min(start + partSize, totalBytes);
    plans.push({ partNumber: i + 1, start, end });
  }
  return plans;
}

/**
 * Run `worker` over `items` with at most `concurrency` promises in flight.
 * Rejects on the first worker failure (and stops scheduling further items).
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be >= 1 (got ${concurrency})`);
  }

  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const limit = Math.min(concurrency, items.length);
  const runners: Promise<void>[] = [];

  for (let slot = 0; slot < limit; slot++) {
    runners.push(
      (async () => {
        while (!failed) {
          const i = next++;
          if (i >= items.length) return;
          try {
            results[i] = await worker(items[i]!, i);
          } catch (err) {
            if (!failed) {
              failed = true;
              firstError = err;
            }
            return;
          }
        }
      })(),
    );
  }

  await Promise.all(runners);

  if (failed) throw firstError;
  return results;
}
