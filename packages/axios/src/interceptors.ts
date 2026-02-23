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
 * Reads a stream into a Buffer. Handles two stream flavors:
 * - Async iterables (Node.js Readable in modern Node)
 * - Pipe-based streams (e.g. form-data's CombinedStream which lacks Symbol.asyncIterator)
 */
async function streamToBuffer(stream: any): Promise<Buffer> {
  // Async iterable (Node.js Readable in modern Node, ReadableStream adapters)
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Pipe-based stream (e.g. form-data's CombinedStream)
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: any) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    // CombinedStream (used by form-data) doesn't auto-flow on data listener —
    // it needs resume() to start emitting
    if (typeof stream.resume === "function") {
      stream.resume();
    }
  });
}

/** Result of converting a request body to a replayable form. */
interface ReplayableBodyResult {
  /** The (possibly converted) body data to use for the request. */
  data: any;
  /** Byte size of the body, or undefined if not determinable. */
  bodySizeBytes: number | undefined;
  /** Headers captured from the original body (e.g. content-type from FormData). */
  extraHeaders?: Record<string, string>;
}

/**
 * Converts the request body to a form that can be replayed on 402 retry.
 *
 * Streams and FormData (form-data package) are buffered into memory so they
 * can be re-sent. If a `bodyFactory` is provided via `__sapiom` config, the
 * stream is left as-is and a fresh body is created on retry instead.
 *
 * Also computes `bodySizeBytes` for request facts, replacing the previous
 * `JSON.stringify(data).length` which was incorrect for non-JSON bodies.
 */
async function ensureReplayableBody(
  config: InternalAxiosRequestConfig,
): Promise<ReplayableBodyResult> {
  const data = config.data;

  // null/undefined — pass through
  if (data == null) {
    return { data, bodySizeBytes: undefined };
  }

  // string
  if (typeof data === "string") {
    return { data, bodySizeBytes: Buffer.byteLength(data) };
  }

  // Buffer
  if (Buffer.isBuffer(data)) {
    return { data, bodySizeBytes: data.length };
  }

  // ArrayBuffer
  if (data instanceof ArrayBuffer) {
    const buf = Buffer.from(data);
    return { data: buf, bodySizeBytes: buf.length };
  }

  // TypedArray (e.g. Uint8Array)
  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { data: buf, bodySizeBytes: data.byteLength };
  }

  // URLSearchParams
  if (
    typeof URLSearchParams !== "undefined" &&
    data instanceof URLSearchParams
  ) {
    const str = data.toString();
    return { data: str, bodySizeBytes: Buffer.byteLength(str) };
  }

  // FormData (form-data package): has both getHeaders() and pipe()
  if (
    typeof data.getHeaders === "function" &&
    typeof data.pipe === "function"
  ) {
    const extraHeaders = data.getHeaders();
    const buf = await streamToBuffer(data);
    return { data: buf, bodySizeBytes: buf.length, extraHeaders };
  }

  // Node.js Readable stream or async iterable
  if (
    typeof data.pipe === "function" ||
    typeof data[Symbol.asyncIterator] === "function"
  ) {
    const bodyFactory = (config as any).__sapiom?.bodyFactory;
    if (bodyFactory) {
      // Leave data as-is; on retry, bodyFactory() will produce a fresh stream
      return { data, bodySizeBytes: undefined };
    }
    // Auto-buffer with warning
    console.warn(
      "[Sapiom] Buffering stream body into memory for 402 retry support. To avoid this, provide a bodyFactory in __sapiom config.",
    );
    const buf = await streamToBuffer(data);
    return { data: buf, bodySizeBytes: buf.length };
  }

  // Blob
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const buf = Buffer.from(await data.arrayBuffer());
    return { data: buf, bodySizeBytes: buf.length };
  }

  // Plain object or other JSON-serializable value
  try {
    const json = JSON.stringify(data);
    return { data, bodySizeBytes: Buffer.byteLength(json) };
  } catch {
    return { data, bodySizeBytes: undefined };
  }
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

      // Ensure request body is replayable for 402 retry
      let replayableBody: ReplayableBodyResult;
      try {
        replayableBody = await ensureReplayableBody(axiosConfig);
        axiosConfig.data = replayableBody.data;
        if (replayableBody.extraHeaders) {
          for (const [key, value] of Object.entries(
            replayableBody.extraHeaders,
          )) {
            if (!getHeader(axiosConfig.headers, key)) {
              setHeader(axiosConfig.headers, key, value);
            }
          }
        }
      } catch (bufferError) {
        // If buffering fails, continue with original data (no worse than current behavior)
        replayableBody = { data: axiosConfig.data, bodySizeBytes: undefined };
        console.error("[Sapiom] Failed to buffer request body:", bufferError);
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
        bodySizeBytes: replayableBody.bodySizeBytes,
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

      const bodyFactory = (originalConfig as any).__sapiom?.bodyFactory;

      const retryConfig = {
        ...originalConfig,
        __is402Retry: true,
        __sapiomPaymentHandling: false, // Allow completion on retry
        // If bodyFactory exists, call it for a fresh body
        ...(bodyFactory ? { data: bodyFactory() } : {}),
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
