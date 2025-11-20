import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  captureUserCallSite,
  extractPaymentData,
  extractResourceFromError,
  HttpRequest,
  HttpResponse,
  HttpError,
} from "@sapiom/core";

/**
 * Authorization configuration
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
}

/**
 * Payment configuration
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

function getHeader(
  headers: Record<string, string>,
  name: string
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
  value: string
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
  defaultMetadata?: Record<string, any>
): Promise<HttpRequest> {
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

  const requestMetadata = request.__sapiom || {};
  const userMetadata = { ...defaultMetadata, ...requestMetadata };

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

  for (const [key, value] of Object.entries(request.headers)) {
    if (!sensitiveHeaders.has(key.toLowerCase())) {
      sanitizedHeaders[key] = value;
    }
  }

  const requestFacts = {
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

  const transaction = await config.sapiomClient.transactions.create({
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

  const modifiedRequest = { ...request };
  modifiedRequest.headers = { ...request.headers };
  setHeader(modifiedRequest.headers, "X-Sapiom-Transaction-Id", transaction.id);

  return modifiedRequest;
}

/**
 * Handle payment errors (402 responses)
 */
export async function handlePayment(
  originalRequest: HttpRequest,
  error: HttpError,
  config: PaymentConfig,
  requestFn: (request: HttpRequest) => Promise<HttpResponse>,
  defaultMetadata?: Record<string, any>
): Promise<HttpResponse> {
  if (error.response?.status !== 402) {
    throw error;
  }

  try {
    const paymentData = extractPaymentData(error);
    const resource = extractResourceFromError(error);

    if (!paymentData || !resource) {
      throw error;
    }

    const requestMetadata = originalRequest.__sapiom || {};
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
      throw error;
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
        : Buffer.from(JSON.stringify(authorizationPayload)).toString("base64");

    const retryRequest = { ...originalRequest };
    retryRequest.headers = { ...originalRequest.headers };
    setHeader(retryRequest.headers, "X-PAYMENT", paymentHeaderValue);

    const retryResponse = await requestFn(retryRequest);

    return retryResponse;
  } catch (err) {
    throw error;
  }
}
