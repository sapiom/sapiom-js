import { SapiomHandlerConfig, withSapiomHandling } from "@sapiom/core";
import { createNodeHttpAdapter } from "./adapter";
import { HttpClientAdapter } from "@sapiom/core";
import { SapiomClient } from "@sapiom/core";
import {
  BaseSapiomIntegrationConfig,
  initializeSapiomClient,
} from "@sapiom/core";

/**
 * Configuration for Sapiom-enabled Node.js HTTP client
 */
export interface SapiomNodeHttpConfig extends BaseSapiomIntegrationConfig {
  /**
   * Authorization handler configuration
   */
  authorization?: Omit<SapiomHandlerConfig["authorization"], "sapiomClient">;

  /**
   * Payment handler configuration
   */
  payment?: Omit<SapiomHandlerConfig["payment"], "sapiomClient">;
}

/**
 * Creates a Sapiom-enabled Node.js HTTP client adapter with automatic authorization and payment handling
 *
 * This creates a new HttpClientAdapter using Node.js's native http/https modules, wrapped with:
 * - Pre-emptive authorization (request interceptor)
 * - Reactive payment handling (response interceptor for 402 errors)
 *
 * Unlike Axios or Fetch integrations, this returns an HttpClientAdapter interface
 * that can be used for making raw HTTP requests.
 *
 * @param config - Optional configuration (reads from env vars by default)
 * @returns A Sapiom-enabled HttpClientAdapter
 *
 * @example
 * ```typescript
 * // Simplest usage (reads SAPIOM_API_KEY from environment)
 * import { createSapiomNodeHttp } from '@sapiom/sdk';
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
 * import { createSapiomNodeHttp } from '@sapiom/sdk';
 *
 * const client = createSapiomNodeHttp({
 *   sapiom: {
 *     apiKey: 'your-api-key',
 *     baseURL: 'https://sapiom.example.com'
 *   },
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
 * // Useful for server-side applications that need fine-grained control
 * import { createSapiomNodeHttp } from '@sapiom/sdk';
 *
 * const client = createSapiomNodeHttp({
 *   payment: {
 *     onPaymentRequired: async (txId, payment) => {
 *       await logger.info(`Payment required: ${txId}`, { payment });
 *     },
 *     onPaymentAuthorized: async (txId) => {
 *       await logger.info(`Payment authorized: ${txId}`);
 *     }
 *   }
 * });
 *
 * // Use in your Node.js application
 * async function fetchPremiumData(endpoint: string) {
 *   const response = await client.request({
 *     method: 'GET',
 *     url: `https://api.example.com${endpoint}`,
 *     headers: { 'Authorization': `Bearer ${token}` }
 *   });
 *   return response.data;
 * }
 * ```
 */
export function createSapiomNodeHttp(
  config?: SapiomNodeHttpConfig,
): HttpClientAdapter & { __sapiomClient: SapiomClient } {
  // Initialize SapiomClient (from config or environment)
  const sapiomClient = initializeSapiomClient(config);

  // Create Node.js HTTP adapter
  const adapter = createNodeHttpAdapter();

  // Apply Sapiom handling
  withSapiomHandling(adapter, {
    sapiomClient,
    authorization: config?.authorization,
    payment: config?.payment,
  });

  // Store reference to SapiomClient for testing and advanced usage
  (adapter as any).__sapiomClient = sapiomClient;

  return adapter as HttpClientAdapter & { __sapiomClient: SapiomClient };
}
