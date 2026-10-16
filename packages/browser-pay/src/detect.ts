/**
 * Recognizing the one placeholder this interceptor was given, inside a paused
 * request body.
 *
 * This is a copy of the backend's placeholder-detection logic (card-number
 * candidate, Luhn, expiry/cvc comparison). sapiom-js cannot import that module.
 * It should move to a shared package. Do not drift the comparison rules.
 *
 * A typed number might be a real card. This function only decides whether the
 * body contains the placeholder already held; it never sends a number anywhere.
 */

/** A placeholder as the API hands it to the agent. */
export interface HeldPlaceholder {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  injectionRef: string;
}

/** Card fields found in a request body. Expiry and CVC only when present. */
export interface TypedCard {
  number: string;
  expMonth?: number;
  /** Two or four digits. */
  expYear?: number;
  cvc?: string;
}

export type HeldPlaceholderMatch =
  | { kind: "not_a_card_number" }
  | { kind: "not_held" }
  | { kind: "mismatch"; injectionRef: string; mismatch: "expiry" | "cvc" }
  | { kind: "match"; injectionRef: string };

export type BodyPlaceholderMatch = Exclude<
  HeldPlaceholderMatch,
  { kind: "not_a_card_number" }
>;

/**
 * A value as a card number worth comparing: separators removed, 13 to 19
 * digits, valid Luhn check digit. Null when it cannot be a card number.
 */
export function cardNumberCandidate(raw: string): string | null {
  const number = raw.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(number)) return null;
  return luhnCheckDigit(number.slice(0, -1)) === number.slice(-1)
    ? number
    : null;
}

/** Compares one typed card with the placeholders the caller holds. */
export function matchHeldPlaceholder(
  typed: TypedCard,
  held: readonly HeldPlaceholder[],
): HeldPlaceholderMatch {
  const number = cardNumberCandidate(typed.number);
  if (!number) return { kind: "not_a_card_number" };
  const placeholder = held.find((candidate) => candidate.number === number);
  if (!placeholder) return { kind: "not_held" };
  const { injectionRef } = placeholder;
  if (typed.expMonth !== undefined && typed.expMonth !== placeholder.expMonth) {
    return { kind: "mismatch", injectionRef, mismatch: "expiry" };
  }
  if (
    typed.expYear !== undefined &&
    typed.expYear % 100 !== placeholder.expYear % 100
  ) {
    return { kind: "mismatch", injectionRef, mismatch: "expiry" };
  }
  if (typed.cvc !== undefined && typed.cvc !== placeholder.cvc) {
    return { kind: "mismatch", injectionRef, mismatch: "cvc" };
  }
  return { kind: "match", injectionRef };
}

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

/**
 * Whether `text` contains the held number. Separators, `+`, `%20`, percent
 * escapes, and JSON `\u` escapes are removed first. One placeholder is held,
 * so a longer digit run that still contains that number counts.
 */
export function textHoldsPlaceholderNumber(
  text: string,
  number: string,
): boolean {
  if (!/^\d{13,19}$/.test(number) || text.length === 0) return false;
  return normalizeForHeldSearch(text).includes(number);
}

/**
 * A Luhn-valid card number in `text` that is not the held placeholder.
 * Used to refuse a relay response that still carries a real PAN.
 */
export function textContainsForeignCard(
  text: string,
  placeholderNumber: string,
): boolean {
  const decoded = decodeForHeldSearch(text);
  const runs = decoded.match(/\d(?:[\s+-]*\d)+/g) ?? [];
  for (const run of runs) {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13) continue;
    const last = Math.min(19, digits.length);
    for (let length = 13; length <= last; length++) {
      for (let index = 0; index + length <= digits.length; index++) {
        const candidate = digits.slice(index, index + length);
        if (
          candidate === placeholderNumber ||
          placeholderNumber.includes(candidate)
        ) {
          continue;
        }
        if (cardNumberCandidate(candidate)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether `body` contains the single held placeholder.
 * `not_held` means the placeholder number is not in the body (other card
 * numbers included). `mismatch` means the number is present but the expiry or
 * CVC beside it disagrees. `match` carries only the injection ref.
 *
 * The structured parse decides match versus mismatch. If that parse misses
 * the number because more digits follow it, the separator-stripped body is
 * searched for the held number and the request is still not `not_held`.
 */
export function matchHeldPlaceholderInBody(
  body: string,
  held: HeldPlaceholder,
): BodyPlaceholderMatch {
  const cards = extractTypedCards(body);
  let mismatch: Extract<BodyPlaceholderMatch, { kind: "mismatch" }> | null =
    null;
  for (const card of cards) {
    const result = matchHeldPlaceholder(card, [held]);
    if (result.kind === "match") {
      return { kind: "match", injectionRef: result.injectionRef };
    }
    if (result.kind === "mismatch" && !mismatch) mismatch = result;
  }
  if (mismatch) return mismatch;
  if (!textHoldsPlaceholderNumber(body, held.number)) {
    return { kind: "not_held" };
  }
  return classifyAdjacentHeld(body, held);
}

/** Card numbers in a body, with expiry and CVC taken from the same object or form group. */
export function extractTypedCards(body: string): TypedCard[] {
  const structured = extractStructured(body);
  const covered = new Set(
    structured.map((card) => cardNumberCandidate(card.number) ?? card.number),
  );
  const extras: TypedCard[] = [];
  for (const number of scanRawNumbers(body)) {
    if (!covered.has(number)) extras.push({ number });
  }
  return [...structured, ...extras];
}

function extractStructured(body: string): TypedCard[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const cards: TypedCard[] = [];
      walk(JSON.parse(trimmed), undefined, undefined, cards);
      return cards;
    } catch {
      // Not JSON. Fall through to form encoding when it looks like a form.
    }
  }
  if (trimmed.includes("=")) return extractForm(trimmed);
  return [];
}

function walk(
  value: unknown,
  container: Record<string, unknown> | undefined,
  parent: Record<string, unknown> | undefined,
  out: TypedCard[],
): void {
  if (typeof value === "string") {
    const whole = cardNumberCandidate(value);
    const numbers = whole ? [whole] : scanRawNumbers(value);
    for (const number of numbers) {
      out.push(cardFromContext(number, container, parent));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, undefined, undefined, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const child of Object.values(obj)) walk(child, obj, container, out);
  }
}

function cardFromContext(
  number: string,
  container: Record<string, unknown> | undefined,
  parent: Record<string, unknown> | undefined,
): TypedCard {
  const own = readCardFields(container);
  const inherited = readCardFields(parent);
  return {
    number,
    ...fill(inherited, own),
  };
}

function fill(
  fallback: Partial<TypedCard>,
  primary: Partial<TypedCard>,
): Partial<TypedCard> {
  return {
    ...(primary.expMonth !== undefined
      ? { expMonth: primary.expMonth }
      : fallback.expMonth !== undefined
        ? { expMonth: fallback.expMonth }
        : {}),
    ...(primary.expYear !== undefined
      ? { expYear: primary.expYear }
      : fallback.expYear !== undefined
        ? { expYear: fallback.expYear }
        : {}),
    ...(primary.cvc !== undefined
      ? { cvc: primary.cvc }
      : fallback.cvc !== undefined
        ? { cvc: fallback.cvc }
        : {}),
  };
}

function extractForm(body: string): TypedCard[] {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return [];
  }
  const groups = new Map<string, Record<string, string>>();
  for (const [key, value] of params) {
    const { prefix, field } = splitFormKey(key);
    const group = groups.get(prefix) ?? {};
    group[field] = value;
    groups.set(prefix, group);
  }
  const cards: TypedCard[] = [];
  for (const group of groups.values()) {
    for (const value of Object.values(group)) {
      const number = cardNumberCandidate(value);
      if (!number) continue;
      cards.push({ number, ...readCardFields(group) });
    }
  }
  return cards;
}

function splitFormKey(key: string): { prefix: string; field: string } {
  const bracket = key.match(/^(.*)\[([^\]]+)\]$/);
  if (bracket) return { prefix: bracket[1], field: bracket[2] };
  const dot = key.match(/^(.*)\.([^.]+)$/);
  if (dot) return { prefix: dot[1], field: dot[2] };
  return { prefix: "", field: key };
}

type FieldKind = "month" | "year" | "expiry" | "cvc" | "other";

function fieldKind(key: string): FieldKind {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    normalized.includes("startmonth") ||
    normalized.includes("startyear") ||
    normalized.includes("issuen")
  ) {
    return "other";
  }
  if (
    normalized.includes("cvc") ||
    normalized.includes("cvv") ||
    normalized.includes("csc") ||
    normalized.includes("securitycode") ||
    normalized.includes("verificationvalue") ||
    normalized.includes("cardverification")
  ) {
    return "cvc";
  }
  if (
    normalized.includes("expyear") ||
    normalized.includes("expirationyear") ||
    normalized.includes("expiryyear") ||
    normalized === "year" ||
    normalized.endsWith("year")
  ) {
    return "year";
  }
  if (
    normalized.includes("expmonth") ||
    normalized.includes("expirationmonth") ||
    normalized.includes("expirymonth") ||
    normalized === "month" ||
    normalized.endsWith("month")
  ) {
    return "month";
  }
  if (
    normalized === "exp" ||
    normalized === "expiry" ||
    normalized === "expiration" ||
    normalized.includes("expdate") ||
    normalized === "ccexp"
  ) {
    return "expiry";
  }
  return "other";
}

function readCardFields(
  obj: Record<string, unknown> | undefined,
): Partial<TypedCard> {
  if (!obj) return {};
  const fields: Partial<TypedCard> = {};
  for (const [key, value] of Object.entries(obj)) {
    const kind = fieldKind(key);
    if (kind === "month" && fields.expMonth === undefined) {
      const month = readPresentMonth(value);
      if (month !== undefined) fields.expMonth = month;
    } else if (kind === "year" && fields.expYear === undefined) {
      const year = readPresentYear(value);
      if (year !== undefined) fields.expYear = year;
    } else if (kind === "cvc" && fields.cvc === undefined) {
      const cvc = readPresentCvc(value);
      if (cvc !== undefined) fields.cvc = cvc;
    } else if (kind === "expiry" && fields.expMonth === undefined) {
      const expiry = readExpiry(value);
      if (expiry) {
        fields.expMonth = expiry.expMonth;
        if (fields.expYear === undefined) fields.expYear = expiry.expYear;
      } else if (value !== null && value !== undefined && value !== "") {
        fields.expMonth = Number.NaN;
      }
    }
  }
  return fields;
}

function readPresentMonth(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const month = readMonth(value);
  return month === undefined ? Number.NaN : month;
}

function readPresentYear(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const year = readYear(value);
  return year === undefined ? Number.NaN : year;
}

function readPresentCvc(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function readMonth(value: unknown): number | undefined {
  const raw =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^\d{1,2}$/.test(raw)) return undefined;
  const month = Number(raw);
  if (month < 1 || month > 12) return undefined;
  return month;
}

function readYear(value: unknown): number | undefined {
  const raw =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^\d{2}$|^\d{4}$/.test(raw)) return undefined;
  return Number(raw);
}

function readExpiry(
  value: unknown,
): { expMonth: number; expYear: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(0?[1-9]|1[0-2])\s*[/-]\s*(\d{2}|\d{4})$/);
  if (!match) return undefined;
  return { expMonth: Number(match[1]), expYear: Number(match[2]) };
}

function classifyAdjacentHeld(
  body: string,
  held: HeldPlaceholder,
): BodyPlaceholderMatch {
  const sources = [body];
  const decoded = decodeForHeldSearch(body);
  if (decoded !== body) sources.push(decoded);
  const pattern = new RegExp(held.number.split("").join("[\\s+-]*"), "g");
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      const after = source.slice((match.index ?? 0) + match[0].length);
      const expiry = after.match(
        /^\s*(0?[1-9]|1[0-2])\s*[/-]\s*(\d{2}|\d{4})(?!\d)/,
      );
      if (expiry) {
        const expMonth = Number(expiry[1]);
        const expYear = Number(expiry[2]);
        if (
          expMonth !== held.expMonth ||
          expYear % 100 !== held.expYear % 100
        ) {
          return {
            kind: "mismatch",
            injectionRef: held.injectionRef,
            mismatch: "expiry",
          };
        }
        continue;
      }
      const cvc = after.match(/^\s*(\d{3,4})(?!\d)/);
      if (cvc && cvc[1] !== held.cvc) {
        return {
          kind: "mismatch",
          injectionRef: held.injectionRef,
          mismatch: "cvc",
        };
      }
    }
  }
  return { kind: "match", injectionRef: held.injectionRef };
}

function decodeForHeldSearch(text: string): string {
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

function normalizeForHeldSearch(text: string): string {
  return decodeForHeldSearch(text).replace(/[\s+-]|%20/gi, "");
}

function scanRawNumbers(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\d(?:[\s-]*\d){12,18}/g)) {
    const candidate = cardNumberCandidate(match[0]);
    if (candidate) found.add(candidate);
  }
  return [...found];
}
