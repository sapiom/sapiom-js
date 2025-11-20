import * as http from "http";
import * as https from "https";
import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  PaymentTransactionResponse,
  captureUserCallSite,
  extractPaymentData,
  extractResourceFromError,
  HttpRequest,
  HttpResponse,
  HttpError,
} from "@sapiom/core";

/**
 * Endpoint authorization rule for pattern matching
 */
export interface EndpointAuthorizationRule {
  method?: string | string[] | RegExp;
  pathPattern: RegExp;
  serviceName: string;
  actionName?: string;
  qualifiers?:
    | Record<string, any>
    | ((request: HttpRequest) => Record<string, any>);
  resourceExtractor?: (request: HttpRequest) => string;
  metadata?: Record<string, any>;
}

/**
 * Authorization configuration
 */
export interface AuthorizationConfig {
  sapiomClient: SapiomClient;
  enabled?: boolean;
  authorizedEndpoints?: EndpointAuthorizationRule[];
  authorizationTimeout?: number;
  pollingInterval?: number;
  onAuthorizationPending?: (transactionId: string, endpoint: string) => void;
  onAuthorizationSuccess?: (transactionId: string, endpoint: string) => void;
  onAuthorizationDenied?: (
    transactionId: string,
    endpoint: string,
    reason?: string
  ) => void;
  throwOnDenied?: boolean;
}

/**
 * Payment configuration
 */
export interface PaymentConfig {
  sapiomClient: SapiomClient;
  enabled?: boolean;
  onPaymentRequired?: (
    transactionId: string,
    payment: PaymentTransactionResponse
  ) => void;
  onPaymentSuccess?: (transactionId: string) => void;
  onPaymentFailed?: (error: Error) => void;
  maxRetries?: number;
  pollingInterval?: number;
  authorizationTimeout?: number;
}

// SDK version for facts
const SDK_VERSION = "1.0.0"; // TODO: Read from package.json

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

/**
 * Helper to match endpoint against authorization rules
 */
function matchesEndpoint(
  request: HttpRequest,
  rule: EndpointAuthorizationRule
): boolean {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const path = url.pathname;

  // Check method match
  if (rule.method) {
    if (typeof rule.method === "string") {
      if (method !== rule.method.toUpperCase()) return false;
    } else if (Array.isArray(rule.method)) {
      if (!rule.method.map((m) => m.toUpperCase()).includes(method))
        return false;
    } else if (rule.method instanceof RegExp) {
      if (!rule.method.test(method)) return false;
    }
  }

  // Check path match
  return rule.pathPattern.test(path);
}

/**
 * Helper to get header value (case-insensitive)
 */
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

/**
 * Helper to set header value (case-insensitive, replaces existing)
 */
function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string
): void {
  const lowerName = name.toLowerCase();
  // Remove existing header with any casing
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
  // Set new value
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
  // Check for existing transaction ID (from retry)
  const existingTransactionId = getHeader(
    request.headers,
    "X-Sapiom-Transaction-Id"
  );

  if (existingTransactionId) {
    const poller = new TransactionPoller(config.sapiomClient, {
      pollInterval: config.pollingInterval ?? 1000,
    });

    const transaction = await config.sapiomClient.transactions.get(
      existingTransactionId
    );

    const endpoint = request.url;

    switch (transaction.status) {
      case TransactionStatus.AUTHORIZED:
        config.onAuthorizationSuccess?.(existingTransactionId, endpoint);
        return request;

      case TransactionStatus.PENDING:
      case TransactionStatus.PREPARING: {
        const authResult = await poller.waitForAuthorization(
          existingTransactionId
        );

        if (authResult.status === "authorized") {
          config.onAuthorizationSuccess?.(existingTransactionId, endpoint);
          return request;
        } else if (authResult.status === "denied") {
          config.onAuthorizationDenied?.(existingTransactionId, endpoint);
          if (config.throwOnDenied !== false) {
            throw new AuthorizationDeniedError(
              existingTransactionId,
              endpoint
            );
          }
          return request;
        } else {
          throw new AuthorizationTimeoutError(
            existingTransactionId,
            endpoint,
            config.authorizationTimeout ?? 30000
          );
        }
      }

      case TransactionStatus.DENIED:
      case TransactionStatus.CANCELLED:
        config.onAuthorizationDenied?.(existingTransactionId, endpoint);
        if (config.throwOnDenied !== false) {
          throw new AuthorizationDeniedError(existingTransactionId, endpoint);
        }
        return request;

      default:
        throw new Error(
          `Transaction ${existingTransactionId} has unexpected status: ${transaction.status}`
        );
    }
  }

  // Get user metadata from request
  const requestMetadata = request.__sapiom || {};
  const userMetadata = { ...defaultMetadata, ...requestMetadata };

  // Skip if explicitly disabled
  if (requestMetadata?.skipAuthorization) {
    return request;
  }

  // Determine if should authorize
  const shouldAuthorize =
    userMetadata || // Always authorize if user provided metadata
    !config.authorizedEndpoints || // Authorize all if no patterns configured
    config.authorizedEndpoints.length === 0 ||
    config.authorizedEndpoints.some((rule) => matchesEndpoint(request, rule));

  if (!shouldAuthorize) {
    return request;
  }

  // Find matching rule (if any)
  const matchedRule = config.authorizedEndpoints?.find((rule) =>
    matchesEndpoint(request, rule)
  );

  const method = request.method.toUpperCase();
  const url = request.url;
  const endpoint = new URL(url).pathname;

  // Capture call site for telemetry
  const callSite = captureUserCallSite();

  // Parse URL
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

  // Sanitize headers (remove sensitive headers)
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

  // Build request facts
  const requestFacts = {
    method,
    url,
    urlParsed,
    headers: sanitizedHeaders,
    hasBody: !!request.body,
    bodySizeBytes: undefined, // Skip size calculation to avoid corrupting non-JSON bodies
    contentType: request.headers["content-type"] || undefined,
    clientType: "node-http",
    callSite,
    timestamp: new Date().toISOString(),
  };

  // Create authorization transaction
  const transaction = await config.sapiomClient.transactions.create({
    requestFacts: {
      source: "http-client",
      version: "v1",
      sdk: {
        name: "@sapiom/sdk",
        version: SDK_VERSION,
      },
      request: requestFacts,
    },

    serviceName: userMetadata?.serviceName || matchedRule?.serviceName,
    actionName: userMetadata?.actionName || matchedRule?.actionName,
    resourceName: userMetadata?.resourceName,

    traceId: userMetadata?.traceId,
    traceExternalId: userMetadata?.traceExternalId,

    agentId: userMetadata?.agentId,
    agentName: userMetadata?.agentName,

    qualifiers:
      userMetadata?.qualifiers ||
      (typeof matchedRule?.qualifiers === "function"
        ? matchedRule.qualifiers(request)
        : matchedRule?.qualifiers),
    metadata: {
      ...userMetadata?.metadata,
      ...matchedRule?.metadata,
      preemptiveAuthorization: true,
    },
  });

  // Handle authorization status
  switch (transaction.status) {
    case TransactionStatus.AUTHORIZED:
      config.onAuthorizationSuccess?.(transaction.id, endpoint);
      break;

    case TransactionStatus.PENDING:
    case TransactionStatus.PREPARING: {
      config.onAuthorizationPending?.(transaction.id, endpoint);
      const poller = new TransactionPoller(config.sapiomClient, {
        pollInterval: config.pollingInterval ?? 1000,
      });
      const authResult = await poller.waitForAuthorization(transaction.id);

      if (authResult.status === "authorized") {
        config.onAuthorizationSuccess?.(transaction.id, endpoint);
      } else if (authResult.status === "denied") {
        config.onAuthorizationDenied?.(transaction.id, endpoint);
        if (config.throwOnDenied !== false) {
          throw new AuthorizationDeniedError(transaction.id, endpoint);
        }
      } else {
        throw new AuthorizationTimeoutError(
          transaction.id,
          endpoint,
          config.authorizationTimeout ?? 30000
        );
      }
      break;
    }

    case TransactionStatus.DENIED:
    case TransactionStatus.CANCELLED:
      config.onAuthorizationDenied?.(transaction.id, endpoint);
      if (config.throwOnDenied !== false) {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      }
      break;

    default:
      throw new Error(
        `Transaction ${transaction.id} has unexpected status: ${transaction.status}`
      );
  }

  // Add transaction header
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
  // Only handle 402 errors
  if (error.response?.status !== 402) {
    throw error;
  }

  const maxRetries = config.maxRetries ?? 1;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Extract payment data from 402 error
      const paymentData = extractPaymentData(error);
      const resource = extractResourceFromError(error);

      if (!paymentData || !resource) {
        const err = new Error(
          "Could not extract payment data from 402 error"
        );
        config.onPaymentFailed?.(err);
        throw error;
      }

      // Get user metadata
      const requestMetadata = originalRequest.__sapiom || {};
      const userMetadata = { ...defaultMetadata, ...requestMetadata };

      // Create transaction with payment
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

      config.onPaymentRequired?.(transaction.id, transaction as any);

      // Wait for payment authorization
      const poller = new TransactionPoller(config.sapiomClient, {
        pollInterval: config.pollingInterval ?? 1000,
      });

      const authResult = await poller.waitForAuthorization(transaction.id);

      if (authResult.status !== "authorized") {
        const err = new Error(
          `Payment authorization ${authResult.status}`
        );
        config.onPaymentFailed?.(err);
        throw error; // Re-throw original error
      }

      config.onPaymentSuccess?.(transaction.id);

      // Retry original request with payment header
      const retryRequest = { ...originalRequest };
      retryRequest.headers = { ...originalRequest.headers };
      setHeader(retryRequest.headers, "X-PAYMENT", transaction.id);

      const retryResponse = await requestFn(retryRequest);

      // If still 402, continue loop (for multi-payment scenarios)
      if (retryResponse.status === 402) {
        const retryError: HttpError = {
          message: "Payment required",
          response: retryResponse,
        };
        error = retryError;
        continue;
      }

      return retryResponse;
    } catch (err) {
      config.onPaymentFailed?.(err as Error);
      if (attempt === maxRetries - 1) {
        throw err;
      }
    }
  }

  throw error;
}
