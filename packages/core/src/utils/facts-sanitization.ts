/**
 * Header and URL sanitization for the request and response facts the SDK
 * reports with a transaction.
 *
 * Facts describe a call (method, host, path, status, content type). They
 * should never carry the credentials the call was made with. The HTTP
 * integrations (`@sapiom/fetch`, `@sapiom/axios`, `@sapiom/node-http`) share
 * this one list, so they leave out the same headers and mask the same URL
 * parts. The Sapiom API masks the same names again when it stores facts.
 */

/** The value a masked URL query parameter or userinfo is replaced with. */
export const REDACTED_FACT_VALUE = "[REDACTED]";

/** Header names that always carry a credential. */
const SENSITIVE_HEADER_EXACT = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "payment-signature",
  "x-payment",
  "x-payment-response",
  "sapiom-identity",
]);

/** A name that names a credential: `x-api-key`, `bt-api-key`, `client_secret`, … */
const CREDENTIAL_NAME =
  /api[-_]?key|apikey|token|secret|password|passwd|credential|signature|private[-_]?key/i;

/** Header names only: anything with `auth` in it, and any `*-key` / `*_key`. */
const SENSITIVE_HEADER_EXTRA = /auth|(?:^|[-_])key$/i;

/** Every `bt-*` header, and `x-sapiom-*` headers that carry a key, token or signature. */
const SENSITIVE_HEADER_PREFIX =
  /^bt-|^x-sapiom-.*(?:key|token|secret|signature|auth)/i;

/** Query parameters whose value is a credential (matched case-insensitively). */
const SENSITIVE_QUERY_EXACT = new Set(["key", "sig", "auth", "pwd", "pass"]);

// Greedy up to the last `@` before the path, query or fragment: a password may itself contain `@`.
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]*)@/i;

/**
 * Whether a header must be left out of facts: `Authorization`, cookies,
 * API-key, token, secret and password headers (`x-api-key`, `bt-api-key`,
 * `api-key`, `x-auth-token`, …), payment signatures, the `Sapiom-Identity`
 * token, and `x-sapiom-*` credential headers. Case-insensitive.
 */
export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    SENSITIVE_HEADER_EXACT.has(lower) ||
    CREDENTIAL_NAME.test(lower) ||
    SENSITIVE_HEADER_EXTRA.test(lower) ||
    SENSITIVE_HEADER_PREFIX.test(lower)
  );
}

/**
 * Whether a URL query parameter carries a credential: `key`, `api_key`,
 * `apikey`, `token`, `access_token`, `secret`, `signature`, `sig`,
 * `password`, `X-Amz-Signature`, … Case-insensitive, on the decoded name.
 */
export function isSensitiveQueryParam(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    // A malformed escape: match on the raw name.
  }
  const lower = decoded.trim().toLowerCase();
  return (
    SENSITIVE_QUERY_EXACT.has(lower) ||
    CREDENTIAL_NAME.test(lower) ||
    /(?:^|[-_])sig$/.test(lower)
  );
}

/**
 * The headers to report in facts: every header except the sensitive ones,
 * values as strings (`String(value)`). Accepts a `Headers`-style entries
 * iterable or a plain record. An `undefined` or `null` value is skipped.
 *
 * @param exclude An extra test for headers to leave out, on top of
 *   {@link isSensitiveHeaderName}.
 */
export function sanitizeHeadersForFacts(
  headers:
    | Iterable<[string, unknown]>
    | Record<string, unknown>
    | null
    | undefined,
  exclude?: (lowerName: string) => boolean,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!headers) return sanitized;
  const entries: Iterable<[string, unknown]> =
    Symbol.iterator in Object(headers) &&
    typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function"
      ? (headers as Iterable<[string, unknown]>)
      : Object.entries(headers as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (isSensitiveHeaderName(key)) continue;
    if (exclude?.(key.toLowerCase())) continue;
    sanitized[key] = String(value);
  }
  return sanitized;
}

/**
 * `url` with credential query-parameter values and `user:pass@` userinfo
 * replaced by `[REDACTED]`. Works on an absolute or relative URL or a bare
 * query string (`?a=1`, as in `URL.search`); everything else is kept exactly
 * as it was.
 */
export function sanitizeUrlForFacts(url: string): string {
  const withoutUserinfo = url.replace(
    USERINFO,
    (_match, scheme: string) => `${scheme}${REDACTED_FACT_VALUE}@`,
  );
  const queryStart = withoutUserinfo.indexOf("?");
  if (queryStart === -1) return withoutUserinfo;
  const hashStart = withoutUserinfo.indexOf("#", queryStart);
  const queryEnd = hashStart === -1 ? withoutUserinfo.length : hashStart;
  const query = withoutUserinfo
    .slice(queryStart + 1, queryEnd)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1 || eq === pair.length - 1) return pair;
      return isSensitiveQueryParam(pair.slice(0, eq))
        ? `${pair.slice(0, eq + 1)}${REDACTED_FACT_VALUE}`
        : pair;
    })
    .join("&");
  return `${withoutUserinfo.slice(0, queryStart + 1)}${query}${withoutUserinfo.slice(queryEnd)}`;
}
