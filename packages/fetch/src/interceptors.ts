import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  captureUserCallSite,
  extractPaymentData,
  extractResourceFromError,
} from "@sapiom/core";

/**
 * Authorization configuration for fetch
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
}

/**
 * Payment configuration for fetch
 */
export interface PaymentConfig {
  sapiomClient: SapiomClient;
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
    public readonly reason?: string
  ) {
    super(
      `Authorization denied for ${endpoint}: ${reason || "No reason provided"}`
    );
    this.name = "AuthorizationDeniedError";
  }
}

export class AuthorizationTimeoutError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly endpoint: string,
    public readonly timeout: number
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
  defaultMetadata?: Record<string, any>
): Promise<Request> {
  const existingTransactionId = getHeader(
    request.headers,
    "X-Sapiom-Transaction-Id"
  );

  if (existingTransactionId) {
    const poller = new TransactionPoller(config.sapiomClient, {
      timeout: AUTHORIZATION_TIMEOUT,
      pollInterval: POLL_INTERVAL,
    });

    const transaction = await config.sapiomClient.transactions.get(
      existingTransactionId
    );

    const endpoint = request.url;

    switch (transaction.status) {
      case TransactionStatus.AUTHORIZED:
        return request;

      case TransactionStatus.PENDING:
      case TransactionStatus.PREPARING: {
        const authResult = await poller.waitForAuthorization(
          existingTransactionId
        );

        if (authResult.status === "authorized") {
          return request;
        } else if (authResult.status === "denied") {
          throw new AuthorizationDeniedError(
            existingTransactionId,
            endpoint
          );
        } else {
          throw new AuthorizationTimeoutError(
            existingTransactionId,
            endpoint,
            AUTHORIZATION_TIMEOUT
          );
        }
      }

      case TransactionStatus.DENIED:
      case TransactionStatus.CANCELLED:
        throw new AuthorizationDeniedError(existingTransactionId, endpoint);

      default:
        throw new Error(
          `Transaction ${existingTransactionId} has unexpected status: ${transaction.status}`
        );
    }
  }

  const requestMetadata = (request as any).__sapiom || {};
  const userMetadata = { ...defaultMetadata, ...requestMetadata };

  if (requestMetadata?.skipAuthorization) {
    return request;
  }

  const method = request.method.toUpperCase();
  const url = request.url;
  const endpoint = new URL(url).pathname;

  const callSite = captureUserCallSite();

  const parsedUrl = new URL(url);
  const urlParsed = {
    protocol: parsedUrl.protocol.replace(":", ""),
    host: parsedUrl.host,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port,
    pathname: parsedUrl.pathname,
    search: parsedUrl.search,
    hash: parsedUrl.hash,
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

  const requestFacts = {
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

  const transaction = await config.sapiomClient.transactions.create({
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

  switch (transaction.status) {
    case TransactionStatus.AUTHORIZED:
      break;

    case TransactionStatus.PENDING:
    case TransactionStatus.PREPARING: {
      const poller = new TransactionPoller(config.sapiomClient, {
        timeout: AUTHORIZATION_TIMEOUT,
        pollInterval: POLL_INTERVAL,
      });
      const authResult = await poller.waitForAuthorization(transaction.id);

      if (authResult.status === "denied") {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      } else if (authResult.status === "timeout") {
        throw new AuthorizationTimeoutError(
          transaction.id,
          endpoint,
          AUTHORIZATION_TIMEOUT
        );
      }
      break;
    }

    case TransactionStatus.DENIED:
    case TransactionStatus.CANCELLED:
      throw new AuthorizationDeniedError(transaction.id, endpoint);

    default:
      throw new Error(
        `Transaction ${transaction.id} has unexpected status: ${transaction.status}`
      );
  }

  const headers = new Headers(request.headers);
  setHeader(headers, "X-Sapiom-Transaction-Id", transaction.id);

  return new Request(request, { headers });
}

/**
 * Handle payment errors (402 responses)
 */
export async function handlePayment(
  originalRequest: Request,
  response: Response,
  config: PaymentConfig,
  defaultMetadata?: Record<string, any>
): Promise<Response> {
  if (response.status !== 402) {
    return response;
  }

  try {
    const errorResponse = response.clone();
    const errorBody = await errorResponse.text();
    let errorData: any;
    try {
      errorData = JSON.parse(errorBody);
    } catch {
      errorData = { message: errorBody };
    }

    const httpError = {
      response: {
        status: 402,
        data: errorData,
      },
    };

    const paymentData = extractPaymentData(httpError);
    const resource = extractResourceFromError(httpError);

    if (!paymentData || !resource) {
      return response;
    }

    const requestMetadata = (originalRequest as any).__sapiom || {};
    const userMetadata = { ...defaultMetadata, ...requestMetadata };

    const transaction = await config.sapiomClient.transactions.create({
      serviceName: resource.split(":")[0] || "unknown",
      actionName: userMetadata?.actionName || "access",
      resourceName: userMetadata?.resourceName || resource,
      paymentData,
      traceId: userMetadata?.traceId,
      traceExternalId: userMetadata?.traceExternalId,
      agentId: userMetadata?.agentId,
      agentName: userMetadata?.agentName,
      qualifiers: userMetadata?.qualifiers,
      metadata: {
        ...userMetadata?.metadata,
        originalMethod: originalRequest.method,
        originalUrl: originalRequest.url,
      },
    });

    const poller = new TransactionPoller(config.sapiomClient, {
      timeout: AUTHORIZATION_TIMEOUT,
      pollInterval: POLL_INTERVAL,
    });

    const authResult = await poller.waitForAuthorization(transaction.id);

    if (authResult.status !== "authorized") {
      return response;
    }

    const authorizedTransaction = authResult.transaction!;
    const authorizationPayload = authorizedTransaction.payment?.authorizationPayload;

    if (!authorizationPayload) {
      throw new Error(
        `Transaction ${transaction.id} is authorized but missing payment authorization payload`
      );
    }

    const paymentHeaderValue =
      typeof authorizationPayload === "string"
        ? authorizationPayload
        : btoa(JSON.stringify(authorizationPayload));

    const headers = new Headers(originalRequest.headers);
    setHeader(headers, "X-PAYMENT", paymentHeaderValue);

    const retryRequest = new Request(originalRequest, { headers });
    const retryResponse = await fetch(retryRequest);

    return retryResponse;
  } catch (error) {
    return response;
  }
}
