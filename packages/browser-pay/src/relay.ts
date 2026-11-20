import {
  assertCredentialMayTravel,
  credentialFetch,
  resolveCredentialPolicy,
  type CredentialPolicy,
} from "@sapiom/analytics-core/credential";

import {
  parseRelayResponse,
  type RelayRequest,
  type RelayResponse,
} from "./contract.js";

export interface RelayCallOptions {
  signal?: AbortSignal;
}

export interface PaymentRelay {
  relay(
    request: RelayRequest,
    options?: RelayCallOptions,
  ): Promise<RelayResponse>;
}

export interface HttpRelayOptions {
  baseUrl: string;
  apiKey?: string;
  transactionId: string;
  fetchImpl?: typeof fetch;
}

export class RelayTimeoutError extends Error {
  constructor() {
    super("Payment relay timed out");
    this.name = "RelayTimeoutError";
  }
}

export function isRelayTimeout(error: unknown): boolean {
  return error instanceof RelayTimeoutError || isAbortError(error);
}

const ROUTER_STATUS = new Set([502, 503, 504]);

export class RelayHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Payment relay failed (HTTP ${status})`);
    this.name = "RelayHttpError";
    this.status = status;
  }
}

export class RelayTransportError extends Error {
  constructor() {
    super("Payment relay failed");
    this.name = "RelayTransportError";
  }
}

export function isRetryableRelayError(error: unknown): boolean {
  if (isRelayTimeout(error)) return true;
  if (error instanceof RelayTransportError) return true;
  return error instanceof RelayHttpError && ROUTER_STATUS.has(error.status);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function assertBaseUrl(baseUrl: string, policy: CredentialPolicy): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Payment relay baseUrl must be a valid URL");
  }
  if (
    baseUrl.includes("#") ||
    baseUrl.includes("?") ||
    url.hash ||
    url.search
  ) {
    throw new Error(
      "Payment relay baseUrl must not contain a query or fragment",
    );
  }
  // Refuse at construction, not on the first payment.
  assertCredentialMayTravel(url, policy);
}

function requireHttpOptions(options: HttpRelayOptions): {
  baseUrl: string;
  apiKey: string;
  transactionId: string;
  fetchImpl: typeof fetch;
  policy: CredentialPolicy;
} {
  if (!options || typeof options.baseUrl !== "string" || !options.baseUrl) {
    throw new Error("Payment relay baseUrl is required");
  }
  const policy = resolveCredentialPolicy(undefined, {
    label: "@sapiom/browser-pay",
  });
  assertBaseUrl(options.baseUrl, policy);
  if (!options.transactionId) {
    throw new Error("Payment relay transactionId is required");
  }
  const apiKey = options.apiKey ?? process.env.SAPIOM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SAPIOM_API_KEY is required for the payment relay HTTP client",
    );
  }
  return {
    baseUrl: options.baseUrl.replace(/\/$/, ""),
    apiKey,
    transactionId: options.transactionId,
    fetchImpl: options.fetchImpl ?? fetch,
    policy,
  };
}

function transportError(error: unknown, signal?: AbortSignal): Error {
  if (error instanceof RelayTimeoutError) return error;
  if (signal?.aborted || isAbortError(error)) return new RelayTimeoutError();
  return new RelayTransportError();
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function httpPaymentRelay(options: HttpRelayOptions): PaymentRelay {
  const config = requireHttpOptions(options);
  return {
    async relay(request, call) {
      const url = `${config.baseUrl}/v1/transactions/${encodeURIComponent(config.transactionId)}/payment/relay`;
      let response: Response;
      try {
        response = await credentialFetch(
          config.fetchImpl,
          url,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            signal: call?.signal,
          },
          { header: "x-api-key", value: config.apiKey },
          config.policy,
        );
      } catch (error) {
        throw transportError(error, call?.signal);
      }
      if (response.status < 200 || response.status >= 300) {
        await discardBody(response);
        if (response.status >= 300 && response.status < 400) {
          throw new Error("Payment relay refused a redirect");
        }
        throw new RelayHttpError(response.status);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw transportError(error, call?.signal);
      }
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
          // The thrown error must not include the response text.
        }
      }
      throw new Error(`Payment relay failed (HTTP ${response.status})`);
    },
  };
}
