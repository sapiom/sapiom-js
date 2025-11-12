import { HttpClientAdapter } from "../http/types";
import {
  AuthorizationHandler,
  AuthorizationHandlerConfig,
} from "./AuthorizationHandler";
import { PaymentHandler, PaymentHandlerConfig } from "./PaymentHandler";
import { withAuthorizationHandling, withPaymentHandling } from "./wrappers";

/**
 * Configuration for unified Sapiom handler
 * Combines both authorization and payment handling
 * Both handlers are always attached (use empty config {} to use defaults)
 */
export interface SapiomHandlerConfig {
  sapiomClient: AuthorizationHandlerConfig["sapiomClient"];
  authorization?: Omit<AuthorizationHandlerConfig, "sapiomClient">;
  payment?: Omit<PaymentHandlerConfig, "sapiomClient">;
}

/**
 * Adds both authorization and payment handling to an HTTP client adapter
 *
 * This is a convenience function that combines:
 * - Pre-emptive authorization (request interceptor)
 * - Reactive payment handling (response interceptor)
 *
 * Execution order:
 * 1. Request Phase: Authorization (if configured)
 * 2. HTTP Request: Made with X-Sapiom-Transaction-Id header (if authorized)
 * 3. Response Phase: Payment handling (if 402 received)
 *
 * @param httpClient The HTTP client adapter to wrap
 * @param config Unified configuration for both handlers
 * @returns The same adapter instance (modified in place)
 *
 * @example
 * ```typescript
 * import { createAxiosAdapter, withSapiomHandling, SapiomClient } from '@sapiom/sdk';
 * import axios from 'axios';
 *
 * const sapiom = new SapiomClient({ apiKey: process.env.SAPIOM_API_KEY! });
 * const axiosInstance = axios.create();
 * const adapter = createAxiosAdapter(axiosInstance);
 *
 * // Minimal - both handlers with defaults
 * withSapiomHandling(adapter, {
 *   sapiomClient: sapiom,
 * });
 *
 * // Or configure specific handlers
 * withSapiomHandling(adapter, {
 *   sapiomClient: sapiom,
 *
 *   authorization: {
 *     authorizedEndpoints: [
 *       {
 *         pathPattern: /^\/api\/admin\//,
 *         serviceName: 'admin-api',
 *       },
 *     ],
 *     onAuthorizationPending: (txId) => {
 *       console.log(`Authorization required: ${txId}`);
 *     },
 *   },
 *
 *   payment: {
 *     onPaymentRequired: (txId, payment) => {
 *       console.log(`Payment: ${payment.amount} ${payment.token}`);
 *     },
 *   },
 * });
 *
 * // Handles both authorization AND payment automatically
 * const response = await axiosInstance.get('/api/admin/premium-data');
 * ```
 */
export function withSapiomHandling(
  httpClient: HttpClientAdapter,
  config: SapiomHandlerConfig,
): HttpClientAdapter {
  // Apply authorization handler (request phase) unless explicitly disabled
  if (config.authorization?.enabled !== false) {
    withAuthorizationHandling(httpClient, {
      ...(config.authorization || {}),
      sapiomClient: config.sapiomClient,
    });
  }

  // Apply payment handler (response phase) unless explicitly disabled
  if (config.payment?.enabled !== false) {
    withPaymentHandling(httpClient, {
      ...(config.payment || {}),
      sapiomClient: config.sapiomClient,
    });
  }

  return httpClient;
}
