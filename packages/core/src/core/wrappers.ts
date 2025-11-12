import { HttpClientAdapter, HttpError } from "../http/types";
import {
  AuthorizationHandler,
  AuthorizationHandlerConfig,
} from "./AuthorizationHandler";
import { PaymentHandler, PaymentHandlerConfig } from "./PaymentHandler";

/**
 * Adds payment handling to any HTTP client adapter
 *
 * This function wraps an HttpClientAdapter to automatically handle 402 payment errors.
 * When a 402 error is received, it:
 * 1. Creates a Sapiom transaction
 * 2. Waits for payment authorization
 * 3. Retries the request with X-PAYMENT header
 *
 * @param httpClient The HTTP client adapter to wrap
 * @param config Payment handler configuration
 * @returns The same adapter instance (modified in place)
 *
 * @example
 * ```typescript
 * import { createAxiosAdapter, withPaymentHandling, SapiomClient } from '@sapiom/sdk';
 * import axios from 'axios';
 *
 * const sapiom = new SapiomClient({ apiKey: process.env.SAPIOM_API_KEY! });
 * const axiosInstance = axios.create();
 * const adapter = createAxiosAdapter(axiosInstance);
 *
 * withPaymentHandling(adapter, {
 *   sapiomClient: sapiom,
 *   onPaymentRequired: (txId, payment) => {
 *     console.log(`Payment: ${payment.amount} ${payment.token}`);
 *   },
 * });
 *
 * // Now 402 errors are handled automatically
 * const response = await axiosInstance.get('/premium-data');
 * ```
 */
export function withPaymentHandling(
  httpClient: HttpClientAdapter,
  config: PaymentHandlerConfig,
): HttpClientAdapter {
  const handler = new PaymentHandler(config);

  // Add response interceptor to catch 402 errors
  httpClient.addResponseInterceptor(
    // Success handler - pass through
    (response) => response,

    // Error handler - check for 402 and handle payment
    async (error: HttpError) => {
      // Create a function that can re-execute the request
      const requestExecutor = async (request: any) => {
        return await httpClient.request(request);
      };

      // Try to handle the payment error
      const result = await handler.handlePaymentError(
        error,
        error.request || {
          method: "GET",
          url: "",
          headers: {},
        },
        requestExecutor,
      );

      // If handled successfully, return the new response
      if (result) {
        return result;
      }

      // If handler returned null (cannot handle), re-throw original error
      throw error;
    },
  );

  return httpClient;
}

/**
 * Adds authorization handling to any HTTP client adapter
 *
 * This function wraps an HttpClientAdapter to automatically handle authorization.
 * Before each request, it:
 * 1. Creates a Sapiom transaction for authorization
 * 2. Waits for authorization approval
 * 3. Adds X-Sapiom-Transaction-Id header to request
 *
 * @param httpClient The HTTP client adapter to wrap
 * @param config Authorization handler configuration
 * @returns The same adapter instance (modified in place)
 *
 * @example
 * ```typescript
 * import { createAxiosAdapter, withAuthorizationHandling, SapiomClient } from '@sapiom/sdk';
 * import axios from 'axios';
 *
 * const sapiom = new SapiomClient({ apiKey: process.env.SAPIOM_API_KEY! });
 * const axiosInstance = axios.create();
 * const adapter = createAxiosAdapter(axiosInstance);
 *
 * withAuthorizationHandling(adapter, {
 *   sapiomClient: sapiom,
 *   authorizedEndpoints: [
 *     {
 *       pathPattern: /^\/api\/admin\//,
 *       serviceName: 'admin-api',
 *     },
 *   ],
 *   onAuthorizationPending: (txId, endpoint) => {
 *     console.log(`Authorization required: ${endpoint} (${txId})`);
 *   },
 * });
 *
 * // Admin endpoints now require authorization
 * const response = await axiosInstance.get('/api/admin/users');
 * ```
 */
export function withAuthorizationHandling(
  httpClient: HttpClientAdapter,
  config: AuthorizationHandlerConfig,
): HttpClientAdapter {
  const handler = new AuthorizationHandler(config);

  // Add request interceptor to handle authorization
  httpClient.addRequestInterceptor(async (request) => {
    // Handler may modify request to add authorization header
    return await handler.handleRequest(request);
  });

  return httpClient;
}
