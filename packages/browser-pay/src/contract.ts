import { createHash } from "node:crypto";

import type { PlaceholderBlobHashes } from "./adyen-blobs.js";
import { isRecord } from "./guards.js";

export interface RelayHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface RelayRequest {
  injectionRef: string;
  /** Omitted when the request matched no relay profile; the relay then sends it to its own URL. */
  profileId?: string;
  pageOrigin: string;
  /**
   * The top-level page's origin and path (`location.origin + location.pathname`),
   * never its query or fragment. Omitted when it can't be read, isn't on
   * `pageOrigin`, or holds the placeholder. The relay uses it to refuse a
   * payment from a checkout other than the purchase's (`checkout_mismatch`).
   */
  pageUrl?: string;
  request: RelayHttpRequest;
  idempotencyKey: string;
  /**
   * Sent only with the `adyen-checkout` profile: the merchant's Adyen client
   * key, which the relay uses to encrypt the real card in place of the four
   * `paymentMethod.encrypted*` fields the page encrypted for the placeholder.
   * A Pay also carries the sha256 hex of each blob the page's secured fields
   * produced, so the relay swaps only the blobs seen in this browser.
   */
  adyen?: { clientKey: string; placeholderBlobHashes?: PlaceholderBlobHashes };
}

export interface RelayedHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Raw Set-Cookie values, one header per entry, never comma-joined. */
  setCookies?: string[];
  body: string;
}

export type RelayResponse =
  | { outcome: "relayed"; response: RelayedHttpResponse }
  | {
      outcome: "refused";
      reason: string;
      retryable?: boolean;
      requestId?: string;
      /** The relay's next step for the agent. Kept only when a non-empty string. */
      message?: string;
    }
  | { outcome: "unknown" };

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

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? value : undefined;
}

export function parseRelayResponse(value: unknown): RelayResponse {
  if (!isRecord(value) || typeof value.outcome !== "string") {
    throw new Error("Payment relay returned an unreadable response");
  }
  if (value.outcome === "unknown") return { outcome: "unknown" };
  if (value.outcome === "refused") {
    if (typeof value.reason !== "string" || value.reason.length === 0) {
      throw new Error("Payment relay returned an unreadable response");
    }
    const retryable = value.retryable;
    const requestId = value.requestId;
    const message = value.message;
    return {
      outcome: "refused",
      reason: value.reason,
      ...(typeof retryable === "boolean" ? { retryable } : {}),
      ...(typeof requestId === "string" && requestId.length > 0
        ? { requestId }
        : {}),
      ...(typeof message === "string" && message.length > 0 ? { message } : {}),
    };
  }
  if (value.outcome !== "relayed" || !isRecord(value.response)) {
    throw new Error("Payment relay returned an unreadable response");
  }
  const response = value.response;
  const headers = stringRecord(response.headers);
  const setCookies = stringArray(response.setCookies);
  if (
    typeof response.status !== "number" ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.body !== "string" ||
    !headers ||
    (response.setCookies !== undefined && !setCookies)
  ) {
    throw new Error("Payment relay returned an unreadable response");
  }
  return {
    outcome: "relayed",
    response: {
      status: response.status,
      headers,
      ...(setCookies ? { setCookies } : {}),
      body: response.body,
    },
  };
}

/** Adyen `resultCode`s after a payment. `unknown` is any other answer, or none readable. */
export const ADYEN_RESULT_CODES = [
  "Authorised",
  "Refused",
  "Error",
  "Cancelled",
  "Pending",
  "Received",
  "RedirectShopper",
  "IdentifyShopper",
  "ChallengeShopper",
] as const;

export type AdyenResultCode = (typeof ADYEN_RESULT_CODES)[number] | "unknown";

/**
 * Codes asking the shopper for 3-D Secure. The page's agent completes it; the
 * final code comes in the answer to the page's `/payments/details` call.
 */
export function isAdyenActionResult(code: AdyenResultCode): boolean {
  return (
    code === "RedirectShopper" ||
    code === "IdentifyShopper" ||
    code === "ChallengeShopper"
  );
}

export interface AdyenResultRequest {
  injectionRef: string;
  resultCode: AdyenResultCode;
  pspReference?: string;
}

/**
 * The backend's answer to a reported result. `pending` means it changed
 * nothing: the code was not final. `refused` carries the error body's `code`,
 * for example `RESULT_CONFLICT` when another result was already recorded.
 */
export type AdyenResultResponse =
  | { outcome: AdyenResultOutcome; resultCode: string }
  | { outcome: "refused"; status: number; code: string; retryable?: boolean };

/** `recorded`: the backend stored the result but completion is off or dry-run. */
type AdyenResultOutcome = "completed" | "failed" | "pending" | "recorded";

function isAdyenResultOutcome(value: unknown): value is AdyenResultOutcome {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "pending" ||
    value === "recorded"
  );
}

export function parseAdyenResultResponse(
  value: unknown,
): Extract<AdyenResultResponse, { resultCode: string }> {
  if (
    !isRecord(value) ||
    typeof value.resultCode !== "string" ||
    !isAdyenResultOutcome(value.outcome)
  ) {
    throw new Error("Adyen result report returned an unreadable response");
  }
  return {
    outcome: value.outcome,
    resultCode: value.resultCode,
  };
}

/** A refusal's `code`, or `undefined` when the error body has none. */
export function adyenResultRefusal(
  status: number,
  value: unknown,
): Extract<AdyenResultResponse, { outcome: "refused" }> | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || !value.code) {
    return undefined;
  }
  return {
    outcome: "refused",
    status,
    code: value.code,
    ...(typeof value.retryable === "boolean"
      ? { retryable: value.retryable }
      : {}),
  };
}
