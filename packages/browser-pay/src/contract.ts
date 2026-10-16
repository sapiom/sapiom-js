/**
 * T7, the interceptor-to-relay contract (W7 U0).
 *
 * The paused request body may contain the placeholder the agent typed. No field
 * on the response is a credential: a success body is the payment provider's
 * opaque response, and a refusal names a reason without echoing the request.
 * Real card values never travel back to the browser.
 */

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
] as const;

export type RelayRefusalReason = (typeof RELAY_REFUSAL_REASONS)[number];

/**
 * What the interceptor sends to the relay.
 * `merchantOrigin` is the top-level page origin (scheme + host), the payTo
 * value bound at authorization. It is never the card iframe's processor host.
 */
export interface RelayRequest {
  transactionId: string;
  injectionRef: string;
  merchantOrigin: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Provider response to fulfill the paused browser request with. */
export interface RelaySuccess {
  ok: true;
  /** Provider HTTP status. */
  status: number;
  headers: Record<string, string>;
  /** Provider response body. Must not contain a real card value. */
  body: string;
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

function isHeaderRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string",
  );
}

/**
 * Accept a success payload or a typed refusal. Anything else throws, and the
 * message never includes the payload (it may contain a card or a request echo).
 */
export function parseRelayResponse(value: unknown): RelayResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Payment relay returned an unreadable response");
  }
  const body = value as Record<string, unknown>;
  if (body.ok === true) {
    if (
      typeof body.status !== "number" ||
      !Number.isInteger(body.status) ||
      body.status < 100 ||
      body.status > 599 ||
      typeof body.body !== "string" ||
      !isHeaderRecord(body.headers)
    ) {
      throw new Error("Payment relay returned an unreadable response");
    }
    return {
      ok: true,
      status: body.status,
      headers: body.headers,
      body: body.body,
    };
  }
  if (
    typeof body.reason === "string" &&
    isRelayRefusalReason(body.reason) &&
    body.ok !== true
  ) {
    return { ok: false, reason: body.reason };
  }
  throw new Error("Payment relay returned an unreadable response");
}
