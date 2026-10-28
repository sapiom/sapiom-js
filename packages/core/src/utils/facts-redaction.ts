/**
 * One redaction rule for the transaction facts every HTTP wrapper records, so the
 * wrappers cannot drift apart on what reaches the Sapiom API.
 */

const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-sapiom-api-key",
  "x-auth-token",
  "sapiom-identity",
  "x-payment",
  "payment-signature",
]);

const DROPPED_SUBSTRINGS = [
  "auth",
  "key",
  "token",
  "cookie",
  "secret",
  "password",
  "session",
  "signature",
];

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DROPPED_HEADERS.has(lower) ||
    DROPPED_SUBSTRINGS.some((part) => lower.includes(part))
  );
}

/** Transaction facts leave the caller's process, so credential headers stay out. */
export function sanitizeFactHeaders(
  headers: Headers | Record<string, unknown> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers);
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (!isSensitiveHeader(name)) out[name] = String(value);
  }
  return out;
}

/** Placeholder origin for resolving a relative URL; never part of the result. */
const RELATIVE_BASE = "http://relative.invalid";

/** Query values, userinfo and fragments can hold secrets that must not reach transaction facts. */
export function redactUrlForFacts(url: string): string {
  let parsed: URL;
  let relative = false;
  try {
    parsed = new URL(url);
  } catch {
    try {
      parsed = new URL(url, RELATIVE_BASE);
      relative = true;
    } catch {
      return url.split(/[?#]/, 1)[0] ?? "";
    }
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = redactSearch(parsed.search);
  return relative ? `${parsed.pathname}${parsed.search}` : parsed.toString();
}

export function redactSearch(search: string): string {
  if (!search || search === "?") return "";
  const keys = Array.from(new URLSearchParams(search).keys());
  return `?${keys.map((key) => `${encodeURIComponent(key)}=`).join("&")}`;
}
