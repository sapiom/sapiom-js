/** Keep the identity JWT on the origin it was attached for when a request is redirected. */
import { fetchKeepingCredential } from "@sapiom/analytics-core/credential";

const IDENTITY_HEADER = "sapiom-identity";

export interface IdentityFetchOptions {
  /** The caller's undici `dispatcher`, which a request rebuilt for a redirect would otherwise lose. */
  dispatcher?: unknown;
  /**
   * An unsent clone of the request, read only when a 307/308 resends the body.
   * Without it that redirect fails, as `fetch` fails for a stream body.
   */
  replay?: Request;
}

/** Tells the redirect loop a body exists; `send` reads it only if a hop resends it. */
const REPLAYED_BODY = new ArrayBuffer(0);

/** `fetch` keeps `Sapiom-Identity` across a redirect to another origin, so the hops
 * are followed here, without any Sapiom credential once the origin changes. */
export async function fetchDroppingIdentityCrossOrigin(
  fetchImpl: typeof globalThis.fetch,
  request: Request,
  label: string,
  options: IdentityFetchOptions = {},
): Promise<Response> {
  if (!request.headers.has(IDENTITY_HEADER) || request.redirect !== "follow") {
    return fetchImpl(request);
  }
  const dispatcher: RequestInit =
    options.dispatcher !== undefined
      ? ({ dispatcher: options.dispatcher } as RequestInit)
      : {};
  let sent = false;
  let replayed: Promise<ArrayBuffer> | undefined;
  const send: typeof globalThis.fetch = (url, init) => {
    if (!sent) {
      sent = true;
      // Sent as is so its body streams; `fetch` would check `integrity` against a
      // redirect's own body, so the loop checks the final response instead.
      return fetchImpl(request, {
        ...dispatcher,
        redirect: "manual",
        integrity: "",
      });
    }
    if (init?.body !== REPLAYED_BODY) {
      return fetchImpl(url, { ...init, ...dispatcher });
    }
    replayed ??= readBody(options.replay!.clone());
    return replayed.then((body) =>
      fetchImpl(url, { ...init, ...dispatcher, body }),
    );
  };
  const init: RequestInit = {
    method: request.method,
    // A stream makes the loop refuse a 307/308, as `fetch` does without a copy to resend.
    body:
      request.body === null
        ? undefined
        : options.replay
          ? REPLAYED_BODY
          : request.body,
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
    send,
    request.url,
    init,
    Object.fromEntries(request.headers),
    // `fetch` follows http hops too, so no channel is refused here.
    { allowInsecureHttp: true, label },
  );
}

/** An abort must end the read even when the body never closes, as it would end `fetch`. */
async function readBody(request: Request): Promise<ArrayBuffer> {
  const { signal } = request;
  signal.throwIfAborted();
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
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
