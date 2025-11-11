import { AxiosInstance } from 'axios';

import { SapiomHandlerConfig, withSapiomHandling } from '../../core/SapiomHandler';
import { createAxiosAdapter } from '../../http/adapters/axios';
import { BaseSapiomIntegrationConfig, initializeSapiomClient } from '../shared';

/**
 * Configuration for Sapiom-enabled Axios client
 */
export interface SapiomAxiosConfig extends BaseSapiomIntegrationConfig {
  /**
   * Authorization handler configuration
   */
  authorization?: Omit<SapiomHandlerConfig['authorization'], 'sapiomClient'>;

  /**
   * Payment handler configuration
   */
  payment?: Omit<SapiomHandlerConfig['payment'], 'sapiomClient'>;
}

/**
 * Creates a Sapiom-enabled Axios client with automatic authorization and payment handling
 *
 * This is the simplest way to add Sapiom capabilities to your Axios instance.
 * It automatically wraps the instance with:
 * - Pre-emptive authorization (request interceptor)
 * - Reactive payment handling (response interceptor for 402 errors)
 *
 * The function mutates the original Axios instance by adding interceptors,
 * then returns the same instance for convenient chaining.
 *
 * @param axiosInstance - The Axios instance to wrap with Sapiom handling
 * @param config - Optional configuration (reads from env vars by default)
 * @returns The same Axios instance (now Sapiom-enabled)
 *
 * @example
 * ```typescript
 * // Simplest usage (reads SAPIOM_API_KEY from environment)
 * import axios from 'axios';
 * import { createSapiomAxios } from '@sapiom/sdk';
 *
 * const client = createSapiomAxios(axios.create({
 *   baseURL: 'https://api.example.com'
 * }));
 *
 * // Auto-handles 402 payment errors and authorization
 * const data = await client.get('/premium-endpoint');
 * ```
 *
 * @example
 * ```typescript
 * // With custom configuration
 * import axios from 'axios';
 * import { createSapiomAxios } from '@sapiom/sdk';
 *
 * const client = createSapiomAxios(axios.create({
 *   baseURL: 'https://api.example.com'
 * }), {
 *   sapiom: {
 *     apiKey: 'your-api-key',
 *     baseURL: 'https://sapiom.example.com'
 *   },
 *   authorization: {
 *     authorizedEndpoints: [
 *       { pathPattern: /^\/admin/, serviceName: 'admin-api' }
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
 * ```
 *
 * @example
 * ```typescript
 * // Using an existing SapiomClient instance
 * import axios from 'axios';
 * import { SapiomClient, createSapiomAxios } from '@sapiom/sdk';
 *
 * const sapiomClient = new SapiomClient({ apiKey: 'your-api-key' });
 *
 * const client = createSapiomAxios(axios.create({
 *   baseURL: 'https://api.example.com'
 * }), {
 *   sapiomClient // Reuse existing client
 * });
 * ```
 */
export function createSapiomAxios(axiosInstance: AxiosInstance, config?: SapiomAxiosConfig): AxiosInstance {
  // Initialize SapiomClient (from config or environment)
  const sapiomClient = initializeSapiomClient(config);

  // Create adapter and apply Sapiom handling
  const adapter = createAxiosAdapter(axiosInstance);

  withSapiomHandling(adapter, {
    sapiomClient,
    authorization: config?.authorization,
    payment: config?.payment,
  });

  // Store reference to SapiomClient for testing and advanced usage
  (axiosInstance as any).__sapiomClient = sapiomClient;

  // Return original instance (now wrapped with Sapiom interceptors)
  return axiosInstance;
}
