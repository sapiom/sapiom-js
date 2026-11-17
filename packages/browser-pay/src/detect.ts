import type { AdyenEncryptedFields } from "./contract.js";
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

const ADYEN_CLIENT_KEY = /^(test|live)_[A-Z0-9]+$/;
const ADYEN_SECURED_FIELDS_PATH =
  /\/securedfields\/([^/]+)\/[^/]+\/securedFields\.html$/;

/** An Adyen client key: `test_` or `live_` and upper-case letters and digits. */
export function isAdyenClientKey(value: unknown): value is string {
  return typeof value === "string" && ADYEN_CLIENT_KEY.test(value);
}

/**
 * The client key in an Adyen secured-field iframe URL
 * (`https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/{clientKey}/{version}/securedFields.html`),
 * or `undefined` for any other URL.
 */
export function adyenClientKeyFromFrameUrl(url: string): string | undefined {
  const parsed = adyenSecuredFieldsUrl(url);
  if (!parsed) return undefined;
  const match = ADYEN_SECURED_FIELDS_PATH.exec(parsed.pathname);
  const key = match ? safeDecode(match[1]) : undefined;
  return isAdyenClientKey(key) ? key : undefined;
}

/**
 * True for an Adyen secured-field iframe URL (https, an `adyen.com` host, a
 * `/securedfields/` path), whether or not its client key can be read.
 */
export function isAdyenSecuredFieldsFrameUrl(url: string): boolean {
  return adyenSecuredFieldsUrl(url) !== undefined;
}

function adyenSecuredFieldsUrl(url: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") return undefined;
  if (host !== "adyen.com" && !host.endsWith(".adyen.com")) return undefined;
  return parsed.pathname.includes("/securedfields/") ? parsed : undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Evaluated in the checkout page when no secured-field iframe was seen as a
 * target: the key in a secured-field iframe `src` in the DOM, then adyen-web
 * config the page renders (`#clientKey`, `data-client-key`, or a
 * `clientKey: "test_…"` literal in an inline script). Returns a string or
 * `null`; the caller validates it.
 */
export const ADYEN_DOM_CLIENT_KEY_EXPRESSION = `(() => {
  const shape = ${ADYEN_CLIENT_KEY.toString()};
  const ok = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return shape.test(text) ? text : null;
  };
  for (const frame of document.querySelectorAll("iframe[src*='securedfields']")) {
    const match = ${ADYEN_SECURED_FIELDS_PATH.toString()}.exec(new URL(frame.src, location.href).pathname);
    const key = match && ok(decodeURIComponent(match[1]));
    if (key) return key;
  }
  const element = document.getElementById("clientKey");
  const fromElement = element && ok(element.value || element.textContent);
  if (fromElement) return fromElement;
  for (const node of document.querySelectorAll("[data-client-key],[data-clientkey]")) {
    const key = ok(node.getAttribute("data-client-key") || node.getAttribute("data-clientkey"));
    if (key) return key;
  }
  for (const script of document.querySelectorAll("script:not([src])")) {
    const match = /clientKey["']?\\s*[:=]\\s*["']((?:test|live)_[A-Z0-9]+)["']/.exec(script.textContent || "");
    if (match) return match[1];
  }
  return null;
})()`;

/**
 * True when the body is JSON whose top-level `paymentMethod.encryptedCardNumber`
 * is a non-empty string: an Adyen secured-fields payment, on the merchant's
 * own `/payments` call or on Adyen's `/sessions/{id}/payments`.
 */
export function isAdyenSecuredFieldsPayment(body: string): boolean {
  return adyenPaymentMethod(parseJson(body)) !== undefined;
}

/**
 * The body with the four `paymentMethod.encrypted*` fields replaced. Every
 * other key keeps its value and order.
 */
export function withAdyenEncryptedFields(
  body: string,
  fields: AdyenEncryptedFields,
): string {
  const parsed = parseJson(body);
  const method = adyenPaymentMethod(parsed);
  if (!method || !isRecord(parsed)) {
    throw new Error("Not an Adyen secured-fields payment body");
  }
  return JSON.stringify({
    ...parsed,
    paymentMethod: { ...method, ...fields },
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function adyenPaymentMethod(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.paymentMethod)) return undefined;
  const method = value.paymentMethod;
  return typeof method.encryptedCardNumber === "string" &&
    method.encryptedCardNumber.length > 0
    ? method
    : undefined;
}
