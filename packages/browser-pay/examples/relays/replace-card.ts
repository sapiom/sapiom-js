import { cardNumberCandidate } from "../../src/detect.js";
import type { RelayHeader, RelayRequest } from "../../src/index.js";

export interface CardReplacement {
  number: string;
  expMonth: string | number;
  expYear: string | number;
  cvc: string;
}

/**
 * Replace the placeholder's number, expiry, and CVC in a JSON or form body.
 * Throws, without forwarding, when the placeholder number is still present.
 */
export function replacePlaceholderCard(
  body: string,
  placeholderNumber: string,
  next: CardReplacement,
): string {
  const trimmed = body.trim();
  let replaced = "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const result = replaceJson(JSON.parse(body), placeholderNumber, next);
    if (!result.replaced) {
      throw new Error("Placeholder card fields were not replaced");
    }
    replaced = JSON.stringify(result.value);
  } else if (trimmed.includes("=")) {
    replaced = replaceForm(body, placeholderNumber, next);
  } else {
    throw new Error("Placeholder card fields were not replaced");
  }
  if (numberStillPresent(replaced, placeholderNumber)) {
    throw new Error("Placeholder card fields were not replaced");
  }
  return replaced;
}

function replaceJson(
  value: unknown,
  placeholderNumber: string,
  next: CardReplacement,
): { value: unknown; replaced: boolean } {
  if (Array.isArray(value)) {
    let replaced = false;
    const items = value.map((item) => {
      const child = replaceJson(item, placeholderNumber, next);
      replaced = replaced || child.replaced;
      return child.value;
    });
    return { value: items, replaced };
  }
  if (!value || typeof value !== "object") return { value, replaced: false };
  const obj = value as Record<string, unknown>;
  if (objectHasNumber(obj, placeholderNumber)) {
    return {
      value: replaceObject(obj, placeholderNumber, next),
      replaced: true,
    };
  }
  let replaced = false;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    const nextChild = replaceJson(child, placeholderNumber, next);
    replaced = replaced || nextChild.replaced;
    out[key] = nextChild.value;
  }
  return { value: out, replaced };
}

function objectHasNumber(
  obj: Record<string, unknown>,
  placeholderNumber: string,
): boolean {
  return Object.values(obj).some(
    (value) =>
      typeof value === "string" &&
      cardNumberCandidate(value) === placeholderNumber,
  );
}

function replaceObject(
  obj: Record<string, unknown>,
  placeholderNumber: string,
  next: CardReplacement,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === "string" &&
      cardNumberCandidate(value) === placeholderNumber
    ) {
      out[key] = next.number;
      continue;
    }
    const kind = fieldKind(key);
    if (kind === "month") {
      out[key] = like(value, next.expMonth);
      continue;
    }
    if (kind === "year") {
      out[key] = like(value, next.expYear);
      continue;
    }
    if (kind === "cvc") {
      out[key] = next.cvc;
      continue;
    }
    if (kind === "expiry") {
      out[key] = formatExpiry(next);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function replaceForm(
  body: string,
  placeholderNumber: string,
  next: CardReplacement,
): string {
  const params = new URLSearchParams(body);
  let found = false;
  for (const [key, value] of params) {
    if (cardNumberCandidate(value) === placeholderNumber) {
      params.set(key, next.number);
      found = true;
    }
  }
  if (!found) throw new Error("Placeholder card fields were not replaced");
  for (const [key, value] of [...params.entries()]) {
    const kind = fieldKind(key.split("[").pop()?.replace("]", "") ?? key);
    if (kind === "month") params.set(key, String(like(value, next.expMonth)));
    if (kind === "year") params.set(key, String(like(value, next.expYear)));
    if (kind === "cvc") params.set(key, next.cvc);
    if (kind === "expiry") params.set(key, formatExpiry(next));
  }
  return params.toString();
}

function like(original: unknown, value: string | number): string | number {
  if (typeof value === "string" && !/^\d+$/.test(value)) return value;
  if (typeof original === "number") return Number(value);
  return String(value);
}

function formatExpiry(next: CardReplacement): string {
  if (typeof next.expMonth === "string" && !/^\d+$/.test(next.expMonth)) {
    return `${next.expMonth}/${next.expYear}`;
  }
  const month = String(next.expMonth).padStart(2, "0");
  const year = String(next.expYear);
  const shortYear = year.length === 4 ? year.slice(-2) : year;
  return `${month}/${shortYear}`;
}

function numberStillPresent(body: string, number: string): boolean {
  const pattern = new RegExp(number.split("").join("[\\s-]*"));
  return pattern.test(body);
}

function fieldKind(key: string): "month" | "year" | "expiry" | "cvc" | "other" {
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
    normalized.includes("verificationvalue") ||
    normalized.includes("securitycode")
  ) {
    return "cvc";
  }
  if (normalized === "year" || normalized.endsWith("year")) return "year";
  if (normalized === "month" || normalized.endsWith("month")) return "month";
  if (
    normalized === "expiry" ||
    normalized === "expiration" ||
    normalized === "exp"
  ) {
    return "expiry";
  }
  return "other";
}

export const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
]);

export function relayBodyText(request: RelayRequest): string {
  if (request.bodyEncoding === "base64") {
    return Buffer.from(request.body, "base64").toString("utf8");
  }
  return request.body;
}

export function forwardRequestHeaders(
  headers: RelayHeader[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    const existing = Object.keys(out).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (existing) out[existing] = `${out[existing]}, ${value}`;
    else out[key] = value;
  }
  return out;
}

export function providerResponseHeaders(headers: Headers): RelayHeader[] {
  const drop = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
  ]);
  const out: RelayHeader[] = [];
  headers.forEach((value, key) => {
    if (drop.has(key) || key.startsWith("bt-") || key === "set-cookie") return;
    out.push([key, value]);
  });
  const setCookies =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const cookie of setCookies) out.push(["set-cookie", cookie]);
  return out;
}
