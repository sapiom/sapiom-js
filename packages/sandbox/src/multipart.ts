/** Max parts allowed per multipart upload (Blaxel constraint). */
export const MAX_PARTS = 10_000;

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
