import { createHash } from "node:crypto";

import { ADYEN_RESULT_CODES, type AdyenResultCode } from "./contract.js";
import { isRecord } from "./guards.js";

export interface HeldPlaceholder {
  number: string;
  injectionRef: string;
}

function placeholderDigits(number: string): string | undefined {
  const digits = number.replace(/[\s-]/g, "");
  if (digits.length === 0 || !/^\d+$/.test(digits)) return undefined;
  return digits;
}

function isSeparatorChar(char: string): boolean {
  return char === " " || char === "\t" || char === "-" || char === "+";
}

function readDecoded(
  text: string,
  index: number,
): { char: string; next: number } {
  if (index >= text.length) return { char: "", next: index };
  if (text.startsWith("\\u", index)) {
    const hex = text.slice(index + 2, index + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return {
        char: String.fromCharCode(Number.parseInt(hex, 16)),
        next: index + 6,
      };
    }
  }
  if (text[index] === "+") return { char: " ", next: index + 1 };
  if (text[index] === "%" && index + 2 < text.length) {
    const encoded = text.slice(index, index + 3);
    if (/^%[0-9a-fA-F]{2}$/.test(encoded)) {
      try {
        const char = decodeURIComponent(encoded);
        if (char.length === 1) return { char, next: index + 3 };
      } catch {
        // keep the literal percent
      }
    }
  }
  return { char: text[index] ?? "", next: index + 1 };
}

function heldSpanEnd(
  text: string,
  digits: string,
  start: number,
): number | undefined {
  const first = readDecoded(text, start);
  if (first.char !== digits[0]) return undefined;
  let index = first.next;
  for (let digit = 1; digit < digits.length; digit++) {
    let cursor = index;
    while (cursor < text.length) {
      const separator = readDecoded(text, cursor);
      if (!isSeparatorChar(separator.char) || separator.next === cursor) break;
      cursor = separator.next;
    }
    if (cursor !== index) {
      const after = readDecoded(text, cursor);
      if (after.char === digits[digit]) {
        index = after.next;
        continue;
      }
    }
    const raw = readDecoded(text, index);
    if (raw.char !== digits[digit]) return undefined;
    index = raw.next;
  }
  return index;
}

function holdsDigits(text: string, digits: string): boolean {
  for (let start = 0; start < text.length; start++) {
    if (heldSpanEnd(text, digits, start) !== undefined) return true;
  }
  return false;
}

export function textHoldsPlaceholderNumber(
  text: string,
  number: string,
): boolean {
  if (number.length === 0 || text.length === 0) return false;
  if (text.includes(number)) return true;
  const digits = placeholderDigits(number);
  if (!digits) return false;
  return holdsDigits(text, digits);
}

function maskHeldSpans(text: string, digits: string): string {
  let out = "";
  let cursor = 0;
  for (let start = 0; start < text.length; ) {
    const end = heldSpanEnd(text, digits, start);
    if (end === undefined) {
      start += 1;
      continue;
    }
    out += text.slice(cursor, start);
    out += "••••";
    cursor = end;
    start = end;
  }
  return out + text.slice(cursor);
}

export function redactHeld(value: string, number: string): string {
  if (number.length === 0 || value.length === 0) return value;
  const digits = placeholderDigits(number);
  if (!digits) return value.split(number).join("••••");
  return maskHeldSpans(value, digits);
}

const ADYEN_CLIENT_KEY = /^(test|live)_[A-Za-z0-9]{1,64}$/;
const ADYEN_KEY_HOST_ENV = new Map([
  ["checkoutshopper-test.adyen.com", "test"],
  ...["live", "live-us", "live-au", "live-apse", "live-in"].map(
    (region) => [`checkoutshopper-${region}.adyen.com`, "live"] as const,
  ),
]);

/** Origins of Adyen's checkoutshopper hosts, which serve the secured-field iframes. */
export const ADYEN_CHECKOUT_ORIGINS = [...ADYEN_KEY_HOST_ENV.keys()].map(
  (host) => `https://${host}`,
);

export function isAdyenCheckoutUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ADYEN_KEY_HOST_ENV.has(parsed.host);
  } catch {
    return false;
  }
}

/** An Adyen client key: `test_` or `live_` and up to 64 letters and digits. */
function isAdyenClientKey(value: unknown): value is string {
  return typeof value === "string" && ADYEN_CLIENT_KEY.test(value);
}

/**
 * The client keys a request to Adyen's own checkoutshopper host names: its
 * `clientKey` query, a `/securedfields/{key}/` or `/clientKeys/{key}` path,
 * or its `x-client-key` header. Only https to exactly
 * `checkoutshopper-test.adyen.com` or a live host
 * (`checkoutshopper-live[-us|-au|-apse|-in].adyen.com`) counts: `test_`
 * keys only from the test host, `live_` keys only from a live one.
 */
export function adyenClientKeysInRequest(
  url: string,
  clientKeyHeader = "",
): string[] {
  if (!isAdyenCheckoutUrl(url)) return [];
  const parsed = new URL(url);
  const env = ADYEN_KEY_HOST_ENV.get(parsed.host);
  const candidates = [
    ...parsed.searchParams.getAll("clientKey"),
    /\/securedfields\/([^/]+)\//.exec(parsed.pathname)?.[1],
    /\/clientKeys\/([^/]+)/.exec(parsed.pathname)?.[1],
    clientKeyHeader,
  ];
  return candidates.filter(
    (key): key is string => isAdyenClientKey(key) && key.startsWith(`${env}_`),
  );
}

/**
 * A raw body as runs of base64url-and-dot characters, with each percent or
 * JSON escape a token of its own, so an escape's letters never join a run. A
 * percent escape of a percent escape (`%2522`) is one token.
 */
const BODY_TOKENS =
  /%(?:25)*[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]|[A-Za-z0-9_.-]+/g;

/**
 * The compact JWEs in a body: runs of five base64url segments whose first
 * decodes to a JWE header naming `alg` and `enc`, so a five-label hostname or
 * a version string is never taken for a ciphertext. The other segments may be
 * empty, as a direct-encryption key is.
 */
export function compactJweTokens(body: string): string[] {
  return (body.match(BODY_TOKENS) ?? []).filter(isCompactJwe);
}

function isCompactJwe(token: string): boolean {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){4}$/.test(token)) return false;
  const encoded = token.slice(0, token.indexOf("."));
  try {
    const header: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    return (
      typeof header === "object" &&
      header !== null &&
      typeof (header as { alg?: unknown }).alg === "string" &&
      typeof (header as { enc?: unknown }).enc === "string"
    );
  } catch {
    return false;
  }
}

const JSON_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const INSPECTION_PASSES = 32;

/**
 * An inspection copy of a body: JSON and percent escapes undone, layer by
 * layer, so nested or escaped field names and ciphertexts show. `settled` is
 * false when layers remain after the last pass. Only for matching; the body
 * that is relayed is never rewritten.
 */
function inspectionText(body: string): { text: string; settled: boolean } {
  let text = body;
  for (let pass = 0; pass < INSPECTION_PASSES; pass++) {
    const next = text.replace(
      /\\u([0-9a-fA-F]{4})|\\(["\\/bfnrt])|%([0-9a-fA-F]{2})/g,
      (_, unicode?: string, escaped?: string, percent?: string) =>
        escaped !== undefined
          ? (JSON_ESCAPES[escaped] ?? escaped)
          : String.fromCharCode(Number.parseInt(unicode ?? percent ?? "", 16)),
    );
    if (next === text) return { text, settled: true };
    text = next;
  }
  return { text, settled: false };
}

const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((token, i) => token === right[i]);
}

interface BodyScan {
  /** The sha256 of each compact JWE in the raw body. */
  raw: Set<string>;
  /** The sha256 of each ciphertext the unescaped body shows. */
  unescaped: Set<string>;
  /** Whether a relay can swap every ciphertext in place, byte for byte. */
  swappable: boolean;
  /** The unescaped body, for matching field names. */
  text: string;
  settled: boolean;
}

function scanBody(body: string): BodyScan {
  const raw = compactJweTokens(body);
  const inspected = inspectionText(body);
  const decoded = compactJweTokens(inspected.text);
  // Unescape what is left once every raw ciphertext is gone, so a raw copy can
  // never stand in for an escaped one.
  const rest = inspectionText(
    body.replace(BODY_TOKENS, (token) => (isCompactJwe(token) ? " " : token)),
  );
  const revealed = compactJweTokens(rest.text);
  return {
    raw: new Set(raw.map(sha256Hex)),
    unescaped: new Set([...decoded, ...revealed].map(sha256Hex)),
    // Unescaping must leave each raw ciphertext whole and reveal no other.
    swappable:
      inspected.settled &&
      rest.settled &&
      revealed.length === 0 &&
      sameTokens(decoded, raw),
    text: inspected.text,
    settled: inspected.settled && rest.settled,
  };
}

/**
 * The sha256 of each compact JWE in the raw body, and whether every one can
 * be swapped byte for byte: no escape hides a ciphertext or changes where one
 * ends. A body that isn't swappable is refused.
 */
export function bodyJweHashes(body: string): {
  raw: Set<string>;
  swappable: boolean;
} {
  const { raw, swappable } = scanBody(body);
  return { raw, swappable };
}

const SECURED_FIELD_KEY =
  "[\\w$.\\[\\]-]*encrypted(?:cardnumber|expirymonth|expiryyear|securitycode)\\]?";
/**
 * A secured field given a value (even empty), by its key: a JSON member, which
 * starts a line (after spaces on that line only, so blank lines are never
 * rescanned), opens an object or follows a comma
 * (`{"paymentMethod[encryptedCardNumber]":`, `+` for a space too), a form
 * field (`encryptedCardNumber=`, or a bare `encryptedCardNumber&`) or a
 * multipart part, whose header starts a line (`Content-Disposition: …;
 * name="encryptedCardNumber"`). The name inside a string value, as in a
 * validation message, is not a key.
 */
const SECURED_FIELD = new RegExp(
  [
    `(?:^[ \\t+]*|[{,][\\s+]*)["']${SECURED_FIELD_KEY}["'][\\s+]*:`,
    `(?:^|[&?])${SECURED_FIELD_KEY}(?:=|&|$)`,
    `^content-disposition:[^\\r\\n]*;[ \\t]*name=["']?${SECURED_FIELD_KEY}["']?(?=[;\\s]|$)`,
  ].join("|"),
  "im",
);

/**
 * Whether a body is an Adyen secured-fields Pay, in any format: it carries a
 * ciphertext the page's Adyen fields produced, or gives a secured field a
 * value. A name only mentioned, as in a validation message, doesn't count. A
 * body too deeply encoded to read counts, so it is refused, not sent on.
 */
export function adyenPayCandidate(
  body: string,
  observedHashes: Iterable<string>,
): boolean {
  const scan = scanBody(body);
  if (!scan.settled) return true;
  const seen = new Set(observedHashes);
  if ([...scan.raw, ...scan.unescaped].some((hash) => seen.has(hash))) {
    return true;
  }
  return SECURED_FIELD.test(scan.text);
}

/**
 * The checkout an Adyen payment or details call belongs to: its origin, and
 * for Adyen's `/sessions/{id}/...` the session too, since every merchant's
 * sessions share Adyen's host. A merchant's own `/sessions/{id}/` route is
 * only its origin, like the `/payments/details` call that follows it.
 */
export function adyenCheckout(url: URL): string {
  const session = isAdyenCheckoutUrl(url.href)
    ? /^(.*\/sessions\/[^/]+)\/(?:payments|paymentDetails)$/.exec(url.pathname)
    : null;
  return session ? `${url.origin}${session[1]}` : url.origin;
}

/**
 * A POST that submits 3-D Secure details, and the checkout it belongs to.
 * `relay` is Adyen's own `/sessions/{id}/paymentDetails`, called from the
 * browser, so the relay can send it and read the final answer; a merchant's
 * `/payments/details` is sent on by its server, out of the relay's sight.
 */
export function adyenDetailsCall(
  method: string,
  url: string,
): { checkout: string; relay: boolean } | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const sessions = /\/sessions\/[^/]+\/paymentDetails$/.test(parsed.pathname);
  if (!sessions && !/\/payments\/details$/.test(parsed.pathname)) {
    return undefined;
  }
  return {
    checkout: adyenCheckout(parsed),
    relay: sessions && isAdyenCheckoutUrl(parsed.href),
  };
}

const PSP_REFERENCE_SHAPE = /^[A-Za-z0-9]{1,64}$/;

/**
 * The top-level `resultCode` (and `pspReference`) of the answer to an Adyen
 * payment, from the merchant's `/payments` or Adyen's
 * `/sessions/{id}/payments`. Anything unreadable is `unknown`.
 */
export function adyenPaymentResult(body: string): {
  resultCode: AdyenResultCode;
  pspReference?: string;
} {
  const parsed = parseJson(body);
  if (!isRecord(parsed)) return { resultCode: "unknown" };
  const code = parsed.resultCode;
  const resultCode =
    ADYEN_RESULT_CODES.find((known) => known === code) ?? "unknown";
  const psp = parsed.pspReference;
  return typeof psp === "string" && PSP_REFERENCE_SHAPE.test(psp)
    ? { resultCode, pspReference: psp }
    : { resultCode };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
