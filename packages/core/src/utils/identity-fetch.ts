/** Keep the identity JWT on the origin it was attached for when a request is redirected. */
import { fetchKeepingCredential } from "@sapiom/analytics-core/credential";

const IDENTITY_HEADER = "sapiom-identity";

export interface IdentityFetchOptions {
  /**
   * The caller's body was a stream: forward it as one instead of buffering, as
   * `fetch` does (a 307/308 then fails rather than resending it).
   */
  streamBody?: boolean;
  /** The caller's undici `dispatcher`, which a rebuilt request would otherwise lose. */
  dispatcher?: unknown;
}

/**
 * Send `request` as `fetch` would, except that the first redirect to another origin
 * drops `Sapiom-Identity` (fetch only drops `authorization`, `cookie` and
 * `proxy-authorization`). A request without the header, or with a `manual` or
 * `error` redirect mode, goes to `fetchImpl` untouched.
 *
 * No channel is refused here: `allowInsecureHttp` keeps every http(s) hop that
 * `fetch` itself would follow.
 */
export async function fetchDroppingIdentityCrossOrigin(
  fetchImpl: typeof globalThis.fetch,
  request: Request,
  label: string,
  options: IdentityFetchOptions = {},
): Promise<Response> {
  if (!request.headers.has(IDENTITY_HEADER) || request.redirect !== "follow") {
    return fetchImpl(request);
  }
  // Buffered because a 307/308 resends the body, which `fetch` can replay for
  // every body type except a stream.
  const body =
    request.body === null
      ? undefined
      : options.streamBody
        ? request.body
        : await readBody(request);
  const init: RequestInit = {
    method: request.method,
    body,
    ...(options.streamBody && body !== undefined ? { duplex: "half" } : {}),
    ...(options.dispatcher !== undefined
      ? ({ dispatcher: options.dispatcher } as RequestInit)
      : {}),
    signal: request.signal,
    mode: request.mode,
    credentials: request.credentials,
    keepalive: request.keepalive,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    // Not in Node's RequestInit type, but undici honours it (no-cache, no-store).
    ...({ cache: request.cache } as RequestInit),
    redirect: "follow",
    ...(request.integrity ? { integrity: request.integrity } : {}),
  };
  return fetchKeepingCredential(
    fetchImpl,
    request.url,
    init,
    Object.fromEntries(request.headers),
    { allowInsecureHttp: true, label },
  );
}

/** `request.arrayBuffer()`, except that an abort rejects at once and cancels the source, as `fetch` does. */
async function readBody(request: Request): Promise<ArrayBuffer> {
  const { signal } = request;
  signal.throwIfAborted();
  const reader = request.body!.getReader();
  const onAbort = () =>
    void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    signal.throwIfAborted();
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
