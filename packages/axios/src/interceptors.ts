import {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

import {
  SapiomClient,
  TransactionPoller,
  TransactionStatus,
  PaymentTransactionResponse,
  captureUserCallSite,
  extractPaymentData,
  extractResourceFromError,
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
    | ((config: InternalAxiosRequestConfig) => Record<string, any>);
  resourceExtractor?: (config: InternalAxiosRequestConfig) => string;
  metadata?: Record<string, any>;
}

/**
 * Authorization interceptor configuration
 */
export interface AuthorizationInterceptorConfig {
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
 * Payment interceptor configuration
 */
export interface PaymentInterceptorConfig {
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
  config: InternalAxiosRequestConfig,
  rule: EndpointAuthorizationRule
): boolean {
  const method = config.method?.toUpperCase() || "GET";
  const path = config.url || "";

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
  headers: Record<string, any> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return String(value);
    }
  }
  return undefined;
}

/**
 * Helper to set header value (case-insensitive, replaces existing)
 */
function setHeader(
  headers: Record<string, any>,
  name: string,
  value: string
): void {
  // Remove existing header (case-insensitive)
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
  // Set new header
  headers[name] = value;
}

/**
 * Add authorization request interceptor to axios instance
 * Creates Sapiom transactions before requests and waits for authorization
 */
export function addAuthorizationInterceptor(
  axiosInstance: AxiosInstance,
  config: AuthorizationInterceptorConfig
): () => void {
  if (config.enabled === false) {
    return () => {}; // No-op
  }

  const poller = new TransactionPoller(config.sapiomClient, {
    timeout: config.authorizationTimeout ?? 30000,
    pollInterval: config.pollingInterval ?? 1000,
  });

  const interceptorId = axiosInstance.interceptors.request.use(
    async (axiosConfig: InternalAxiosRequestConfig) => {
      // Skip if this is a payment retry
      if ((axiosConfig as any).__is402Retry) {
        return axiosConfig;
      }

      // Check for existing transaction ID and handle it
      const existingTransactionId = getHeader(
        axiosConfig.headers,
        "X-Sapiom-Transaction-Id"
      );

      if (existingTransactionId) {
        const transaction = await config.sapiomClient.transactions.get(
          existingTransactionId
        );
        const endpoint = axiosConfig.url || "";

        switch (transaction.status) {
          case TransactionStatus.AUTHORIZED:
            return axiosConfig;

          case TransactionStatus.PENDING:
          case TransactionStatus.PREPARING: {
            const authResult = await poller.waitForAuthorization(
              existingTransactionId
            );

            if (authResult.status === "authorized") {
              config.onAuthorizationSuccess?.(existingTransactionId, endpoint);
              return axiosConfig;
            } else if (authResult.status === "denied") {
              config.onAuthorizationDenied?.(existingTransactionId, endpoint);
              if (config.throwOnDenied !== false) {
                throw new AuthorizationDeniedError(
                  existingTransactionId,
                  endpoint
                );
              }
              return axiosConfig;
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
            return axiosConfig;

          default:
            throw new Error(
              `Transaction ${existingTransactionId} has unexpected status: ${transaction.status}`
            );
        }
      }

      // Get default metadata from axios instance and merge with request metadata
      const defaultMetadata = (axiosInstance as any).__sapiomDefaultMetadata || {};
      const requestMetadata = (axiosConfig as any).__sapiom || {};
      const userMetadata = { ...defaultMetadata, ...requestMetadata };

      // Skip if explicitly disabled
      if (requestMetadata?.skipAuthorization) {
        return axiosConfig;
      }

      // Determine if should authorize (matches core logic)
      const shouldAuthorize =
        userMetadata || // Always authorize if user provided metadata
        !config.authorizedEndpoints || // Authorize all if no patterns configured
        config.authorizedEndpoints.length === 0 ||
        config.authorizedEndpoints.some((rule) =>
          matchesEndpoint(axiosConfig, rule)
        );

      if (!shouldAuthorize) {
        return axiosConfig;
      }

      // Find matching rule (if any)
      const matchedRule = config.authorizedEndpoints?.find((rule) =>
        matchesEndpoint(axiosConfig, rule)
      );

      const method = axiosConfig.method?.toUpperCase() || "GET";

      // Build full URL (combine baseURL with request URL)
      const buildFullUrl = (config: InternalAxiosRequestConfig): string => {
        const requestUrl = config.url || "";

        // If URL is already absolute, return it
        if (requestUrl.match(/^https?:\/\//)) {
          return requestUrl;
        }

        // Combine baseURL with relative URL
        const baseURL = config.baseURL || "";
        if (!baseURL) {
          return requestUrl;
        }

        // Remove trailing slash from baseURL and leading slash from requestUrl
        const base = baseURL.replace(/\/$/, "");
        const path = requestUrl.replace(/^\//, "");

        return path ? `${base}/${path}` : base;
      };

      const fullUrl = buildFullUrl(axiosConfig);
      const endpoint = axiosConfig.url || "";

      // Build request facts (required by core)
      const callSite = captureUserCallSite();

      // Parse URL
      let urlParsed;
      try {
        const parsed = new URL(fullUrl);
        urlParsed = {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          pathname: parsed.pathname,
          search: parsed.search,
          port: parsed.port ? parseInt(parsed.port) : null,
        };
      } catch {
        // Fallback for relative URLs without baseURL
        urlParsed = {
          protocol: "",
          hostname: "",
          pathname: endpoint,
          search: "",
          port: null,
        };
      }

      // Sanitize headers
      const sanitizedHeaders: Record<string, string> = {};
      if (axiosConfig.headers) {
        Object.entries(axiosConfig.headers as Record<string, any>).forEach(
          ([key, value]) => {
            const lowerKey = key.toLowerCase();
            if (
              !lowerKey.includes("auth") &&
              !lowerKey.includes("key") &&
              !lowerKey.includes("token")
            ) {
              sanitizedHeaders[key] = String(value);
            }
          }
        );
      }

      const requestFacts = {
        method,
        url: fullUrl, // Use full URL including baseURL
        urlParsed,
        headers: sanitizedHeaders,
        hasBody: !!axiosConfig.data,
        bodySizeBytes: axiosConfig.data
          ? JSON.stringify(axiosConfig.data).length
          : undefined,
        contentType: axiosConfig.headers?.["content-type"] as
          | string
          | undefined,
        clientType: "axios" as const,
        callSite,
        timestamp: new Date().toISOString(),
      };

      // Create transaction with request facts
      const transaction = await config.sapiomClient.transactions.create({
        requestFacts: {
          source: "http-client",
          version: "v1",
          sdk: {
            name: "@sapiom/axios",
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
            ? matchedRule.qualifiers(axiosConfig)
            : matchedRule?.qualifiers),
        metadata: {
          ...userMetadata?.metadata,
          ...matchedRule?.metadata,
          preemptiveAuthorization: true,
        },
      });

      // Check for denied or cancelled
      if (
        transaction.status === TransactionStatus.DENIED ||
        transaction.status === TransactionStatus.CANCELLED
      ) {
        config.onAuthorizationDenied?.(transaction.id, endpoint);

        if (config.throwOnDenied !== false) {
          throw new AuthorizationDeniedError(transaction.id, endpoint);
        }

        return axiosConfig;
      }

      // Check immediate authorization
      if (transaction.status === TransactionStatus.AUTHORIZED) {
        config.onAuthorizationSuccess?.(transaction.id, endpoint);

        setHeader(
          axiosConfig.headers,
          "X-Sapiom-Transaction-Id",
          transaction.id
        );

        (axiosConfig as any).__sapiomTransactionId = transaction.id;

        return axiosConfig;
      }

      // Status is PENDING - wait for authorization
      config.onAuthorizationPending?.(transaction.id, endpoint);

      const result = await poller.waitForAuthorization(transaction.id);

      if (result.status === "authorized") {
        config.onAuthorizationSuccess?.(transaction.id, endpoint);

        setHeader(
          axiosConfig.headers,
          "X-Sapiom-Transaction-Id",
          transaction.id
        );

        (axiosConfig as any).__sapiomTransactionId = transaction.id;

        return axiosConfig;
      } else if (result.status === "denied") {
        config.onAuthorizationDenied?.(transaction.id, endpoint);

        if (config.throwOnDenied !== false) {
          throw new AuthorizationDeniedError(transaction.id, endpoint);
        }

        return axiosConfig;
      } else {
        // Timeout
        throw new AuthorizationTimeoutError(
          transaction.id,
          endpoint,
          config.authorizationTimeout ?? 30000
        );
      }
    }
  );

  return () => axiosInstance.interceptors.request.eject(interceptorId);
}

/**
 * Convert AxiosError to HttpError format for core functions
 */
function axiosErrorToHttpError(error: AxiosError): HttpError {
  return {
    message: error.message,
    status: error.response?.status,
    statusText: error.response?.statusText,
    headers: error.response?.headers as Record<string, string>,
    data: error.response?.data,
    request: error.config
      ? {
          method: error.config.method || "GET",
          url: error.config.url || "",
          headers: error.config.headers as Record<string, string>,
          body: error.config.data,
          params: error.config.params,
        }
      : undefined,
    response: error.response
      ? {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers as Record<string, string>,
          data: error.response.data,
        }
      : undefined,
  };
}

/**
 * Add payment response interceptor to axios instance
 * Handles 402 errors by creating transactions and retrying
 */
export function addPaymentInterceptor(
  axiosInstance: AxiosInstance,
  config: PaymentInterceptorConfig
): () => void {
  if (config.enabled === false) {
    return () => {}; // No-op
  }

  const poller = new TransactionPoller(config.sapiomClient, {
    timeout: config.authorizationTimeout ?? 30000,
    pollInterval: config.pollingInterval ?? 1000,
  });

  const interceptorId = axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => response, // Pass through successful responses
    async (error: AxiosError) => {
      // Check if this is a 402 error
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      // Check if we've already retried
      const originalConfig = error.config as InternalAxiosRequestConfig;
      if ((originalConfig as any).__is402Retry) {
        return Promise.reject(error);
      }

      try {
        // Convert axios error to HttpError format
        const httpError = axiosErrorToHttpError(error);

        // Extract payment data using core functions
        const paymentData = extractPaymentData(httpError);
        const resource = extractResourceFromError(httpError);

        if (!paymentData || !resource) {
          return Promise.reject(error);
        }

        // Check for existing transaction ID from request headers or config
        const existingTransactionId =
          getHeader(originalConfig.headers, "X-Sapiom-Transaction-Id") ||
          (originalConfig as any).__sapiomTransactionId;

        // Get default metadata from axios instance and merge with request metadata
        const defaultMetadata = (axiosInstance as any).__sapiomDefaultMetadata || {};
        const requestMetadata = (originalConfig as any).__sapiom || {};
        const userMetadata = { ...defaultMetadata, ...requestMetadata };

        // Create or retrieve transaction
        let transaction;
        if (existingTransactionId) {
          transaction = await config.sapiomClient.transactions.get(
            existingTransactionId
          );

          // If transaction exists but doesn't require payment, reauthorize with payment
          if (
            !transaction.requiresPayment &&
            transaction.status === TransactionStatus.AUTHORIZED
          ) {
            transaction =
              await config.sapiomClient.transactions.reauthorizeWithPayment(
                existingTransactionId,
                paymentData
              );
          }
        } else {
          // Extract service name from resource if not provided
          const extractServiceName = (resource: string): string => {
            try {
              const url = new URL(resource);
              const pathParts = url.pathname.split("/").filter(Boolean);
              return pathParts[0] || "api";
            } catch {
              return "api";
            }
          };

          const serviceName =
            userMetadata?.serviceName || extractServiceName(resource);

          transaction = await config.sapiomClient.transactions.create({
            serviceName,
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
              originalMethod: originalConfig.method || "GET",
              originalUrl: originalConfig.url || "",
            },
          });
        }

        // Check for denied or cancelled transactions
        if (
          transaction.status === TransactionStatus.DENIED ||
          transaction.status === TransactionStatus.CANCELLED
        ) {
          config.onPaymentFailed?.(
            new Error(`Transaction ${transaction.status}: ${transaction.id}`)
          );
          // Return 403 Forbidden for denied/cancelled transactions
          return Promise.reject({
            response: {
              status: 403,
              statusText: "Forbidden",
              data: {
                error: "Payment transaction was denied or cancelled",
                transactionId: transaction.id,
                status: transaction.status,
              },
            },
          });
        }

        // Wait for authorization if needed
        if (transaction.status !== TransactionStatus.AUTHORIZED) {
          if (transaction.requiresPayment && transaction.payment) {
            config.onPaymentRequired?.(transaction.id, transaction.payment);
          }

          const result = await poller.waitForAuthorization(transaction.id);

          if (result.status !== "authorized") {
            config.onPaymentFailed?.(
              new Error(`Payment ${result.status}: ${transaction.id}`)
            );
            // Return 403 for denied/timeout
            return Promise.reject({
              response: {
                status: 403,
                statusText: "Forbidden",
                data: {
                  error: `Payment transaction ${result.status}`,
                  transactionId: transaction.id,
                },
              },
            });
          }

          // Use transaction from polling result
          transaction = result.transaction!;
        }

        // Extract authorization payload
        const authorizationPayload = transaction.payment?.authorizationPayload;

        if (!authorizationPayload) {
          throw new Error(
            `Transaction ${transaction.id} is authorized but missing payment authorization payload`
          );
        }

        // Encode authorization payload for X-PAYMENT header
        // x402 protocol expects: base64(JSON.stringify(authorizationPayload))
        const paymentHeaderValue =
          typeof authorizationPayload === "string"
            ? authorizationPayload // Already encoded
            : Buffer.from(JSON.stringify(authorizationPayload)).toString(
                "base64"
              ); // Encode object

        // Retry original request with X-PAYMENT header
        const retryConfig = {
          ...originalConfig,
          __is402Retry: true,
        } as any;

        setHeader(retryConfig.headers, "X-PAYMENT", paymentHeaderValue);

        const response = await axiosInstance.request(retryConfig);

        // Notify success
        config.onPaymentSuccess?.(transaction.id);

        return response;
      } catch (handlerError) {
        config.onPaymentFailed?.(handlerError as Error);
        return Promise.reject(error); // Return original error
      }
    }
  );

  return () => axiosInstance.interceptors.response.eject(interceptorId);
}
