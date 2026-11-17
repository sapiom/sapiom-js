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

/** The four fields Adyen secured fields put on `paymentMethod`, each one encrypted blob. */
export const ADYEN_ENCRYPTED_FIELDS = [
  "encryptedCardNumber",
  "encryptedExpiryMonth",
  "encryptedExpiryYear",
  "encryptedSecurityCode",
] as const;

export type AdyenEncryptedField = (typeof ADYEN_ENCRYPTED_FIELDS)[number];

export type AdyenEncryptedFields = Record<AdyenEncryptedField, string>;

export interface AdyenEncryptRequest {
  injectionRef: string;
  /** The merchant's Adyen client key, read from the page. The backend fetches the public key from Adyen itself. */
  clientKey: string;
  pageOrigin: string;
}

/**
 * The backend's typed answer when Adyen card encryption is switched off for
 * this deployment. It arrives as `code` (an error body) or `reason`.
 */
export const ADYEN_ENCRYPTION_NOT_ENABLED = "adyen_encryption_not_enabled";

export type AdyenEncryptResult =
  | { outcome: "encrypted"; fields: AdyenEncryptedFields }
  | { outcome: "not_enabled" };

export function isAdyenNotEnabled(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.code === ADYEN_ENCRYPTION_NOT_ENABLED ||
      value.reason === ADYEN_ENCRYPTION_NOT_ENABLED)
  );
}

export function parseAdyenEncryptResponse(value: unknown): AdyenEncryptResult {
  if (isAdyenNotEnabled(value)) return { outcome: "not_enabled" };
  if (!isRecord(value)) {
    throw new Error("Adyen re-encryption returned an unreadable response");
  }
  const fields = {} as AdyenEncryptedFields;
  for (const field of ADYEN_ENCRYPTED_FIELDS) {
    const blob = value[field];
    if (typeof blob !== "string" || blob.length === 0) {
      throw new Error("Adyen re-encryption returned an unreadable response");
    }
    fields[field] = blob;
  }
  return { outcome: "encrypted", fields };
}
