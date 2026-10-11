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

import type { TransactionPollingConfig } from "@sapiom/core";

/**
 * Authorization interceptor configuration for Axios.
 */
export interface AuthorizationInterceptorConfig {
  sapiomClient: SapiomClient;
  failureMode: FailureMode;
  polling?: TransactionPollingConfig;
}

/**
 * Payment interceptor configuration for Axios.
 */
export interface PaymentInterceptorConfig {
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
 * Case-insensitively retrieves a header value from a record object.
 */
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

/**
 * Case-insensitively sets or overwrites a header in a record object.
 */
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
 * Reads an asynchronous or event-based stream into a single Buffer for request replayability.
 */
async function streamToBuffer(stream: any): Promise<Buffer> {
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: any) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    if (typeof stream.resume === "function") {
      stream.resume();
    }
  });
}

/** Result of converting a request body to a replayable form. */
interface ReplayableBodyResult {
  data: any;
  bodySizeBytes: number | undefined;
  extraHeaders?: Record<string, string>;
}

/**
 * Converts a request body into an immutable or replayable form for 402 payment retries.
 */
async function ensureReplayableBody(
  config: InternalAxiosRequestConfig,
): Promise<ReplayableBodyResult> {
  const data = config.data;

  if (data == null) {
    return { data, bodySizeBytes: undefined };
  }

  if (typeof data === "string") {
    return { data, bodySizeBytes: Buffer.byteLength(data) };
  }

  if (Buffer.isBuffer(data)) {
    return { data, bodySizeBytes: data.length };
  }

  if (data instanceof ArrayBuffer) {
    const buf = Buffer.from(data);
    return { data: buf, bodySizeBytes: buf.length };
  }

  if (ArrayBuffer.isView(data) && !(data instanceof DataView)) {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { data: buf, bodySizeBytes: data.byteLength };
  }

  if (
    typeof URLSearchParams !== "undefined" &&
    data instanceof URLSearchParams
  ) {
    const str = data.toString();
    return { data: str, bodySizeBytes: Buffer.byteLength(str) };
  }

  if (
    typeof data.getHeaders === "function" &&
    typeof data.pipe === "function"
  ) {
    const extraHeaders = data.getHeaders();
    const buf = await streamToBuffer(data);
    return { data: buf, bodySizeBytes: buf.length, extraHeaders };
  }

  if (
    typeof data.pipe === "function" ||
    typeof data[Symbol.asyncIterator] === "function"
  ) {
    const bodyFactory = (config as any).__sapiom?.bodyFactory;
    if (bodyFactory) {
      return { data, bodySizeBytes: undefined };
    }
    console.warn(
      "[Sapiom] Buffering stream body into memory for 402 retry support. To avoid this, provide a bodyFactory in __sapiom config.",
    );
    const buf = await streamToBuffer(data);
    return { data: buf, bodySizeBytes: buf.length };
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const buf = Buffer.from(await data.arrayBuffer());
    return { data, bodySizeBytes: buf.length };
  }

  try {
    const json = JSON.stringify(data);
    return { data, bodySizeBytes: Buffer.byteLength(json) };
  } catch {
    return { data, bodySizeBytes: undefined };
  }
}

/**
 * Attaches the preemptive authorization request interceptor to an Axios instance.
 */
export function addAuthorizationInterceptor(
  axiosInstance: AxiosInstance,
  config: AuthorizationInterceptorConfig,
): () => void {
  const polling = { ...DEFAULT_POLLING, ...config.polling };
  const poller = new TransactionPoller(config.sapiomClient, polling);

  const interceptorId = axiosInstance.interceptors.request.use(
    async (axiosConfig: InternalAxiosRequestConfig) => {
      if ((axiosConfig as any).__is402Retry) {
        return axiosConfig;
      }

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
                polling.timeout,
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

      const sanitizedHeaders = sanitizeHeaders(
        axiosConfig.headers as Record<string, any> | undefined,
      );

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
          polling.timeout,
        );
      }
    },
  );

  return () => axiosInstance.interceptors.request.eject(interceptorId);
}

/**
 * Transforms an AxiosError into an internal HttpError facts structure.
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
 * Attaches the 402 payment retry interceptor to an Axios instance.
 */
export function addPaymentInterceptor(
  axiosInstance: AxiosInstance,
  config: PaymentInterceptorConfig,
): () => void {
  const polling = { ...DEFAULT_POLLING, ...config.polling };
  const poller = new TransactionPoller(config.sapiomClient, polling);

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
      const x402Response = extractX402Response(httpError);
      const resource = extractResourceFromError(httpError);

      if (!x402Response || !resource) {
        return Promise.reject(error);
      }

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
                    responseHeaders: sanitizeHeaders(
                      error.response?.headers as
                        | Record<string, any>
                        | undefined,
                    ),
                    httpStatusCode: 402,
                  },
                },
              );
          }
        } catch (apiError) {
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
                responseHeaders: sanitizeHeaders(
                  error.response?.headers as Record<string, any> | undefined,
                ),
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
        (originalConfig as any).__sapiomPaymentHandling = false;
        return Promise.reject(error);
      }

      if (transaction.status !== TransactionStatus.AUTHORIZED) {
        let result;
        try {
          result = await poller.waitForAuthorization(transaction.id);
        } catch (pollError) {
          (originalConfig as any).__sapiomPaymentHandling = false;
          if (config.failureMode === "closed") return Promise.reject(pollError);
          console.error(
            "[Sapiom] Failed to poll payment transaction, returning 402:",
            pollError,
          );
          return Promise.reject(error);
        }

        if (result.status !== "authorized") {
          (originalConfig as any).__sapiomPaymentHandling = false;
          return Promise.reject(error);
        }

        transaction = result.transaction!;
      }

      const authorizationPayload = transaction.payment?.authorizationPayload;

      if (!authorizationPayload) {
        (originalConfig as any).__sapiomPaymentHandling = false;
        const payloadError = new Error(
          `Transaction ${transaction.id} is authorized but missing payment authorization payload`,
        );

        // Terminal failure: completion interceptor already skipped the initial 402,
        // so we must complete the transaction explicitly as error to avoid leaving it pending.
        const startTime =
          (originalConfig as any).__sapiomStartTime || Date.now();
        const durationMs = Date.now() - startTime;
        config.sapiomClient.transactions
          .complete(transaction.id, {
            outcome: "error",
            responseFacts: {
              source: "http-client",
              version: "v1",
              facts: {
                errorType: "PaymentAuthorizationError",
                errorMessage: payloadError.message,
                httpStatus: 402,
                httpStatusText: error.response?.statusText,
                isNetworkError: false,
                isTimeout: false,
                elapsedMs: durationMs,
              },
            },
          })
          .catch((err) => {
            console.error("[Sapiom] Failed to complete transaction:", err);
          });

        if (config.failureMode === "closed") throw payloadError;
        console.error(
          "[Sapiom] Authorized transaction is missing payment authorization payload, returning 402:",
          payloadError,
        );
        return Promise.reject(error);
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
        __sapiomPaymentHandling: false,
        ...(bodyFactory ? { data: bodyFactory() } : {}),
      } as any;

      const headerName = getPaymentHeaderName(authorizationPayload);
      setHeader(retryConfig.headers, headerName, paymentHeaderValue);

      const response = await axiosInstance.request(retryConfig);
      return response;
    },
  );

  return () => axiosInstance.interceptors.response.eject(interceptorId);
}

/**
 * Completion interceptor configuration for Axios.
 */
export interface CompletionInterceptorConfig {
  sapiomClient: SapiomClient;
}

/**
 * Attaches the transaction completion observer to an Axios instance.
 */
export function addCompletionInterceptor(
  axiosInstance: AxiosInstance,
  config: CompletionInterceptorConfig,
): () => void {
  const interceptorId = axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => {
      const axiosConfig = response.config as InternalAxiosRequestConfig;

      if ((axiosConfig as any).__sapiomPaymentHandling) {
        return response;
      }

      const transactionId =
        getHeader(axiosConfig.headers, "X-Sapiom-Transaction-Id") ||
        (axiosConfig as any).__sapiomTransactionId;

      if (transactionId) {
        const startTime = (axiosConfig as any).__sapiomStartTime || Date.now();
        const durationMs = Date.now() - startTime;

        const sanitizedHeaders = sanitizeHeaders(
          response.headers as Record<string, any> | undefined,
        );

        const facts: HttpClientResponseFacts = {
          status: response.status,
          statusText: response.statusText,
          headers: sanitizedHeaders,
          contentType: response.headers?.["content-type"] as string | undefined,
          durationMs,
        };

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

      if (error.response?.status === 402) {
        return Promise.reject(error);
      }

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
