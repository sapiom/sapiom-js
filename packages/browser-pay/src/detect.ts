/**
 * Whether a paused request body holds the one placeholder this interceptor
 * was given.
 *
 * Luhn gate first: the held number has to be 13–19 digits and pass Luhn, or
 * nothing matches. Then the exact digit sequence, anywhere in the raw body.
 * Digits may be grouped by spaces or dashes, including the URL-encoded and
 * JSON-escaped forms of those separators. Expiry and CVC are not compared.
 * A different Luhn-valid number does not match.
 */

/** A placeholder as the API hands it to the agent. */
export interface HeldPlaceholder {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  injectionRef: string;
}

export type BodyPlaceholderMatch =
  | { kind: "match"; injectionRef: string }
  | { kind: "not_held" };

/** Separators the card field may insert between digits, raw or encoded. */
const SEPARATOR = "(?:[ \\t-]|\\+|%20|%2[Dd]|\\\\u0020|\\\\u002[Dd])?";

export function luhnCheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let digit = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Digits of a held number that pass Luhn. Null when the gate is closed. */
export function luhnHeldPan(number: string): string | null {
  const digits = number.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return null;
  return luhnCheckDigit(digits.slice(0, -1)) === digits.slice(-1)
    ? digits
    : null;
}

function placeholderPattern(pan: string): RegExp {
  return new RegExp(pan.split("").join(SEPARATOR));
}

function decodeForSearch(text: string): string {
  const withUnicode = text.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const plus = withUnicode.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/**
 * True when `text` contains the held PAN. The PAN must already have passed
 * the Luhn gate. Grouped, percent-encoded, and JSON-escaped forms count.
 */
export function textHoldsPlaceholderNumber(
  text: string,
  number: string,
): boolean {
  const pan = luhnHeldPan(number);
  if (!pan || text.length === 0) return false;
  const pattern = placeholderPattern(pan);
  if (pattern.test(text)) return true;
  const decoded = decodeForSearch(text);
  if (decoded === text) return false;
  pattern.lastIndex = 0;
  return pattern.test(decoded);
}

/**
 * A Luhn-valid card number in `text` that is not the held placeholder.
 * Used to refuse a relay response that still carries a real PAN.
 */
export function textContainsForeignCard(
  text: string,
  placeholderNumber: string,
): boolean {
  const held = luhnHeldPan(placeholderNumber);
  if (!held) return false;
  const decoded = decodeForSearch(text);
  const runs = decoded.match(/\d(?:[\s+-]*\d)+/g) ?? [];
  for (const run of runs) {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13) continue;
    const last = Math.min(19, digits.length);
    for (let length = 13; length <= last; length++) {
      for (let index = 0; index + length <= digits.length; index++) {
        const candidate = digits.slice(index, index + length);
        if (candidate === held || held.includes(candidate)) continue;
        if (luhnHeldPan(candidate)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether `body` contains the single held placeholder.
 * `not_held` covers a foreign card, a Luhn failure, and an empty body.
 */
export function matchHeldPlaceholderInBody(
  body: string,
  held: HeldPlaceholder,
): BodyPlaceholderMatch {
  if (!textHoldsPlaceholderNumber(body, held.number)) {
    return { kind: "not_held" };
  }
  return { kind: "match", injectionRef: held.injectionRef };
}
