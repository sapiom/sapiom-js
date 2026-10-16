/**
 * T7, the interceptor-to-relay contract (W7 U0).
 *
 * The paused request body may contain the placeholder the agent typed. No field
 * on the response is a credential: a success body is the payment provider's
 * opaque response, and a refusal names a reason without echoing the request.
 * Real card values never travel back to the browser.
 *
 * `headers` may include browser cookies. The relay backend must not log or
 * persist them. The backend also scrubs provider response bodies and headers
 * before they are returned; the interceptor refuses to fulfill a response that
 * still contains a card number other than the held placeholder.
 */

export const RELAY_CONTRACT_VERSION = 1;

export const RELAY_REFUSAL_REASONS = [
  "wrong_key",
  "unknown_placeholder",
  "closed_placeholder",
  "expired_placeholder",
  "off_profile_destination",
  "replay",
  "merchant_origin",
  "changed_total",
  "cancelled",
  "unknown",
] as const;

export type RelayRefusalReason = (typeof RELAY_REFUSAL_REASONS)[number];

export type RelayBodyEncoding = "utf8" | "base64";

/** One header. The same name may appear more than once (Set-Cookie). */
export type RelayHeader = [name: string, value: string];

/**
 * What the interceptor sends to the relay.
 * `merchantOrigin` is the top-level page origin (scheme + host), the payTo
 * value bound at authorization. It is never the card iframe's processor host.
 * `frameOrigin` is the origin of the frame that issued the request.
 */
export interface RelayRequest {
  version: typeof RELAY_CONTRACT_VERSION;
  transactionId: string;
  injectionRef: string;
  merchantOrigin: string;
  frameOrigin?: string;
  url: string;
  method: string;
  headers: RelayHeader[];
  body: string;
  bodyEncoding: RelayBodyEncoding;
  /**
   * CDP request id plus a nonce. The relay uses it to recognize a retry of
   * the same paused request (`replay`).
   */
  idempotencyKey: string;
}

/** Provider response to fulfill the paused browser request with. */
export interface RelaySuccess {
  ok: true;
  /** Provider HTTP status. */
  status: number;
  headers: RelayHeader[];
  /**
   * Provider response body. Must not contain a real card value.
   * `bodyEncoding` says how `body` is encoded.
   */
  body: string;
  bodyEncoding: RelayBodyEncoding;
}

/** Verification failed. Nothing was forwarded. The request is not echoed. */
export interface RelayRefusal {
  ok: false;
  reason: RelayRefusalReason;
}

export type RelayResponse = RelaySuccess | RelayRefusal;

export function isRelayRefusalReason(
  value: string,
): value is RelayRefusalReason {
  return (RELAY_REFUSAL_REASONS as readonly string[]).includes(value);
}

export function isRelayBodyEncoding(
  value: unknown,
): value is RelayBodyEncoding {
  return value === "utf8" || value === "base64";
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Object.values(record).every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return relayHeadersFromRecord(record as Record<string, string>);
}

/**
 * Accept a success payload or a typed refusal. An unknown refusal reason
 * becomes `unknown` so a newer backend does not look like a network error.
 * Anything else throws, and the message never includes the payload (it may
 * contain a card or a request echo).
 */
export function parseRelayResponse(value: unknown): RelayResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Payment relay returned an unreadable response");
  }
  const body = value as Record<string, unknown>;
  if (body.ok === true) {
    const headers = headersFromUnknown(body.headers);
    const bodyEncoding =
      body.bodyEncoding === undefined ? "utf8" : body.bodyEncoding;
    if (
      typeof body.status !== "number" ||
      !Number.isInteger(body.status) ||
      body.status < 100 ||
      body.status > 599 ||
      typeof body.body !== "string" ||
      !headers ||
      !isRelayBodyEncoding(bodyEncoding)
    ) {
      throw new Error("Payment relay returned an unreadable response");
    }
    return {
      ok: true,
      status: body.status,
      headers,
      body: body.body,
      bodyEncoding,
    };
  }
  if (body.ok === false && typeof body.reason === "string") {
    return {
      ok: false,
      reason: isRelayRefusalReason(body.reason) ? body.reason : "unknown",
    };
  }
  throw new Error("Payment relay returned an unreadable response");
}
