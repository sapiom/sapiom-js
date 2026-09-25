import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  captureUserCallSite,
  extractX402Response,
  extractResourceFromError,
  HttpRequest,
  HttpResponse,
  HttpError,
  HttpClientRequestFacts,
  HttpClientResponseFacts,
  HttpClientErrorFacts,
  FailureMode,
} from "@sapiom/core";

import type { TransactionPollingConfig } from "@sapiom/core";

/**
 * Authorization configuration for the node-http interceptor.
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
  polling?: TransactionPollingConfig;
}

/**
 * Payment configuration for the node-http interceptor.
 */
export interface PaymentConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
  polling?: TransactionPollingConfig;
}

const SDK_VERSION = "1.0.0";

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
 * Case-insensitively retrieves a header value from a headers map.
 */
function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

/**
 * Case-insensitively sets or overwrites a header in a headers map.
 */
function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
  headers[name] = value;
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
 * Copies a headers object into a plain record, dropping sensitive headers.
 */
function sanitizeHeaders(
  headers: Record<string, any> | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!headers) return sanitized;
  for (const [key, value] of Object.entries(headers)) {
    if (!isSensitiveHeaderName(key)) {
      sanitized[key] = String(value);
    }
  }
  return sanitized;
}

/**
 * Handles pre-flight authorization for node-http requests.
 */
export async function handleAuthorization(
  request: HttpRequest,
  config: AuthorizationConfig,
  defaultMetadata?: Record<string, any>,
): Promise<HttpRequest> {
  const polling = { ...DEFAULT_POLLING, ...config.polling };

  const existingTransactionId = getHeader(
    request.headers,
    "X-Sapiom-Transaction-Id",
  );

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

  const requestMetadata = request.__sapiom || {};
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

  const sanitizedHeaders = sanitizeHeaders(request.headers);

  const requestFacts: HttpClientRequestFacts = {
    method,
    url,
    urlParsed,
    headers: sanitizedHeaders,
    hasBody: !!request.body,
    bodySizeBytes: undefined,
    contentType: request.headers["content-type"] || undefined,
    clientType: "node-http",
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
          name: "@sapiom/node-http",
          version: SDK_VERSION,
        },
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

  if (
    transaction.status === TransactionStatus.DENIED ||
    transaction.status === TransactionStatus.CANCELLED
  ) {
    throw new AuthorizationDeniedError(transaction.id, endpoint);
  }

  if (transaction.status === TransactionStatus.AUTHORIZED) {
    const modifiedRequest = { ...request };
    modifiedRequest.headers = { ...request.headers };
    setHeader(
      modifiedRequest.headers,
      "X-Sapiom-Transaction-Id",
      transaction.id,
    );
    return modifiedRequest;
  }

  let result;
  try {
    const poller = new TransactionPoller(config.sapiomClient, polling);
    result = await poller.waitForAuthorization(transaction.id);
  } catch (error) {
    if (config.failureMode === "closed") throw error;
    console.error(
      "[Sapiom] Failed to poll transaction, allowing request:",
      error,
    );
    return request;
  }

  if (result.status === "authorized") {
    const modifiedRequest = { ...request };
    modifiedRequest.headers = { ...request.headers };
    setHeader(
      modifiedRequest.headers,
      "X-Sapiom-Transaction-Id",
      transaction.id,
    );
    return modifiedRequest;
  } else if (result.status === "denied") {
    throw new AuthorizationDeniedError(transaction.id, endpoint);
  } else {
    throw new AuthorizationTimeoutError(
      transaction.id,
      endpoint,
      polling.timeout,
    );
  }
}

/**
 * Handles 402 payment requirements for node-http requests.
 */
export async function handlePayment(
  originalRequest: HttpRequest,
  error: HttpError,
  config: PaymentConfig,
  requestFn: (request: HttpRequest) => Promise<HttpResponse>,
  defaultMetadata?: Record<string, any>,
): Promise<HttpResponse> {
  if (error.response?.status !== 402) {
    throw error;
  }

  const x402Response = extractX402Response(error);
  const resource = extractResourceFromError(error);

  if (!x402Response || !resource) {
    throw error;
  }

  const existingTransactionId = getHeader(
    originalRequest.headers,
    "X-Sapiom-Transaction-Id",
  );

  if (!existingTransactionId) {
    throw error;
  }

  let transaction;
  try {
    transaction = await config.sapiomClient.transactions.reauthorizeWithPayment(
      existingTransactionId,
      {
        x402: x402Response,
        metadata: {
          originalRequest: {
            url: originalRequest.url,
            method: originalRequest.method,
          },
          responseHeaders: sanitizeHeaders(error.response?.headers),
          httpStatusCode: 402,
        },
      },
    );
  } catch (apiError) {
    if (config.failureMode === "closed") throw apiError;
    console.error(
      "[Sapiom] Failed to reauthorize transaction with payment, returning 402:",
      apiError,
    );
    throw error;
  }

  if (
    transaction.status === TransactionStatus.DENIED ||
    transaction.status === TransactionStatus.CANCELLED
  ) {
    throw error;
  }

  if (transaction.status !== TransactionStatus.AUTHORIZED) {
    const polling = { ...DEFAULT_POLLING, ...config.polling };
    let authResult;
    try {
      const poller = new TransactionPoller(config.sapiomClient, polling);
      authResult = await poller.waitForAuthorization(transaction.id);
    } catch (pollError) {
      if (config.failureMode === "closed") throw pollError;
      console.error(
        "[Sapiom] Failed to poll payment transaction, returning 402:",
        pollError,
      );
      throw error;
    }

    if (authResult.status !== "authorized") {
      throw error;
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
    throw error;
  }

  const paymentHeaderValue =
    typeof authorizationPayload === "string"
      ? authorizationPayload
      : Buffer.from(JSON.stringify(authorizationPayload)).toString("base64");

  const headerName = getPaymentHeaderName(authorizationPayload);

  const retryRequest = { ...originalRequest };
  retryRequest.headers = { ...originalRequest.headers };
  setHeader(retryRequest.headers, headerName, paymentHeaderValue);

  const retryResponse = await requestFn(retryRequest);
  return retryResponse;
}

/**
 * Completion configuration for the node-http interceptor.
 */
export interface CompletionConfig {
  sapiomClient: SapiomClient;
}

/**
 * Handles transaction completion after request finishes (fire-and-forget).
 */
export function handleCompletion<T>(
  request: HttpRequest,
  response: HttpResponse<T> | null,
  error: Error | HttpError | null,
  config: CompletionConfig,
  startTime: number,
): void {
  const transactionId = getHeader(request.headers, "X-Sapiom-Transaction-Id");

  if (!transactionId) {
    return;
  }

  const durationMs = Date.now() - startTime;
  const isSuccess =
    response !== null && response.status >= 200 && response.status < 300;

  const sanitizedHeaders = sanitizeHeaders(response?.headers);

  let responseFacts:
    | { source: string; version: string; facts: Record<string, any> }
    | undefined;

  if (isSuccess && response) {
    const facts: HttpClientResponseFacts = {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizedHeaders,
      contentType: response.headers?.["content-type"] as string | undefined,
      durationMs,
    };
    responseFacts = {
      source: "http-client",
      version: "v1",
      facts,
    };
  } else {
    const httpError = error as HttpError | null;
    const facts: HttpClientErrorFacts = {
      errorType: (error as Error)?.name || "HttpError",
      errorMessage:
        (error as Error)?.message || `HTTP ${response?.status || "unknown"}`,
      httpStatus: response?.status || httpError?.response?.status,
      httpStatusText: response?.statusText || httpError?.response?.statusText,
      isNetworkError: error !== null && response === null,
      isTimeout:
        (error as Error)?.message?.includes("ETIMEDOUT") ||
        (error as Error)?.message?.includes("timeout"),
      elapsedMs: durationMs,
    };
    responseFacts = {
      source: "http-client",
      version: "v1",
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
