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
  captureUserCallSite,
  extractX402Response,
  extractResourceFromError,
  HttpError,
  HttpClientRequestFacts,
  HttpClientResponseFacts,
  HttpClientErrorFacts,
  FailureMode,
} from "@sapiom/core";

/**
 * Authorization interceptor configuration
 */
export interface AuthorizationInterceptorConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
}

/**
 * Payment interceptor configuration
 */
export interface PaymentInterceptorConfig {
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
  headers: Record<string, any> | undefined,
  name: string,
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

function setHeader(
  headers: Record<string, any>,
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
 * Get the correct payment header name based on x402 version
 * V1: X-PAYMENT, V2: PAYMENT-SIGNATURE
 */
function getPaymentHeaderName(payload: any): string {
  if (payload?.x402Version === 2) {
    return "PAYMENT-SIGNATURE";
  }
  return "X-PAYMENT";
}

/**
 * Add authorization request interceptor to axios instance
 */
export function addAuthorizationInterceptor(
  axiosInstance: AxiosInstance,
  config: AuthorizationInterceptorConfig,
): () => void {
  const poller = new TransactionPoller(config.sapiomClient, {
    timeout: AUTHORIZATION_TIMEOUT,
    pollInterval: POLL_INTERVAL,
  });

  const interceptorId = axiosInstance.interceptors.request.use(
    async (axiosConfig: InternalAxiosRequestConfig) => {
      if ((axiosConfig as any).__is402Retry) {
        return axiosConfig;
      }

      const existingTransactionId = getHeader(
        axiosConfig.headers,
        "X-Sapiom-Transaction-Id",
      );

      if (existingTransactionId) {
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
          return axiosConfig;
        }

        switch (transaction.status) {
          case TransactionStatus.AUTHORIZED:
            return axiosConfig;

          case TransactionStatus.PENDING:
          case TransactionStatus.PREPARING: {
            let authResult;
            try {
              authResult = await poller.waitForAuthorization(
                existingTransactionId,
              );
            } catch (error) {
              if (config.failureMode === "closed") throw error;
              console.error(
                "[Sapiom] Failed to poll transaction, allowing request:",
                error,
              );
              return axiosConfig;
            }

            if (authResult.status === "authorized") {
              return axiosConfig;
            } else if (authResult.status === "denied") {
              throw new AuthorizationDeniedError(
                existingTransactionId,
                axiosConfig.url || "",
              );
            } else {
              throw new AuthorizationTimeoutError(
                existingTransactionId,
                axiosConfig.url || "",
                AUTHORIZATION_TIMEOUT,
              );
            }
          }

          case TransactionStatus.DENIED:
          case TransactionStatus.CANCELLED:
            throw new AuthorizationDeniedError(
              existingTransactionId,
              axiosConfig.url || "",
            );

          default:
            throw new Error(
              `Transaction ${existingTransactionId} has unexpected status: ${transaction.status}`,
            );
        }
      }

      const defaultMetadata =
        (axiosInstance as any).__sapiomDefaultMetadata || {};
      const requestMetadata = (axiosConfig as any).__sapiom || {};
      const userMetadata = { ...defaultMetadata, ...requestMetadata };

      if (userMetadata?.enabled === false) {
        return axiosConfig;
      }

      const method = axiosConfig.method?.toUpperCase() || "GET";

      const buildFullUrl = (config: InternalAxiosRequestConfig): string => {
        const requestUrl = config.url || "";

        if (requestUrl.match(/^https?:\/\//)) {
          return requestUrl;
        }

        const baseURL = config.baseURL || "";
        if (!baseURL) {
          return requestUrl;
        }

        const base = baseURL.replace(/\/$/, "");
        const path = requestUrl.replace(/^\//, "");

        return path ? `${base}/${path}` : base;
      };

      const fullUrl = buildFullUrl(axiosConfig);
      const endpoint = axiosConfig.url || "";

      const callSite = captureUserCallSite();

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
        urlParsed = {
          protocol: "",
          hostname: "",
          pathname: endpoint,
          search: "",
          port: null,
        };
      }

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
          },
        );
      }

      const requestFacts: HttpClientRequestFacts = {
        method,
        url: fullUrl,
        urlParsed,
        headers: sanitizedHeaders,
        hasBody: !!axiosConfig.data,
        bodySizeBytes: axiosConfig.data
          ? JSON.stringify(axiosConfig.data).length
          : undefined,
        contentType: axiosConfig.headers?.["content-type"] as
          | string
          | undefined,
        clientType: "axios",
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
              name: "@sapiom/axios",
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
        return axiosConfig;
      }

      if (
        transaction.status === TransactionStatus.DENIED ||
        transaction.status === TransactionStatus.CANCELLED
      ) {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      }

      if (transaction.status === TransactionStatus.AUTHORIZED) {
        setHeader(
          axiosConfig.headers,
          "X-Sapiom-Transaction-Id",
          transaction.id,
        );

        (axiosConfig as any).__sapiomTransactionId = transaction.id;
        (axiosConfig as any).__sapiomStartTime = Date.now();

        return axiosConfig;
      }

      let result;
      try {
        result = await poller.waitForAuthorization(transaction.id);
      } catch (error) {
        if (config.failureMode === "closed") throw error;
        console.error(
          "[Sapiom] Failed to poll transaction, allowing request:",
          error,
        );
        return axiosConfig;
      }

      if (result.status === "authorized") {
        setHeader(
          axiosConfig.headers,
          "X-Sapiom-Transaction-Id",
          transaction.id,
        );

        (axiosConfig as any).__sapiomTransactionId = transaction.id;
        (axiosConfig as any).__sapiomStartTime = Date.now();

        return axiosConfig;
      } else if (result.status === "denied") {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      } else {
        throw new AuthorizationTimeoutError(
          transaction.id,
          endpoint,
          AUTHORIZATION_TIMEOUT,
        );
      }
    },
  );

  return () => axiosInstance.interceptors.request.eject(interceptorId);
}

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
 */
export function addPaymentInterceptor(
  axiosInstance: AxiosInstance,
  config: PaymentInterceptorConfig,
): () => void {
  const poller = new TransactionPoller(config.sapiomClient, {
    timeout: AUTHORIZATION_TIMEOUT,
    pollInterval: POLL_INTERVAL,
  });

  const interceptorId = axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => response,
    async (error: AxiosError) => {
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      const originalConfig = error.config as InternalAxiosRequestConfig;
      if ((originalConfig as any).__is402Retry) {
        return Promise.reject(error);
      }

      const defaultMetadata =
        (axiosInstance as any).__sapiomDefaultMetadata || {};
      const requestMetadata = (originalConfig as any).__sapiom || {};
      const userMetadata = { ...defaultMetadata, ...requestMetadata };

      if (userMetadata?.enabled === false) {
        return Promise.reject(error);
      }

      const httpError = axiosErrorToHttpError(error);

      // Extract raw x402 response (no pre-processing)
      const x402Response = extractX402Response(httpError);
      const resource = extractResourceFromError(httpError);

      if (!x402Response || !resource) {
        return Promise.reject(error);
      }

      // Mark the original request as being handled by payment flow
      // This prevents the completion interceptor from firing on the original request
      // when the retry succeeds. If payment fails, we'll clear this flag.
      (originalConfig as any).__sapiomPaymentHandling = true;

      const existingTransactionId =
        getHeader(originalConfig.headers, "X-Sapiom-Transaction-Id") ||
        (originalConfig as any).__sapiomTransactionId;

      let transaction;
      if (existingTransactionId) {
        try {
          transaction = await config.sapiomClient.transactions.get(
            existingTransactionId,
          );

          if (
            !transaction.requiresPayment &&
            transaction.status === TransactionStatus.AUTHORIZED
          ) {
            transaction =
              await config.sapiomClient.transactions.reauthorizeWithPayment(
                existingTransactionId,
                {
                  x402: x402Response,
                  metadata: {
                    originalRequest: {
                      url: originalConfig.url,
                      method: originalConfig.method,
                    },
                    responseHeaders: error.response?.headers,
                    httpStatusCode: 402,
                  },
                },
              );
          }
        } catch (apiError) {
          // Clear payment handling flag so completion interceptor fires
          (originalConfig as any).__sapiomPaymentHandling = false;
          if (config.failureMode === "closed") return Promise.reject(apiError);
          console.error(
            "[Sapiom] Failed to get/reauthorize transaction, returning 402:",
            apiError,
          );
          return Promise.reject(error);
        }
      } else {
        try {
          transaction = await config.sapiomClient.transactions.create({
            serviceName: userMetadata?.serviceName,
            actionName: userMetadata?.actionName,
            resourceName: userMetadata?.resourceName,
            paymentData: {
              x402: x402Response,
              metadata: {
                originalRequest: {
                  url: originalConfig.url,
                  method: originalConfig.method,
                },
                responseHeaders: error.response?.headers,
                httpStatusCode: 402,
              },
            },
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
        } catch (apiError) {
          // Clear payment handling flag so completion interceptor fires
          (originalConfig as any).__sapiomPaymentHandling = false;
          if (config.failureMode === "closed") return Promise.reject(apiError);
          console.error(
            "[Sapiom] Failed to create payment transaction, returning 402:",
            apiError,
          );
          return Promise.reject(error);
        }
      }

      if (
        transaction.status === TransactionStatus.DENIED ||
        transaction.status === TransactionStatus.CANCELLED
      ) {
        // Clear payment handling flag so completion interceptor fires
        (originalConfig as any).__sapiomPaymentHandling = false;
        return Promise.reject(error); // Return original 402 error for completion
      }

      if (transaction.status !== TransactionStatus.AUTHORIZED) {
        let result;
        try {
          result = await poller.waitForAuthorization(transaction.id);
        } catch (pollError) {
          // Clear payment handling flag so completion interceptor fires
          (originalConfig as any).__sapiomPaymentHandling = false;
          if (config.failureMode === "closed") return Promise.reject(pollError);
          console.error(
            "[Sapiom] Failed to poll payment transaction, returning 402:",
            pollError,
          );
          return Promise.reject(error);
        }

        if (result.status !== "authorized") {
          // Clear payment handling flag so completion interceptor fires
          (originalConfig as any).__sapiomPaymentHandling = false;
          return Promise.reject(error); // Return original 402 error for completion
        }

        transaction = result.transaction!;
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
          : Buffer.from(JSON.stringify(authorizationPayload)).toString(
              "base64",
            );

      const retryConfig = {
        ...originalConfig,
        __is402Retry: true,
        __sapiomPaymentHandling: false, // Allow completion on retry
      } as any;

      // Select header name based on x402 version (V1: X-PAYMENT, V2: PAYMENT-SIGNATURE)
      const headerName = getPaymentHeaderName(authorizationPayload);
      setHeader(retryConfig.headers, headerName, paymentHeaderValue);

      const response = await axiosInstance.request(retryConfig);

      return response;
    },
  );

  return () => axiosInstance.interceptors.response.eject(interceptorId);
}

/**
 * Completion interceptor configuration
 */
export interface CompletionInterceptorConfig {
  sapiomClient: SapiomClient;
}

/**
 * Add completion response interceptor to axios instance
 *
 * This interceptor fires-and-forgets a transaction completion after each request.
 */
export function addCompletionInterceptor(
  axiosInstance: AxiosInstance,
  config: CompletionInterceptorConfig,
): () => void {
  const interceptorId = axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => {
      const axiosConfig = response.config as InternalAxiosRequestConfig;

      // Skip if this is the original request that triggered payment flow
      // The retry request will handle completion instead
      if ((axiosConfig as any).__sapiomPaymentHandling) {
        return response;
      }

      const transactionId =
        getHeader(axiosConfig.headers, "X-Sapiom-Transaction-Id") ||
        (axiosConfig as any).__sapiomTransactionId;

      if (transactionId) {
        const startTime = (axiosConfig as any).__sapiomStartTime || Date.now();
        const durationMs = Date.now() - startTime;

        const sanitizedHeaders: Record<string, string> = {};
        const sensitiveHeaders = new Set([
          "set-cookie",
          "authorization",
          "x-api-key",
        ]);
        if (response.headers) {
          Object.entries(response.headers as Record<string, any>).forEach(
            ([key, value]) => {
              if (!sensitiveHeaders.has(key.toLowerCase())) {
                sanitizedHeaders[key] = String(value);
              }
            },
          );
        }

        const facts: HttpClientResponseFacts = {
          status: response.status,
          statusText: response.statusText,
          headers: sanitizedHeaders,
          contentType: response.headers?.["content-type"] as string | undefined,
          durationMs,
        };

        // Fire-and-forget
        config.sapiomClient.transactions
          .complete(transactionId, {
            outcome: "success",
            responseFacts: {
              source: "http-client",
              version: "v1",
              facts,
            },
          })
          .catch((err) => {
            console.error("[Sapiom] Failed to complete transaction:", err);
          });
      }

      return response;
    },
    async (error: AxiosError) => {
      const originalConfig = error.config as InternalAxiosRequestConfig;

      // Skip 402 errors - they will be handled by the payment interceptor
      // which may retry the request. Completion will happen on the retry result.
      if (error.response?.status === 402) {
        return Promise.reject(error);
      }

      // Skip if this is the original request that triggered payment flow
      // The retry request will handle completion instead
      if ((originalConfig as any)?.__sapiomPaymentHandling) {
        return Promise.reject(error);
      }

      const transactionId = originalConfig
        ? getHeader(originalConfig.headers, "X-Sapiom-Transaction-Id") ||
          (originalConfig as any).__sapiomTransactionId
        : undefined;

      if (transactionId) {
        const startTime =
          (originalConfig as any).__sapiomStartTime || Date.now();
        const durationMs = Date.now() - startTime;

        const facts: HttpClientErrorFacts = {
          errorType: error.name || "AxiosError",
          errorMessage: error.message,
          httpStatus: error.response?.status,
          httpStatusText: error.response?.statusText,
          isNetworkError: !error.response,
          isTimeout:
            error.code === "ECONNABORTED" || error.code === "ETIMEDOUT",
          elapsedMs: durationMs,
        };

        // Fire-and-forget
        config.sapiomClient.transactions
          .complete(transactionId, {
            outcome: "error",
            responseFacts: {
              source: "http-client",
              version: "v1",
              facts,
            },
          })
          .catch((err) => {
            console.error("[Sapiom] Failed to complete transaction:", err);
          });
      }

      return Promise.reject(error);
    },
  );

  return () => axiosInstance.interceptors.response.eject(interceptorId);
}
