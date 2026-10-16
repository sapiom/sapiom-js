import {
  parseRelayResponse,
  type RelayRequest,
  type RelayResponse,
} from "./contract.js";

export type { RelayRequest, RelayResponse };

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
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function requireHttpOptions(options: HttpRelayOptions): {
  baseUrl: string;
  apiKey: string;
  transactionId: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
} {
  if (!options || typeof options.baseUrl !== "string" || !options.baseUrl) {
    throw new Error("Payment relay baseUrl is required");
  }
  if (!options.transactionId) {
    throw new Error("Payment relay transactionId is required");
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
    transactionId: options.transactionId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

function combinedSignal(
  timeoutMs: number,
  caller?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

export function httpPaymentRelay(options: HttpRelayOptions): PaymentRelay {
  const config = requireHttpOptions(options);
  return {
    async relay(request, call) {
      const url = `${config.baseUrl}/v1/transactions/${encodeURIComponent(config.transactionId)}/payment/relay`;
      const { signal, dispose } = combinedSignal(
        config.timeoutMs,
        call?.signal,
      );
      let response: Response;
      try {
        response = await config.fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        if (signal.aborted || isTimeout(error)) {
          throw new Error("Payment relay timed out");
        }
        throw new Error("Payment relay failed");
      } finally {
        dispose();
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
          // The thrown error must not include the response text.
        }
      }
      throw new Error(`Payment relay failed (HTTP ${response.status})`);
    },
  };
}

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
