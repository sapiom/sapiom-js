/**
 * Where the tenant credential may travel: over https, or plain http to a
 * loopback host. Redirects are followed here rather than by `fetch`, because
 * `fetch` drops `authorization` on an origin change but keeps custom headers
 * such as `x-sapiom-api-key`.
 */

export const ALLOW_INSECURE_HTTP_ENV = "SAPIOM_ALLOW_INSECURE_HTTP";

export interface CredentialPolicy {
  /** Plain http to a non-loopback host is allowed (trusted private network). */
  readonly allowInsecureHttp: boolean;
}

/** Explicit config wins, then `SAPIOM_ALLOW_INSECURE_HTTP=1` (or `true`). */
export function resolveCredentialPolicy(
  explicit: boolean | undefined,
): CredentialPolicy {
  const env = process.env[ALLOW_INSECURE_HTTP_ENV]?.trim().toLowerCase();
  return { allowInsecureHttp: explicit ?? (env === "1" || env === "true") };
}

/** `localhost`, `*.localhost` (RFC 6761, used by the local services stack), 127/8, `[::1]`. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Throws, before anything is sent, when `url` is not a channel the credential
 * may use. A TypeError with no `cause`, unlike a failed connection. Only the
 * origin is echoed: a path or query can carry a secret.
 */
export function assertCredentialMayTravel(
  url: URL,
  policy: CredentialPolicy,
  redirectedFrom?: URL,
): void {
  if (url.protocol === "https:") return;
  const from = redirectedFrom
    ? ` (redirected from ${redirectedFrom.origin})`
    : "";
  if (url.protocol !== "http:") {
    throw new TypeError(
      `@sapiom/tools: cannot request '${url.protocol}' URLs, expected http or https${from}`,
    );
  }
  if (policy.allowInsecureHttp || isLoopbackHostname(url.hostname)) return;
  throw new TypeError(
    `@sapiom/tools: refusing plaintext HTTP to ${url.origin}${from}. The tenant API key only ` +
      `travels over https or to a loopback host (localhost, *.localhost, 127.0.0.1, [::1]). ` +
      `For a trusted private network, opt in with createClient({ allowInsecureHttp: true }) ` +
      `or ${ALLOW_INSECURE_HTTP_ENV}=1.`,
  );
}

/** What `fetch` itself drops on an origin change, plus the other credential header. */
const CROSS_ORIGIN_DROPPED: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "x-api-key",
]);

/** Headers for a hop to another origin: no credential, no `x-sapiom-*` context. */
export function withoutCrossOriginHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return pick(
    headers,
    (name) => !CROSS_ORIGIN_DROPPED.has(name) && !name.startsWith("x-sapiom-"),
  );
}

const REQUEST_BODY_HEADERS: ReadonlySet<string> = new Set([
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
]);

/** Headers for a redirect `fetch` turns into a bodiless GET. */
export function withoutBodyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return pick(headers, (name) => !REQUEST_BODY_HEADERS.has(name));
}

function pick(
  headers: Record<string, string>,
  keep: (lowerCaseName: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (keep(name.toLowerCase())) out[name] = value;
  }
  return out;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** Same ceiling as `fetch`. */
export const MAX_REDIRECTS = 20;

/** A body `fetch` cannot send twice: a web stream or an async iterable. */
function isStreamBody(body: RequestInit["body"]): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as {
    getReader?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };
  return (
    typeof b.getReader === "function" ||
    typeof b[Symbol.asyncIterator] === "function"
  );
}

/**
 * `fetch` with its `redirect: "follow"` behavior (the Fetch spec's HTTP-redirect
 * steps), plus the channel check on every hop and the credential dropped on an
 * origin change. A caller asking for `manual` or `error` gets plain `fetch`.
 */
export async function fetchKeepingCredential(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  headers: Record<string, string>,
  policy: CredentialPolicy,
): Promise<Response> {
  if (init.redirect === "manual" || init.redirect === "error") {
    return fetchImpl(url, { ...init, headers });
  }
  const start = new URL(url);
  let href = url;
  let current = start;
  let method = init.method;
  let body = init.body;
  let hopHeaders = headers;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(href, {
      ...init,
      method,
      body,
      headers: hopHeaders,
      redirect: "manual",
    });
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get("location")
      : null;
    if (location === null) return response;
    // Never handed to the caller: free the connection, even if we refuse the hop.
    await response.body?.cancel().catch(() => undefined);

    const next = new URL(location, current);
    assertCredentialMayTravel(next, policy, current);
    if (redirects === MAX_REDIRECTS) {
      throw new TypeError(
        `@sapiom/tools: more than ${MAX_REDIRECTS} redirects from ${start.origin}`,
      );
    }
    if (response.status !== 303 && isStreamBody(body)) {
      throw new TypeError(
        `@sapiom/tools: cannot resend a streamed request body after a ${response.status} from ${current.origin}`,
      );
    }
    const verb = (method ?? "GET").toUpperCase();
    if (
      ((response.status === 301 || response.status === 302) &&
        verb === "POST") ||
      (response.status === 303 && verb !== "GET" && verb !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
      hopHeaders = withoutBodyHeaders(hopHeaders);
    }
    if (next.origin !== current.origin) {
      hopHeaders = withoutCrossOriginHeaders(hopHeaders);
    }
    current = next;
    href = next.href;
  }
}
