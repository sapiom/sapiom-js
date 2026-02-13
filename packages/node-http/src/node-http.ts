import * as http from "http";
import * as https from "https";
import {
  SapiomClient,
  HttpClientAdapter,
  HttpRequest,
  HttpResponse,
  HttpError,
} from "@sapiom/core";
import {
  BaseSapiomIntegrationConfig,
  initializeSapiomClient,
} from "@sapiom/core";
import {
  handleAuthorization,
  handlePayment,
  handleCompletion,
  AuthorizationConfig,
  PaymentConfig,
  CompletionConfig,
} from "./interceptors.js";

/**
 * Configuration for Sapiom-enabled Node.js HTTP client
 */
export interface SapiomNodeHttpConfig extends BaseSapiomIntegrationConfig {}

/**
 * Creates a Sapiom-enabled Node.js HTTP client with automatic authorization and payment handling
 *
 * This creates a native HTTP client using Node.js's http/https modules with:
 * - Pre-emptive authorization (request pre-processing)
 * - Reactive payment handling (response error handling for 402)
 *
 * Works directly with Node.js native types, supporting streams, buffers, and all body types.
 *
 * @param config - Optional configuration (reads from env vars by default)
 * @returns A Sapiom-enabled HttpClientAdapter
 *
 * @example
 * ```typescript
 * // Simplest usage (reads SAPIOM_API_KEY from environment)
 * import { createClient } from '@sapiom/node-http';
 *
 * const client = createClient();
 *
 * // Auto-handles 402 payment errors and authorization
 * const response = await client.request({
 *   method: 'GET',
 *   url: 'https://api.example.com/premium-endpoint',
 *   headers: { 'Content-Type': 'application/json' }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With API key and default metadata
 * import { createClient } from '@sapiom/node-http';
 *
 * const client = createClient({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service'
 * });
 *
 * const response = await client.request({
 *   method: 'POST',
 *   url: 'https://api.example.com/data',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: { key: 'value' }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With default metadata (applied to all requests)
 * import { createClient } from '@sapiom/node-http';
 *
 * const client = createClient({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service'
 * });
 *
 * // Per-request override via __sapiom property
 * await client.request({
 *   method: 'POST',
 *   url: 'https://api.example.com/resource',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: { data: 'test' },
 *   __sapiom: {
 *     serviceName: 'different-service',
 *     actionName: 'custom-action'
 *   }
 * });
 *
 * // Disable Sapiom for specific request
 * await client.request({
 *   method: 'GET',
 *   url: 'https://api.example.com/public',
 *   headers: {},
 *   __sapiom: { enabled: false }
 * });
 * ```
 */
export function createClient(
  config?: SapiomNodeHttpConfig,
): HttpClientAdapter & { __sapiomClient: SapiomClient } {
  const sapiomClient = initializeSapiomClient(config);
  const isEnabled = config?.enabled !== false;

  const defaultMetadata: Record<string, any> = {};
  if (config?.agentName) defaultMetadata.agentName = config.agentName;
  if (config?.agentId) defaultMetadata.agentId = config.agentId;
  if (config?.serviceName) defaultMetadata.serviceName = config.serviceName;
  if (config?.traceId) defaultMetadata.traceId = config.traceId;
  if (config?.traceExternalId)
    defaultMetadata.traceExternalId = config.traceExternalId;
  if (config?.enabled !== undefined) defaultMetadata.enabled = config.enabled;

  const failureMode = config?.failureMode ?? "open";

  const authConfig: AuthorizationConfig = { sapiomClient, failureMode };
  const paymentConfig: PaymentConfig = { sapiomClient, failureMode };
  const completionConfig: CompletionConfig = { sapiomClient };

  async function makeRequest<T = any>(
    request: HttpRequest,
  ): Promise<HttpResponse<T>> {
    return new Promise<HttpResponse<T>>((resolve, reject) => {
      const parsedUrl = new URL(request.url);
      const isHttps = parsedUrl.protocol === "https:";
      const client = isHttps ? https : http;

      let bodyData: string | Buffer | undefined;
      if (request.body !== undefined && request.body !== null) {
        if (typeof request.body === "string") {
          bodyData = request.body;
        } else if (Buffer.isBuffer(request.body)) {
          bodyData = request.body;
        } else if (typeof request.body === "object") {
          bodyData = JSON.stringify(request.body);
        }
      }

      const options: http.RequestOptions = {
        method: request.method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { ...request.headers },
      };

      if (bodyData && options.headers) {
        const headers = options.headers as Record<
          string,
          string | string[] | undefined
        >;
        if (!headers["Content-Length"]) {
          headers["Content-Length"] = Buffer.byteLength(bodyData).toString();
        }
      }

      const req = client.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });

        res.on("end", () => {
          let parsedData: T;
          const contentType = res.headers["content-type"] || "";

          if (contentType.includes("application/json") && data) {
            try {
              parsedData = JSON.parse(data);
            } catch {
              parsedData = data as any;
            }
          } else {
            parsedData = data as any;
          }

          const response: HttpResponse<T> = {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "OK",
            headers: res.headers as Record<string, string>,
            data: parsedData,
          };

          if (res.statusCode === 402) {
            const error: HttpError = {
              message: "Payment required",
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
              data: response.data,
              response,
            };
            reject(error);
          } else {
            resolve(response);
          }
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      if (bodyData) {
        req.write(bodyData);
      }

      req.end();
    });
  }

  const adapter: HttpClientAdapter = {
    async request<T = any>(request: HttpRequest): Promise<HttpResponse<T>> {
      const requestMetadata = request.__sapiom || {};
      const userMetadata = { ...defaultMetadata, ...requestMetadata };

      if (!isEnabled || userMetadata?.enabled === false) {
        return makeRequest<T>(request);
      }

      // Normalize request to ensure headers is always defined
      const normalizedRequest = { ...request, headers: request.headers || {} };

      const modifiedRequest = await handleAuthorization(
        normalizedRequest,
        authConfig,
        defaultMetadata,
      );

      const startTime = Date.now();
      let response: HttpResponse<T> | null = null;
      let error: Error | HttpError | null = null;

      try {
        response = await makeRequest<T>(modifiedRequest);
        return response;
      } catch (err) {
        error = err as Error | HttpError;
        if ((error as HttpError).response?.status === 402) {
          response = await handlePayment(
            modifiedRequest,
            error as HttpError,
            paymentConfig,
            makeRequest,
            defaultMetadata,
          );
          error = null; // Clear error since payment succeeded
          return response;
        }
        throw err;
      } finally {
        // Fire-and-forget: complete the transaction
        handleCompletion(
          modifiedRequest,
          response,
          error,
          completionConfig,
          startTime,
        );
      }
    },

    addRequestInterceptor(onFulfilled, onRejected) {
      throw new Error("addRequestInterceptor is not supported");
    },

    addResponseInterceptor(onFulfilled, onRejected) {
      throw new Error("addResponseInterceptor is not supported");
    },
  };

  (adapter as any).__sapiomClient = sapiomClient;

  return adapter as HttpClientAdapter & { __sapiomClient: SapiomClient };
}

export {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors.js";
