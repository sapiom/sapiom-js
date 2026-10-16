/**
 * Where the tenant credential may travel: over https, or plain http to a
 * loopback host. Redirects are followed here rather than by `fetch`, because
 * `fetch` drops `authorization` on an origin change but keeps custom headers
 * such as `x-sapiom-api-key`.
 *
 * Every SDK client puts the key on a request through {@link credentialFetch},
 * never by setting the header itself; `pnpm credential-header:check` enforces
 * it in CI. The check reads literals only: a header name held in a variable,
 * or the key sent as `Authorization: Bearer`, is for review to catch.
 */
import { createHash } from "node:crypto";

export const ALLOW_INSECURE_HTTP_ENV = "SAPIOM_ALLOW_INSECURE_HTTP";

export interface CredentialPolicy {
  /** Plain http to a non-loopback host is allowed (trusted private network). */
  readonly allowInsecureHttp: boolean;
  /** Prefix of every error message: the package the caller uses. */
  readonly label: string;
  /** The client's own opt-in, named in a refusal next to the env var. */
  readonly optIn?: string;
}

/** Explicit config wins, then `SAPIOM_ALLOW_INSECURE_HTTP=1` (or `true`). */
export function resolveCredentialPolicy(
  explicit: boolean | undefined,
  wording: { label: string; optIn?: string },
): CredentialPolicy {
  const env = process.env[ALLOW_INSECURE_HTTP_ENV]?.trim().toLowerCase();
  return {
    allowInsecureHttp: explicit ?? (env === "1" || env === "true"),
    ...wording,
  };
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
 * A refused channel. A TypeError like the ones `fetch` throws, so existing
 * catches still apply, but one a retry loop can tell apart from a failed
 * connection: retrying it cannot succeed.
 */
export class CredentialChannelError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CredentialChannelError";
  }
}

/** The non-throwing form of {@link assertCredentialMayTravel}. */
export function mayCarryCredential(
  url: URL,
  policy: CredentialPolicy,
): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (policy.allowInsecureHttp || isLoopbackHostname(url.hostname))
  );
}

/**
 * Throws a {@link CredentialChannelError}, before anything is sent, when `url`
 * is not a channel the credential may use. It has no `cause`, unlike a failed
 * connection. Only the origin is echoed: a path or query can carry a secret.
 */
export function assertCredentialMayTravel(
  url: URL,
  policy: CredentialPolicy,
  redirectedFrom?: URL,
): void {
  if (mayCarryCredential(url, policy)) return;
  const from = redirectedFrom
    ? ` (redirected from ${redirectedFrom.origin})`
    : "";
  if (url.protocol !== "http:") {
    throw new CredentialChannelError(
      `${policy.label}: cannot request '${url.protocol}' URLs, expected http or https${from}`,
    );
  }
  const optIn = policy.optIn ? `${policy.optIn} or ` : "";
  throw new CredentialChannelError(
    `${policy.label}: refusing plaintext HTTP to ${url.origin}${from}. The tenant API key only ` +
      `travels over https or to a loopback host (localhost, *.localhost, 127.0.0.1, [::1]). ` +
      `For a trusted private network, opt in with ${optIn}${ALLOW_INSECURE_HTTP_ENV}=1.`,
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

/** Weakest first. */
const SRI_ALGORITHMS = ["sha256", "sha384", "sha512"];

/** base64url and a missing `=` pad compare equal, as in Node's `fetch`. */
const normalizeDigest = (digest: string): string =>
  digest.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");

/**
 * Subresource Integrity, as `fetch` applies `integrity`: unknown algorithms and
 * `?options` are ignored (nothing left means a match), and only the strongest
 * algorithm listed counts, any one of its digests matching.
 */
export function matchesIntegrity(bytes: Uint8Array, metadata: string): boolean {
  const expected = metadata
    .split(/\s+/)
    .map((token) => /^(sha256|sha384|sha512)-([^?]*)/i.exec(token))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, algorithm, digest]) => ({
      algorithm: algorithm.toLowerCase(),
      digest: normalizeDigest(digest),
    }));
  if (expected.length === 0) return true;
  const strongest =
    SRI_ALGORITHMS[
      Math.max(...expected.map((e) => SRI_ALGORITHMS.indexOf(e.algorithm)))
    ];
  const actual = normalizeDigest(
    createHash(strongest).update(bytes).digest("base64"),
  );
  return expected.some((e) => e.algorithm === strongest && e.digest === actual);
}

/** Reads the body through a clone, so the caller still gets the whole response. */
async function assertIntegrity(
  response: Response,
  metadata: string,
  url: URL,
  policy: CredentialPolicy,
): Promise<void> {
  if (
    response.body !== null &&
    matchesIntegrity(
      new Uint8Array(await response.clone().arrayBuffer()),
      metadata,
    )
  ) {
    return;
  }
  await response.body?.cancel().catch(() => undefined);
  throw new TypeError(
    `${policy.label}: the response from ${url.origin} does not match the request's integrity metadata`,
  );
}

/**
 * Each hop is its own fetch, so none can report what `follow` would: set it on
 * the final response and on every clone of it. An injected fetch may answer a
 * bare `{ ok, status }` with no `clone`.
 */
function markRedirected(response: Response): Response {
  if (typeof response.clone !== "function") {
    return Object.defineProperty(response, "redirected", { value: true });
  }
  const clone = response.clone.bind(response);
  return Object.defineProperties(response, {
    redirected: { value: true },
    clone: { value: () => markRedirected(clone()) },
  });
}

/**
 * `fetch` with its `redirect: "follow"` behavior (the Fetch spec's HTTP-redirect
 * steps), plus the channel check on every hop and the credential dropped on an
 * origin change. What `fetch` applies to the request as a whole still does: a
 * `same-origin` mode refuses a redirect to another origin, and `integrity` is
 * checked on the final response only. A caller asking for `manual` or `error`
 * gets plain `fetch`.
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
  const { integrity, ...hopInit } = init;
  const start = new URL(url);
  let href = url;
  let current = start;
  let method = init.method;
  let body = init.body;
  let hopHeaders = headers;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(href, {
      ...hopInit,
      method,
      body,
      headers: hopHeaders,
      redirect: "manual",
    });
    // A response without `headers` (a minimal injected fetch) cannot be followed.
    const location = REDIRECT_STATUSES.has(response.status)
      ? ((response.headers as Headers | undefined)?.get?.("location") ?? null)
      : null;
    if (location === null) {
      if (integrity)
        await assertIntegrity(response, integrity, current, policy);
      return redirects > 0 ? markRedirected(response) : response;
    }
    // Never handed to the caller: free the connection, even if we refuse the hop.
    await response.body?.cancel().catch(() => undefined);

    const next = new URL(location, current);
    assertCredentialMayTravel(next, policy, current);
    if (redirects === MAX_REDIRECTS) {
      throw new TypeError(
        `${policy.label}: more than ${MAX_REDIRECTS} redirects from ${start.origin}`,
      );
    }
    if (init.mode === "same-origin" && next.origin !== start.origin) {
      throw new TypeError(
        `${policy.label}: a "same-origin" request to ${start.origin} was redirected to ${next.origin}`,
      );
    }
    if (response.status !== 303 && isStreamBody(body)) {
      throw new TypeError(
        `${policy.label}: cannot resend a streamed request body after a ${response.status} from ${current.origin}`,
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

/** The tenant key and the header it rides on. */
export interface Credential {
  readonly header: "x-api-key" | "x-sapiom-api-key";
  readonly value: string;
}

/**
 * The one way an SDK client sends the tenant key: checks the channel, sets the
 * header after `init.headers` (which can neither override nor forge it), and
 * follows redirects through {@link fetchKeepingCredential}. Without a
 * credential, nothing is checked on the first URL; redirect hops still are.
 */
export async function credentialFetch(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  credential: Credential | undefined,
  policy: CredentialPolicy,
): Promise<Response> {
  // Merged as a plain object: callers pass records.
  const callerHeaders = (init.headers ?? {}) as Record<string, string>;
  if (!credential) {
    return fetchKeepingCredential(fetchImpl, url, init, callerHeaders, policy);
  }
  assertCredentialMayTravel(new URL(url), policy);
  const headers = pick(callerHeaders, (name) => name !== credential.header);
  headers[credential.header] = credential.value;
  return fetchKeepingCredential(fetchImpl, url, init, headers, policy);
}
