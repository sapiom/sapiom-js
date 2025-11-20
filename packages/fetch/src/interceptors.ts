import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  PaymentTransactionResponse,
  captureUserCallSite,
  extractPaymentData,
  extractResourceFromError,
} from "@sapiom/core";

/**
 * Endpoint authorization rule for pattern matching
 */
export interface EndpointAuthorizationRule {
  method?: string | string[] | RegExp;
  pathPattern: RegExp;
  serviceName: string;
  actionName?: string;
  qualifiers?: Record<string, any> | ((request: Request) => Record<string, any>);
  resourceExtractor?: (request: Request) => string;
  metadata?: Record<string, any>;
}

/**
 * Authorization configuration for fetch
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
 * Payment configuration for fetch
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
  request: Request,
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
 * Helper to set header value (case-insensitive, replaces existing)
 */
function setHeader(headers: Headers, name: string, value: string): void {
  const lowerName = name.toLowerCase();
  // Remove existing header with any casing
  const keysToDelete: string[] = [];
  for (const key of headers.keys()) {
    if (key.toLowerCase() === lowerName) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach((key) => headers.delete(key));

  // Set new value
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
  const requestMetadata = (request as any).__sapiom || {};
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

  for (const [key, value] of request.headers.entries()) {
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
    hasBody: request.body !== null,
    bodySizeBytes: undefined, // Cannot reliably calculate without consuming body
    contentType: request.headers.get("content-type") || undefined,
    clientType: "fetch",
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

  // Clone request and add transaction header
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
  // Only handle 402 errors
  if (response.status !== 402) {
    return response;
  }

  const maxRetries = config.maxRetries ?? 1;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Clone response so we can read it
      const errorResponse = response.clone();
      const errorBody = await errorResponse.text();
      let errorData: any;
      try {
        errorData = JSON.parse(errorBody);
      } catch {
        errorData = { message: errorBody };
      }

      // Extract payment data from 402 error
      const httpError = {
        response: {
          status: 402,
          data: errorData,
        },
      };

      const paymentData = extractPaymentData(httpError);
      const resource = extractResourceFromError(httpError);

      if (!paymentData || !resource) {
        config.onPaymentFailed?.(
          new Error("Could not extract payment data from 402 error")
        );
        return response;
      }

      // Get user metadata
      const requestMetadata = (originalRequest as any).__sapiom || {};
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
        const error = new Error(
          `Payment authorization ${authResult.status}`
        );
        config.onPaymentFailed?.(error);
        return response; // Return original 402 response
      }

      config.onPaymentSuccess?.(transaction.id);

      // Retry original request with payment header
      const headers = new Headers(originalRequest.headers);
      setHeader(headers, "X-PAYMENT", transaction.id);

      const retryRequest = new Request(originalRequest, { headers });
      const retryResponse = await fetch(retryRequest);

      // If still 402, continue loop (for multi-payment scenarios)
      if (retryResponse.status === 402) {
        response = retryResponse;
        continue;
      }

      return retryResponse;
    } catch (error) {
      config.onPaymentFailed?.(error as Error);
      if (attempt === maxRetries - 1) {
        throw error;
      }
    }
  }

  return response;
}
