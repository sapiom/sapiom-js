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
 * The compact JWEs in a raw body: maximal runs of five non-empty base64url
 * segments whose first decodes to a JWE header naming `alg` and `enc`, so a
 * five-label hostname or a version string is never taken for a ciphertext.
 */
export function compactJweTokens(body: string): string[] {
  return (body.match(/%[0-9a-fA-F]{2}|[A-Za-z0-9_.-]+/g) ?? []).filter(
    isCompactJwe,
  );
}

function isCompactJwe(token: string): boolean {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}$/.test(token)) return false;
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

/**
 * An inspection copy of a body: backslash, JSON `\uXXXX` and percent escapes
 * undone until stable, so nested or escaped field names and ciphertexts show.
 * Only for matching; the body that is relayed is never rewritten.
 */
function inspectionText(body: string): string {
  let text = body;
  for (let pass = 0; pass < 8; pass++) {
    const next = text
      .replace(/\\\\/g, "\\")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    if (next === text) break;
    text = next;
  }
  return text;
}

const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The sha256 of each compact JWE in the raw body (`raw`), and of each one an
 * escape or encoding hides from a raw scan (`hidden`), even when another copy
 * of it is raw. A hidden copy can't be swapped byte for byte, so callers
 * refuse it.
 */
export function bodyJweHashes(body: string): {
  raw: Set<string>;
  hidden: Set<string>;
} {
  const tokens = new Set(compactJweTokens(body));
  // Inspect what is left once every raw copy is gone, so a raw copy can never
  // stand in for an escaped one.
  let rest = body;
  for (const token of tokens) rest = rest.split(token).join(" ");
  return {
    raw: new Set([...tokens].map(sha256Hex)),
    hidden: new Set(compactJweTokens(inspectionText(rest)).map(sha256Hex)),
  };
}

/** A known placeholder ciphertext, or a secured-field name in any body format. */
export function adyenPayCandidate(
  body: string,
  observedHashes: Iterable<string>,
): boolean {
  if (/encryptedcardnumber/i.test(inspectionText(body))) return true;
  const seen = new Set(observedHashes);
  const { raw, hidden } = bodyJweHashes(body);
  return [...raw, ...hidden].some((hash) => seen.has(hash));
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
