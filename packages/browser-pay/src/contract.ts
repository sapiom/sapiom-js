/**
 * T7, the body David's relay accepts on
 * `POST /v1/transactions/{transactionId}/payment/relay`.
 *
 * The paused request body may contain the placeholder the agent typed.
 * A success body is the payment provider's response. A refusal names a
 * reason and does not echo the request. Real card values never travel
 * back to the browser.
 *
 * `headers` may include browser cookies. The relay must not log or persist
 * them. The backend scrubs provider response bodies before they return.
 * This package also refuses to fulfill a response that still contains a
 * Luhn-valid card number other than the held placeholder.
 *
 * Refusal reasons are the ones named on the relay: `already_relayed` and
 * `total_changed` (SAP-4071, PR 5792), `key_rotated` and `card_removed`
 * (PR 5754), and the checkPlaceholderUse answers `expired`, `closed`,
 * `refused`, and `unknown` (PR 5758, updated in 5754). An unrecognized
 * reason is reported as `unknown`.
 */

import { createHash } from "node:crypto";

export const RELAY_REFUSAL_REASONS = [
  "already_relayed",
  "total_changed",
  "key_rotated",
  "card_removed",
  "expired",
  "closed",
  "refused",
  "unknown",
] as const;

export type RelayRefusalReason = (typeof RELAY_REFUSAL_REASONS)[number];

export type RelayBodyEncoding = "utf8" | "base64";

/** One header. The same name may appear more than once (Set-Cookie). */
export type RelayHeader = [name: string, value: string];

/**
 * What the interceptor sends. `merchantOrigin` is the top-level page origin
 * (scheme + host), the payTo value bound at authorization.
 * `idempotencyKey` is sha256(method, url, body). The HTTP client also sends
 * it as the `idempotency-key` header. Shopify's card iframe retries share
 * one key.
 */
export interface RelayRequest {
  transactionId: string;
  injectionRef: string;
  merchantOrigin: string;
  url: string;
  method: string;
  headers: RelayHeader[];
  body: string;
  idempotencyKey: string;
}

/** Provider response to fulfill the paused browser request with. */
export interface RelaySuccess {
  kind: "relayed";
  status: number;
  headers: RelayHeader[];
  /** Provider response body. `bodyEncoding` says how `body` is encoded. */
  body: string;
  bodyEncoding: RelayBodyEncoding;
}

/** Verification failed. Nothing was forwarded. The request is not echoed. */
export interface RelayRefusal {
  kind: "refused";
  reason: RelayRefusalReason;
}

export type RelayResponse = RelaySuccess | RelayRefusal;

/** Stable across retries of the same paused request. */
export function paymentIdempotencyKey(
  method: string,
  url: string,
  body: string,
): string {
  return createHash("sha256")
    .update(method)
    .update("\0")
    .update(url)
    .update("\0")
    .update(body)
    .digest("hex");
}

export function isRelayRefusalReason(
  value: string,
): value is RelayRefusalReason {
  for (const reason of RELAY_REFUSAL_REASONS) {
    if (reason === value) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRelayHeaderList(value: unknown): value is RelayHeader[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

/** A string map, with multiple Set-Cookie values split on newlines. */
export function relayHeadersFromRecord(
  headers: Record<string, string>,
): RelayHeader[] {
  const out: RelayHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie") {
      for (const part of value.split("\n")) {
        if (part.length > 0) out.push([name, part]);
      }
      continue;
    }
    out.push([name, value]);
  }
  return out;
}

function headersFromUnknown(value: unknown): RelayHeader[] | undefined {
  if (isRelayHeaderList(value)) return value;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === "string")) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry === "string") record[key] = entry;
  }
  return relayHeadersFromRecord(record);
}

function isBodyEncoding(value: unknown): value is RelayBodyEncoding {
  return value === "utf8" || value === "base64";
}

function readReason(value: unknown): RelayRefusalReason | undefined {
  if (typeof value !== "string") return undefined;
  return isRelayRefusalReason(value) ? value : "unknown";
}

/**
 * Accept `{ kind: "relayed", status, headers, body }` or
 * `{ kind: "refused", reason }`. `bodyEncoding` defaults to utf8.
 * The error never includes the payload.
 */
export function parseRelayResponse(value: unknown): RelayResponse {
  if (!isRecord(value)) {
    throw new Error("Payment relay returned an unreadable response");
  }
  if (value.kind === "refused") {
    const reason = readReason(value.reason);
    if (!reason) {
      throw new Error("Payment relay returned an unreadable response");
    }
    return { kind: "refused", reason };
  }
  if (value.kind === "relayed") {
    const headers = headersFromUnknown(value.headers);
    const bodyEncoding =
      value.bodyEncoding === undefined ? "utf8" : value.bodyEncoding;
    if (
      typeof value.status !== "number" ||
      !Number.isInteger(value.status) ||
      value.status < 100 ||
      value.status > 599 ||
      typeof value.body !== "string" ||
      !headers ||
      !isBodyEncoding(bodyEncoding)
    ) {
      throw new Error("Payment relay returned an unreadable response");
    }
    return {
      kind: "relayed",
      status: value.status,
      headers,
      body: value.body,
      bodyEncoding,
    };
  }
  throw new Error("Payment relay returned an unreadable response");
}

export function isRelayRequest(value: unknown): value is RelayRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.transactionId === "string" &&
    value.transactionId.length > 0 &&
    typeof value.injectionRef === "string" &&
    value.injectionRef.length > 0 &&
    typeof value.merchantOrigin === "string" &&
    typeof value.url === "string" &&
    typeof value.method === "string" &&
    typeof value.body === "string" &&
    typeof value.idempotencyKey === "string" &&
    value.idempotencyKey.length > 0 &&
    isRelayHeaderList(value.headers)
  );
}
