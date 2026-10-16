import {
  isRelayRequest,
  parseRelayResponse,
  type RelayRequest,
  type RelayResponse,
} from "./contract.js";

export type { RelayRequest, RelayResponse };

export interface RelayCallOptions {
  /** Aborts the relay. The interceptor aborts this when its own timeout fires or it detaches. */
  signal?: AbortSignal;
}

/**
 * Pluggable relay. `httpPaymentRelay` is the default HTTP client for David's
 * route. A test double implements the same interface.
 */
export interface PaymentRelay {
  relay(
    request: RelayRequest,
    options?: RelayCallOptions,
  ): Promise<RelayResponse>;
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

function requireHttpOptions(options: HttpRelayOptions): {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
} {
  if (!options || typeof options.baseUrl !== "string" || !options.baseUrl) {
    throw new Error("Payment relay baseUrl is required");
  }
  const apiKey = options.apiKey ?? process.env.SAPIOM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SAPIOM_API_KEY is required for the payment relay HTTP client",
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error("Payment relay timeoutMs must be a positive number");
  }
  return {
    baseUrl: options.baseUrl.replace(/\/$/, ""),
    apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

/**
 * David's route: `POST /v1/transactions/{id}/payment/relay`.
 * One attempt, no retry. A redirect fails closed.
 */
export function httpPaymentRelay(options: HttpRelayOptions): PaymentRelay {
  const config = requireHttpOptions(options);
  return {
    async relay(request, call) {
      if (!isRelayRequest(request)) {
        throw new Error("Payment relay request is not a T7 body");
      }
      const url = `${config.baseUrl}/v1/transactions/${encodeURIComponent(request.transactionId)}/payment/relay`;
      const signal = call?.signal ?? AbortSignal.timeout(config.timeoutMs);
      let response: Response;
      try {
        response = await config.fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": config.apiKey,
            "idempotency-key": request.idempotencyKey,
          },
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        if (signal.aborted || isTimeout(error)) {
          throw new Error("Payment relay timed out");
        }
        throw new Error("Payment relay failed");
      }
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
          // Fall through. Never include `text`.
        }
      }
      throw new Error(`Payment relay failed (HTTP ${response.status})`);
    },
  };
}

/** In-memory relay for tests. */
export function stubPaymentRelay(
  handler: (
    request: RelayRequest,
    options?: RelayCallOptions,
  ) => RelayResponse | Promise<RelayResponse>,
): PaymentRelay {
  return {
    relay(request, options) {
      return Promise.resolve(handler(request, options));
    },
  };
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /timeout/i.test(message);
}
