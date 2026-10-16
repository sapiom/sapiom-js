import {
  parseRelayResponse,
  type RelayRequest,
  type RelayResponse,
} from "./contract.js";

export type { RelayRequest, RelayResponse };

/** Pluggable relay. The HTTP client and the in-memory stub both implement this. */
export interface PaymentRelay {
  relay(request: RelayRequest): Promise<RelayResponse>;
}

export interface HttpRelayOptions {
  /** API origin, for example `https://api.sapiom.ai`. The `/v1/...` path is added here. */
  baseUrl: string;
  /** Defaults to `SAPIOM_API_KEY`. Sent as `x-api-key`, same as the rest of the SDK. */
  apiKey?: string;
  /** One attempt. A timeout fails the paused request; it is never retried. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * David's route: `POST /v1/transactions/:id/payment/relay`.
 * The route may not be deployed yet. One attempt, no retry.
 */
export function httpPaymentRelay(options: HttpRelayOptions): PaymentRelay {
  const apiKey = options.apiKey ?? process.env.SAPIOM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SAPIOM_API_KEY is required for the payment relay HTTP client",
    );
  }
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async relay(request) {
      const url = `${baseUrl}/v1/transactions/${encodeURIComponent(request.transactionId)}/payment/relay`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (isTimeout(error)) throw new Error("Payment relay timed out");
        throw new Error("Payment relay failed");
      }
      // A redirect would be the provider (or an attacker) pointing the real
      // card somewhere else. Fail closed without reading a Location header.
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Payment relay refused a redirect");
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        try {
          return parseRelayResponse(parsed);
        } catch {
          // Fall through to a status-only error. Never include `text`.
        }
      }
      throw new Error(`Payment relay failed (HTTP ${response.status})`);
    },
  };
}

/** In-memory relay for tests and local demos. */
export function stubPaymentRelay(
  handler: (request: RelayRequest) => RelayResponse | Promise<RelayResponse>,
): PaymentRelay {
  return {
    relay(request) {
      return Promise.resolve(handler(request));
    },
  };
}

function isTimeout(error: unknown): boolean {
  // Jest runs this file in a vm, so a DOMException from Node's fetch is not
  // an `instanceof Error` here. Read the fields instead.
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /timeout/i.test(message);
}
