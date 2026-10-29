import { createHash } from "node:crypto";
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
  request: RelayHttpRequest;
  idempotencyKey: string;
}

export interface RelayedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type RelayResponse =
  | { outcome: "relayed"; response: RelayedHttpResponse }
  | {
      outcome: "refused";
      reason: string;
      retryable?: boolean;
      requestId?: string;
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
    return {
      outcome: "refused",
      reason: value.reason,
      ...(typeof retryable === "boolean" ? { retryable } : {}),
      ...(typeof requestId === "string" && requestId.length > 0
        ? { requestId }
        : {}),
    };
  }
  if (value.outcome !== "relayed" || !isRecord(value.response)) {
    throw new Error("Payment relay returned an unreadable response");
  }
  const response = value.response;
  const headers = stringRecord(response.headers);
  if (
    typeof response.status !== "number" ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.body !== "string" ||
    !headers
  ) {
    throw new Error("Payment relay returned an unreadable response");
  }
  return {
    outcome: "relayed",
    response: { status: response.status, headers, body: response.body },
  };
}
