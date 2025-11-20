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
  AuthorizationConfig,
  PaymentConfig,
  EndpointAuthorizationRule,
} from "./interceptors";

/**
 * Configuration for Sapiom-enabled Node.js HTTP client
 */
export interface SapiomNodeHttpConfig extends BaseSapiomIntegrationConfig {
  /**
   * Authorization configuration
   */
  authorization?: Omit<AuthorizationConfig, "sapiomClient">;

  /**
   * Payment configuration
   */
  payment?: Omit<PaymentConfig, "sapiomClient">;
}

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
 * import { createSapiomNodeHttp } from '@sapiom/node-http';
 *
 * const client = createSapiomNodeHttp();
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
 * // With custom configuration
 * import { createSapiomNodeHttp } from '@sapiom/node-http';
 *
 * const client = createSapiomNodeHttp({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   authorization: {
 *     authorizedEndpoints: [
 *       { pathPattern: /^https:\/\/api\.example\.com\/admin/, serviceName: 'admin-api' }
 *     ],
 *     onAuthorizationPending: (txId, endpoint) => {
 *       console.log(`Awaiting authorization for ${endpoint}`);
 *     }
 *   },
 *   payment: {
 *     onPaymentRequired: (txId, payment) => {
 *       console.log(`Payment needed: ${payment.amount} ${payment.token}`);
 *     }
 *   }
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
 * const client = createSapiomNodeHttp({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service',
 *   traceId: 'trace-123'
 * });
 *
 * // Per-request override via __sapiom property
 * const response = await client.request({
 *   method: 'POST',
 *   url: 'https://api.example.com/resource',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: { data: 'test' },
 *   __sapiom: {
 *     serviceName: 'different-service',  // Overrides default
 *     actionName: 'custom-action',
 *     traceExternalId: 'ext-456'
 *   }
 * });
 *
 * // Supports streams natively
 * import * as fs from 'fs';
 * await client.request({
 *   method: 'POST',
 *   url: 'https://api.example.com/upload',
 *   headers: { 'Content-Type': 'application/octet-stream' },
 *   body: fs.createReadStream('/path/to/file')
 * });
 * ```
 */
export function createSapiomNodeHttp(
  config?: SapiomNodeHttpConfig
): HttpClientAdapter & { __sapiomClient: SapiomClient } {
  const sapiomClient = initializeSapiomClient(config);

  const defaultMetadata: Record<string, any> = {};
  if (config?.agentName) defaultMetadata.agentName = config.agentName;
  if (config?.agentId) defaultMetadata.agentId = config.agentId;
  if (config?.serviceName) defaultMetadata.serviceName = config.serviceName;
  if (config?.traceId) defaultMetadata.traceId = config.traceId;
  if (config?.traceExternalId)
    defaultMetadata.traceExternalId = config.traceExternalId;

  const authConfig: AuthorizationConfig | undefined =
    config?.authorization?.enabled !== false
      ? {
          sapiomClient,
          enabled: true,
          authorizedEndpoints: config?.authorization?.authorizedEndpoints,
          authorizationTimeout: config?.authorization?.authorizationTimeout,
          pollingInterval: config?.authorization?.pollingInterval,
          onAuthorizationPending:
            config?.authorization?.onAuthorizationPending,
          onAuthorizationSuccess:
            config?.authorization?.onAuthorizationSuccess,
          onAuthorizationDenied: config?.authorization?.onAuthorizationDenied,
          throwOnDenied: config?.authorization?.throwOnDenied,
        }
      : undefined;

  const paymentConfig: PaymentConfig | undefined =
    config?.payment?.enabled !== false
      ? {
          sapiomClient,
          enabled: true,
          onPaymentRequired: config?.payment?.onPaymentRequired,
          onPaymentSuccess: config?.payment?.onPaymentSuccess,
          onPaymentFailed: config?.payment?.onPaymentFailed,
          maxRetries: config?.payment?.maxRetries,
          pollingInterval: config?.payment?.pollingInterval,
          authorizationTimeout: config?.payment?.authorizationTimeout,
        }
      : undefined;

  async function makeRequest<T = any>(
    request: HttpRequest
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
        const headers = options.headers as Record<string, string | string[] | undefined>;
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
      let modifiedRequest = request;
      if (authConfig) {
        modifiedRequest = await handleAuthorization(
          request,
          authConfig,
          defaultMetadata
        );
      }

      try {
        const response = await makeRequest<T>(modifiedRequest);
        return response;
      } catch (error) {
        if (
          paymentConfig &&
          (error as HttpError).response?.status === 402
        ) {
          return await handlePayment(
            modifiedRequest,
            error as HttpError,
            paymentConfig,
            makeRequest,
            defaultMetadata
          );
        }
        throw error;
      }
    },

    addRequestInterceptor(onFulfilled, onRejected) {
      throw new Error(
        "addRequestInterceptor is not supported. Use config.authorization instead."
      );
    },

    addResponseInterceptor(onFulfilled, onRejected) {
      throw new Error(
        "addResponseInterceptor is not supported. Use config.payment instead."
      );
    },
  };

  (adapter as any).__sapiomClient = sapiomClient;

  return adapter as HttpClientAdapter & { __sapiomClient: SapiomClient };
}

export type {
  EndpointAuthorizationRule,
  AuthorizationConfig,
  PaymentConfig,
} from "./interceptors";

export {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors";
