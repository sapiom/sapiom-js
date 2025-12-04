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

import type { FailureMode } from "@sapiom/core";

/**
 * Authorization configuration for fetch
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
}

/**
 * Payment configuration for fetch
 */
export interface PaymentConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
}

const SDK_VERSION = "1.0.0";
const AUTHORIZATION_TIMEOUT = 30000;
const POLL_INTERVAL = 1000;

/**
 * Custom error classes
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

function getHeader(headers: Headers, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

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
 * Create authorization wrapper for fetch
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

  if (existingTransactionId) {
    const poller = new TransactionPoller(config.sapiomClient, {
      timeout: AUTHORIZATION_TIMEOUT,
      pollInterval: POLL_INTERVAL,
    });

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
            AUTHORIZATION_TIMEOUT,
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

  const sanitizedHeaders: Record<string, string> = {};
  const sensitiveHeaders = new Set([
    "authorization",
    "cookie",
    "x-api-key",
    "x-auth-token",
  ]);

  for (const [key, value] of request.headers.entries()) {
    if (!sensitiveHeaders.has(key.toLowerCase())) {
      sanitizedHeaders[key] = value;
    }
  }

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
      const poller = new TransactionPoller(config.sapiomClient, {
        timeout: AUTHORIZATION_TIMEOUT,
        pollInterval: POLL_INTERVAL,
      });

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
          AUTHORIZATION_TIMEOUT,
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

  return new Request(request, { headers });
}

/**
 * Handle payment errors (402 responses)
 *
 * Reauthorizes the existing transaction with payment data from the 402 response,
 * then retries the request with the X-PAYMENT header.
 */
export async function handlePayment(
  originalInput: string | URL | Request,
  originalInit: RequestInit | undefined,
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

  // Extract raw x402 response (no pre-processing)
  const x402Response = extractX402Response(httpError);
  const resource = extractResourceFromError(httpError);

  if (!x402Response || !resource) {
    return response;
  }

  // Get existing transaction ID from the request (set by authorization interceptor)
  const existingTransactionId = getHeader(
    request.headers,
    "X-Sapiom-Transaction-Id",
  );

  if (!existingTransactionId) {
    // No existing transaction - return the 402 response
    // This can happen if authorization was skipped or failed
    return response;
  }

  const originalUrl =
    typeof originalInput === "string"
      ? originalInput
      : originalInput instanceof URL
        ? originalInput.toString()
        : originalInput.url;

  let transaction;
  try {
    // Reauthorize the existing transaction with payment data
    transaction = await config.sapiomClient.transactions.reauthorizeWithPayment(
      existingTransactionId,
      {
        x402: x402Response,
        metadata: {
          originalRequest: {
            url: originalUrl,
            method: originalInit?.method || "GET",
          },
          responseHeaders: Object.fromEntries(response.headers.entries()),
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

  // Poll for authorization if not already authorized
  if (transaction.status !== TransactionStatus.AUTHORIZED) {
    const poller = new TransactionPoller(config.sapiomClient, {
      timeout: AUTHORIZATION_TIMEOUT,
      pollInterval: POLL_INTERVAL,
    });

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
    throw new Error(
      `Transaction ${transaction.id} is authorized but missing payment authorization payload`,
    );
  }

  const paymentHeaderValue =
    typeof authorizationPayload === "string"
      ? authorizationPayload
      : btoa(JSON.stringify(authorizationPayload));

  const newInit = {
    ...originalInit,
    headers: {
      ...(originalInit?.headers || {}),
      "X-PAYMENT": paymentHeaderValue,
    },
  };

  return await globalThis.fetch(originalInput, newInit);
}

/**
 * Completion configuration for fetch
 */
export interface CompletionConfig {
  sapiomClient: SapiomClient;
}

/**
 * Handle transaction completion after request finishes (fire-and-forget)
 *
 * This should be called after the HTTP request completes to mark the transaction
 * as COMPLETED with the appropriate outcome (success/error).
 */
export function handleCompletion(
  request: Request,
  response: Response | null,
  error: Error | null,
  config: CompletionConfig,
  startTime: number,
): void {
  const transactionId = getHeader(request.headers, "X-Sapiom-Transaction-Id");

  if (!transactionId) {
    return;
  }

  const durationMs = Date.now() - startTime;
  const isSuccess = response !== null && response.ok;

  const sanitizedHeaders: Record<string, string> = {};
  if (response) {
    const sensitiveHeaders = new Set([
      "set-cookie",
      "authorization",
      "x-api-key",
    ]);
    for (const [key, value] of response.headers.entries()) {
      if (!sensitiveHeaders.has(key.toLowerCase())) {
        sanitizedHeaders[key] = value;
      }
    }
  }

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
      facts,
    };
  }

  // Fire-and-forget: complete the transaction without blocking
  config.sapiomClient.transactions
    .complete(transactionId, {
      outcome: isSuccess ? "success" : "error",
      responseFacts,
    })
    .catch((err) => {
      console.error("[Sapiom] Failed to complete transaction:", err);
    });
}
