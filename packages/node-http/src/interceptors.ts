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

/**
 * Authorization configuration
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
}

/**
 * Payment configuration
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
 * Handle authorization for a request
 */
export async function handleAuthorization(
  request: HttpRequest,
  config: AuthorizationConfig,
  defaultMetadata?: Record<string, any>,
): Promise<HttpRequest> {
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

  const sanitizedHeaders: Record<string, string> = {};
  const sensitiveHeaders = new Set([
    "authorization",
    "cookie",
    "x-api-key",
    "x-auth-token",
  ]);

  for (const [key, value] of Object.entries(request.headers)) {
    if (!sensitiveHeaders.has(key.toLowerCase())) {
      sanitizedHeaders[key] = value;
    }
  }

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
    const poller = new TransactionPoller(config.sapiomClient, {
      timeout: AUTHORIZATION_TIMEOUT,
      pollInterval: POLL_INTERVAL,
    });
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
      AUTHORIZATION_TIMEOUT,
    );
  }
}

/**
 * Handle payment errors (402 responses)
 *
 * Reauthorizes the existing transaction with payment data from the 402 response,
 * then retries the request with the X-PAYMENT header.
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

  // Extract raw x402 response (no pre-processing)
  const x402Response = extractX402Response(error);
  const resource = extractResourceFromError(error);

  if (!x402Response || !resource) {
    throw error;
  }

  // Get existing transaction ID from the request (set by authorization interceptor)
  const existingTransactionId = getHeader(
    originalRequest.headers,
    "X-Sapiom-Transaction-Id",
  );

  if (!existingTransactionId) {
    // No existing transaction - throw the original error
    // This can happen if authorization was skipped or failed
    throw error;
  }

  let transaction;
  try {
    // Reauthorize the existing transaction with payment data
    transaction = await config.sapiomClient.transactions.reauthorizeWithPayment(
      existingTransactionId,
      {
        x402: x402Response,
        metadata: {
          originalRequest: {
            url: originalRequest.url,
            method: originalRequest.method,
          },
          responseHeaders: error.response?.headers,
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
    let authResult;
    try {
      const poller = new TransactionPoller(config.sapiomClient, {
        timeout: AUTHORIZATION_TIMEOUT,
        pollInterval: POLL_INTERVAL,
      });
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
    throw new Error(
      `Transaction ${transaction.id} is authorized but missing payment authorization payload`,
    );
  }

  const paymentHeaderValue =
    typeof authorizationPayload === "string"
      ? authorizationPayload
      : Buffer.from(JSON.stringify(authorizationPayload)).toString("base64");

  const retryRequest = { ...originalRequest };
  retryRequest.headers = { ...originalRequest.headers };
  setHeader(retryRequest.headers, "X-PAYMENT", paymentHeaderValue);

  const retryResponse = await requestFn(retryRequest);

  return retryResponse;
}

/**
 * Completion configuration
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

  const sanitizedHeaders: Record<string, string> = {};
  if (response?.headers) {
    const sensitiveHeaders = new Set([
      "set-cookie",
      "authorization",
      "x-api-key",
    ]);
    Object.entries(response.headers).forEach(([key, value]) => {
      if (!sensitiveHeaders.has(key.toLowerCase())) {
        sanitizedHeaders[key] = String(value);
      }
    });
  }

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
