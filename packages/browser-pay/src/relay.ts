import {
  assertCredentialMayTravel,
  credentialFetch,
  resolveCredentialPolicy,
  type CredentialPolicy,
} from "@sapiom/analytics-core/credential";

import {
  adyenResultRefusal,
  parseAdyenResultResponse,
  parseRelayResponse,
  type AdyenResultRequest,
  type AdyenResultResponse,
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
  /**
   * Tells the backend Adyen's final answer after 3-D Secure when the page
   * sent its details through the merchant's own server, out of the relay's
   * sight. A relay without this method reports nothing.
   */
  adyenResult?(
    request: AdyenResultRequest,
    options?: RelayCallOptions,
  ): Promise<AdyenResultResponse>;
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

type HttpConfig = ReturnType<typeof requireHttpOptions>;

/**
 * POSTs JSON under the transaction's payment path and returns the 2xx body
 * text. With `readErrorBody`, a non-2xx, non-redirect body is returned too.
 */
async function postPayment(
  config: HttpConfig,
  path: string,
  payload: unknown,
  signal: AbortSignal | undefined,
  readErrorBody = false,
): Promise<{ status: number; text: string }> {
  const url = `${config.baseUrl}/v1/transactions/${encodeURIComponent(config.transactionId)}/payment/${path}`;
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
        body: JSON.stringify(payload),
        signal,
      },
      { header: "x-api-key", value: config.apiKey },
      config.policy,
    );
  } catch (error) {
    throw transportError(error, signal);
  }
  const redirect = response.status >= 300 && response.status < 400;
  const ok = response.status >= 200 && response.status < 300;
  if (redirect || (!ok && !readErrorBody)) {
    await discardBody(response);
    if (redirect) throw new Error("Payment relay refused a redirect");
    throw new RelayHttpError(response.status);
  }
  try {
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw transportError(error, signal);
  }
}

export function httpPaymentRelay(options: HttpRelayOptions): PaymentRelay {
  const config = requireHttpOptions(options);
  return {
    async relay(request, call) {
      const { status, text } = await postPayment(
        config,
        "relay",
        request,
        call?.signal,
      );
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
      throw new Error(`Payment relay failed (HTTP ${status})`);
    },
    async adyenResult(request, call) {
      const { status, text } = await postPayment(
        config,
        "adyen/result",
        {
          injectionRef: request.injectionRef,
          resultCode: request.resultCode,
          ...(request.pspReference !== undefined
            ? { pspReference: request.pspReference }
            : {}),
        },
        call?.signal,
        true,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The thrown error must not include the response text.
      }
      if (status < 200 || status >= 300) {
        const refusal = adyenResultRefusal(status, parsed);
        if (refusal) return refusal;
        throw new RelayHttpError(status);
      }
      return parseAdyenResultResponse(parsed);
    },
  };
}
