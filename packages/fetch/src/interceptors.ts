import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  captureUserCallSite,
  extractX402Response,
  extractResourceFromError,
  HttpClientRequestFacts,
  HttpClientResponseFacts,
  HttpClientErrorFacts,
} from "@sapiom/core";

import type { FailureMode, TransactionPollingConfig } from "@sapiom/core";

/**
 * Authorization configuration for the fetch interceptor.
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
  polling?: TransactionPollingConfig;
}

/**
 * Payment configuration for the fetch interceptor.
 */
export interface PaymentConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
  polling?: TransactionPollingConfig;
}

const SDK_VERSION = "1.0.0";

/** Default polling configuration (shared with TransactionPoller defaults) */
const DEFAULT_POLLING: Required<TransactionPollingConfig> = {
  timeout: 30000,
  pollInterval: 1000,
};

/**
 * Error thrown when transaction authorization is denied.
 */
export class AuthorizationDeniedError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly endpoint: string,
    public readonly reason?: string,
  ) {
    super(
      `Authorization denied for ${endpoint}: ${reason || "No reason provided"}`,
    );
    this.name = "AuthorizationDeniedError";
  }
}

/**
 * Error thrown when transaction authorization times out.
 */
export class AuthorizationTimeoutError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly endpoint: string,
    public readonly timeout: number,
  ) {
    super(`Authorization timeout after ${timeout}ms for ${endpoint}`);
    this.name = "AuthorizationTimeoutError";
  }
}

/**
 * Case-insensitively retrieves a header value from a Headers instance.
 */
function getHeader(headers: Headers, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/**
 * Case-insensitively sets or overwrites a header in a Headers instance.
 */
function setHeader(headers: Headers, name: string, value: string): void {
  const lowerName = name.toLowerCase();
  const keysToDelete: string[] = [];
  for (const key of headers.keys()) {
    if (key.toLowerCase() === lowerName) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach((key) => headers.delete(key));
  headers.set(name, value);
}

/**
 * Resolves the appropriate payment header name based on the x402 specification version.
 * V1: X-PAYMENT, V2: PAYMENT-SIGNATURE
 */
function getPaymentHeaderName(payload: any): string {
  if (payload?.x402Version === 2) {
    return "PAYMENT-SIGNATURE";
  }
  return "X-PAYMENT";
}

/**
 * Identifies header names that must never be forwarded in telemetry or metadata.
 * Covers credential/session keywords and raw payment proof headers.
 */
function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("sapiom-identity") ||
    lower.includes("auth") ||
    lower.includes("key") ||
    lower.includes("token") ||
    lower.includes("cookie") ||
    lower === "x-payment" ||
    lower === "payment-signature"
  );
}

/**
 * Copies a header collection into a plain key-value object, redacting sensitive headers.
 */
function sanitizeHeaders(
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (!isSensitiveHeaderName(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Encodes a UTF-8 string into standard Base64 representation across browser and Node runtimes.
 */
function base64EncodeUtf8(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf-8").toString("base64");
  }
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Pre-flight authorization handler for native fetch requests.
 */
export async function handleAuthorization(
  request: Request,
  config: AuthorizationConfig,
  defaultMetadata?: Record<string, any>,
): Promise<Request> {
  const existingTransactionId = getHeader(
    request.headers,
    "X-Sapiom-Transaction-Id",
  );

  const polling = {
    ...DEFAULT_POLLING,
    ...config.polling,
  };

  if (existingTransactionId) {
    const poller = new TransactionPoller(config.sapiomClient, polling);

    let transaction;
    try {
      transaction = await config.sapiomClient.transactions.get(
        existingTransactionId,
      );
    } catch (error) {
      if (config.failureMode === "closed") throw error;
      console.error(
        "[Sapiom] Failed to get transaction, allowing request:",
        error,
      );
      return request;
    }

    const endpoint = request.url;

    switch (transaction.status) {
      case TransactionStatus.AUTHORIZED:
        return request;

      case TransactionStatus.PENDING:
      case TransactionStatus.PREPARING: {
        let authResult;
        try {
          authResult = await poller.waitForAuthorization(existingTransactionId);
        } catch (error) {
          if (config.failureMode === "closed") throw error;
          console.error(
            "[Sapiom] Failed to poll transaction, allowing request:",
            error,
          );
          return request;
        }

        if (authResult.status === "authorized") {
          return request;
        } else if (authResult.status === "denied") {
          throw new AuthorizationDeniedError(existingTransactionId, endpoint);
        } else {
          throw new AuthorizationTimeoutError(
            existingTransactionId,
            endpoint,
            polling.timeout,
          );
        }
      }

      case TransactionStatus.DENIED:
      case TransactionStatus.CANCELLED:
        throw new AuthorizationDeniedError(existingTransactionId, endpoint);

      default:
        throw new Error(
          `Transaction ${existingTransactionId} has unexpected status: ${transaction.status}`,
        );
    }
  }

  const requestMetadata = (request as any).__sapiom || {};
  const userMetadata = { ...defaultMetadata, ...requestMetadata };

  const method = request.method.toUpperCase();
  const url = request.url;
  const endpoint = new URL(url).pathname;

  const callSite = captureUserCallSite();

  const parsedUrl = new URL(url);
  const urlParsed = {
    protocol: parsedUrl.protocol.replace(":", ""),
    hostname: parsedUrl.hostname,
    pathname: parsedUrl.pathname,
    search: parsedUrl.search,
    port: parsedUrl.port ? parseInt(parsedUrl.port) : null,
  };

  const sanitizedHeaders = sanitizeHeaders(request.headers.entries());

  const requestFacts: HttpClientRequestFacts = {
    method,
    url,
    urlParsed,
    headers: sanitizedHeaders,
    hasBody: request.body !== null,
    bodySizeBytes: undefined,
    contentType: request.headers.get("content-type") || undefined,
    clientType: "fetch",
    callSite,
    timestamp: new Date().toISOString(),
  };

  let transaction;
  try {
    transaction = await config.sapiomClient.transactions.create({
      requestFacts: {
        source: "http-client",
        version: "v1",
        sdk: {
          name: "@sapiom/fetch",
          version: SDK_VERSION,
        },
        ...(userMetadata?.integration && {
          integration: userMetadata.integration,
        }),
        request: requestFacts,
      },
      serviceName: userMetadata?.serviceName,
      actionName: userMetadata?.actionName,
      resourceName: userMetadata?.resourceName,
      traceId: userMetadata?.traceId,
      traceExternalId: userMetadata?.traceExternalId,
      agentId: userMetadata?.agentId,
      agentName: userMetadata?.agentName,
      qualifiers: userMetadata?.qualifiers,
      metadata: {
        ...userMetadata?.metadata,
        preemptiveAuthorization: true,
      },
    });
  } catch (error) {
    if (config.failureMode === "closed") throw error;
    console.error(
      "[Sapiom] Failed to create transaction, allowing request:",
      error,
    );
    return request;
  }

  switch (transaction.status) {
    case TransactionStatus.AUTHORIZED:
      break;

    case TransactionStatus.PENDING:
    case TransactionStatus.PREPARING: {
      const poller = new TransactionPoller(config.sapiomClient, polling);

      let authResult;
      try {
        authResult = await poller.waitForAuthorization(transaction.id);
      } catch (error) {
        if (config.failureMode === "closed") throw error;
        console.error(
          "[Sapiom] Failed to poll transaction, allowing request:",
          error,
        );
        return request;
      }

      if (authResult.status === "denied") {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      } else if (authResult.status === "timeout") {
        throw new AuthorizationTimeoutError(
          transaction.id,
          endpoint,
          polling.timeout,
        );
      }
      break;
    }

    case TransactionStatus.DENIED:
    case TransactionStatus.CANCELLED:
      throw new AuthorizationDeniedError(transaction.id, endpoint);

    default:
      throw new Error(
        `Transaction ${transaction.id} has unexpected status: ${transaction.status}`,
      );
  }

  const headers = new Headers(request.headers);
  setHeader(headers, "X-Sapiom-Transaction-Id", transaction.id);

  const authorizedRequest = new Request(request, { headers });
  // The Request constructor does not copy custom own properties; carry
  // per-request __sapiom metadata over so handlePayment can still see it.
  if ((request as any).__sapiom !== undefined) {
    (authorizedRequest as any).__sapiom = (request as any).__sapiom;
  }
  return authorizedRequest;
}

/**
 * Handle payment errors (402 responses).
 * Reauthorizes transaction with payment data from 402 and retries with X-PAYMENT.
 */
export async function handlePayment(
  requestForRetry: Request,
  response: Response,
  config: PaymentConfig,
  request: Request,
  defaultMetadata?: Record<string, any>,
): Promise<Response> {
  if (response.status !== 402) {
    return response;
  }

  const errorResponse = response.clone();
  const errorBody = await errorResponse.text();

  let errorData: any;
  try {
    errorData = JSON.parse(errorBody);
  } catch {
    errorData = { message: errorBody };
  }

  const httpError = {
    message: "Payment required",
    status: 402,
    data: errorData,
    response: {
      status: 402,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: errorData,
    },
  };

  const x402Response = extractX402Response(httpError);
  const resource = extractResourceFromError(httpError);

  if (!x402Response || !resource) {
    return response;
  }

  const polling = {
    ...DEFAULT_POLLING,
    ...config.polling,
  };

  let existingTransactionId = getHeader(
    request.headers,
    "X-Sapiom-Transaction-Id",
  );

  if (!existingTransactionId) {
    const requestMetadata = { ...defaultMetadata, ...((request as any).__sapiom || {}) };
    const callSite = captureUserCallSite();
    const parsedUrl = new URL(request.url);

    try {
      const newTransaction = await config.sapiomClient.transactions.create({
        requestFacts: {
          source: "http-client",
          version: "v1",
          sdk: {
            name: "@sapiom/fetch",
            version: SDK_VERSION,
          },
          ...(requestMetadata?.integration && {
            integration: requestMetadata.integration,
          }),
          request: {
            method: request.method.toUpperCase(),
            url: request.url,
            urlParsed: {
              protocol: parsedUrl.protocol.replace(":", ""),
              hostname: parsedUrl.hostname,
              pathname: parsedUrl.pathname,
              search: parsedUrl.search,
              port: parsedUrl.port ? parseInt(parsedUrl.port) : null,
            },
            headers: {},
            hasBody: request.body !== null,
            bodySizeBytes: undefined,
            contentType: request.headers.get("content-type") || undefined,
            clientType: "fetch",
            callSite,
            timestamp: new Date().toISOString(),
          },
        },
        serviceName: requestMetadata?.serviceName,
        actionName: requestMetadata?.actionName,
        resourceName: requestMetadata?.resourceName,
        traceId: requestMetadata?.traceId,
        traceExternalId: requestMetadata?.traceExternalId,
        agentId: requestMetadata?.agentId,
        agentName: requestMetadata?.agentName,
        qualifiers: requestMetadata?.qualifiers,
        metadata: {
          ...requestMetadata?.metadata,
          onDemandPayment: true,
        },
      });
      existingTransactionId = newTransaction.id;
      setHeader(request.headers, "X-Sapiom-Transaction-Id", existingTransactionId);
    } catch (error) {
      if (config.failureMode === "closed") throw error;
      console.error(
        "[Sapiom] Failed to create on-demand transaction for payment, returning 402:",
        error,
      );
      return response;
    }
  }

  let transaction;
  try {
    transaction = await config.sapiomClient.transactions.reauthorizeWithPayment(
      existingTransactionId,
      {
        x402: x402Response,
        metadata: {
          originalRequest: {
            url: request.url,
            method: request.method,
          },
          responseHeaders: sanitizeHeaders(response.headers.entries()),
          httpStatusCode: 402,
        },
      },
    );
  } catch (error) {
    if (config.failureMode === "closed") throw error;
    console.error(
      "[Sapiom] Failed to reauthorize transaction with payment, returning 402:",
      error,
    );
    return response;
  }

  if (transaction.status !== TransactionStatus.AUTHORIZED) {
    const poller = new TransactionPoller(config.sapiomClient, polling);

    let authResult;
    try {
      authResult = await poller.waitForAuthorization(transaction.id);
    } catch (error) {
      if (config.failureMode === "closed") throw error;
      console.error(
        "[Sapiom] Failed to poll payment transaction, returning 402:",
        error,
      );
      return response;
    }

    if (authResult.status !== "authorized") {
      return response;
    }

    transaction = authResult.transaction!;
  }

  const authorizationPayload = transaction.payment?.authorizationPayload;

  if (!authorizationPayload) {
    const payloadError = new Error(
      `Transaction ${transaction.id} is authorized but missing payment authorization payload`,
    );
    if (config.failureMode === "closed") throw payloadError;
    console.error(
      "[Sapiom] Authorized transaction is missing payment authorization payload, returning 402:",
      payloadError,
    );
    return response;
  }

  const paymentHeaderValue =
    typeof authorizationPayload === "string"
      ? authorizationPayload
      : base64EncodeUtf8(JSON.stringify(authorizationPayload));

  const headerName = getPaymentHeaderName(authorizationPayload);

  const retryHeaders = new Headers(requestForRetry.headers);
  setHeader(retryHeaders, headerName, paymentHeaderValue);

  return await globalThis.fetch(
    new Request(requestForRetry, { headers: retryHeaders }),
  );
}

/**
 * Completion configuration for the fetch interceptor.
 */
export interface CompletionConfig {
  sapiomClient: SapiomClient;
}

/**
 * Handles transaction completion after request finishes (fire-and-forget).
 */
export function handleCompletion(
  request: Request,
  response: Response | null,
  error: Error | null,
  config: CompletionConfig,
  startTime: number,
  defaultMetadata?: Record<string, any>,
): void {
  const transactionId = getHeader(request.headers, "X-Sapiom-Transaction-Id");

  if (!transactionId) {
    return;
  }

  const durationMs = Date.now() - startTime;
  const isSuccess = response !== null && response.ok;

  const sanitizedHeaders: Record<string, string> = response
    ? sanitizeHeaders(response.headers.entries())
    : {};

  let responseFacts:
    | { source: string; version: string; facts: Record<string, any> }
    | undefined;

  if (isSuccess && response) {
    const facts: HttpClientResponseFacts = {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizedHeaders,
      contentType: response.headers.get("content-type") || undefined,
      durationMs,
    };
    responseFacts = {
      source: "http-client",
      version: "v1",
      ...(defaultMetadata?.integration && {
        integration: defaultMetadata.integration,
      }),
      facts,
    };
  } else if (error || (response && !response.ok)) {
    const facts: HttpClientErrorFacts = {
      errorType: error?.name || "HttpError",
      errorMessage: error?.message || `HTTP ${response?.status}`,
      httpStatus: response?.status,
      httpStatusText: response?.statusText,
      isNetworkError: error !== null && response === null,
      isTimeout:
        error?.name === "AbortError" ||
        error?.message?.includes("timeout") ||
        false,
      elapsedMs: durationMs,
    };
    responseFacts = {
      source: "http-client",
      version: "v1",
      ...(defaultMetadata?.integration && {
        integration: defaultMetadata.integration,
      }),
      facts,
    };
  }

  config.sapiomClient.transactions
    .complete(transactionId, {
      outcome: isSuccess ? "success" : "error",
      responseFacts,
    })
    .catch((err) => {
      console.error("[Sapiom] Failed to complete transaction:", err);
    });
}
