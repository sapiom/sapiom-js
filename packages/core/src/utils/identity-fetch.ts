/** Keep the identity JWT on the origin it was attached for when a request is redirected. */
import { fetchKeepingCredential } from "@sapiom/analytics-core/credential";

const IDENTITY_HEADER = "sapiom-identity";

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
): Promise<Response> {
  if (!request.headers.has(IDENTITY_HEADER) || request.redirect !== "follow") {
    return fetchImpl(request);
  }
  // Buffered because a 307/308 resends the body and a stream cannot be replayed.
  const body = request.body === null ? undefined : await request.arrayBuffer();
  const init: RequestInit = {
    method: request.method,
    body,
    signal: request.signal,
    mode: request.mode,
    credentials: request.credentials,
    keepalive: request.keepalive,
    referrerPolicy: request.referrerPolicy,
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
