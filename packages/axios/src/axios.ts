import { AxiosInstance } from "axios";

import { SapiomClient, SapiomClientConfig } from "@sapiom/core";
import {
  addAuthorizationInterceptor,
  addPaymentInterceptor,
  AuthorizationInterceptorConfig,
  PaymentInterceptorConfig,
} from "./interceptors";

/**
 * Base configuration for Sapiom integration
 */
export interface BaseSapiomIntegrationConfig {
  /**
   * Existing SapiomClient instance (takes precedence over sapiom config)
   */
  sapiomClient?: SapiomClient;

  /**
   * SapiomClient configuration (if not providing an existing instance)
   */
  sapiom?: SapiomClientConfig;
}

/**
 * Configuration for Sapiom-enabled Axios client
 */
export interface SapiomAxiosConfig extends BaseSapiomIntegrationConfig {
  /**
   * Authorization interceptor configuration
   */
  authorization?: Omit<AuthorizationInterceptorConfig, "sapiomClient">;

  /**
   * Payment interceptor configuration
   */
  payment?: Omit<PaymentInterceptorConfig, "sapiomClient">;

  /**
   * Default metadata applied to all transactions created by this client
   */
  agentName?: string;
  agentId?: string;
  serviceName?: string;
  traceId?: string;
  traceExternalId?: string;
}

/**
 * Initialize SapiomClient from config or environment
 */
function initializeSapiomClient(
  config?: BaseSapiomIntegrationConfig,
): SapiomClient {
  // Use provided instance
  if (config?.sapiomClient) {
    return config.sapiomClient;
  }

  // Use provided config
  if (config?.sapiom) {
    return new SapiomClient(config.sapiom);
  }

  // Fall back to environment variables
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SAPIOM_API_KEY environment variable is required when not providing explicit config",
    );
  }

  return new SapiomClient({
    apiKey,
    baseURL: process.env.SAPIOM_BASE_URL,
  });
}

/**
 * Creates a Sapiom-enabled Axios client with automatic authorization and payment handling
 *
 * This function adds native Axios interceptors to handle:
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
 * import { createSapiomAxios } from '@sapiom/axios';
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
 * import { createSapiomAxios } from '@sapiom/axios';
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
 * import { SapiomClient } from '@sapiom/core';
 * import { createSapiomAxios } from '@sapiom/axios';
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
export function createSapiomAxios(
  axiosInstance: AxiosInstance,
  config?: SapiomAxiosConfig,
): AxiosInstance {
  // Initialize SapiomClient (from config or environment)
  const sapiomClient = initializeSapiomClient(config);

  // Store default metadata on the axios instance
  const defaultMetadata: any = {};
  if (config?.agentName) defaultMetadata.agentName = config.agentName;
  if (config?.agentId) defaultMetadata.agentId = config.agentId;
  if (config?.serviceName) defaultMetadata.serviceName = config.serviceName;
  if (config?.traceId) defaultMetadata.traceId = config.traceId;
  if (config?.traceExternalId)
    defaultMetadata.traceExternalId = config.traceExternalId;

  // Store metadata on axios instance for interceptors to access
  if (Object.keys(defaultMetadata).length > 0) {
    (axiosInstance as any).__sapiomDefaultMetadata = defaultMetadata;
  }

  // Add authorization interceptor (if enabled)
  if (config?.authorization?.enabled !== false) {
    addAuthorizationInterceptor(axiosInstance, {
      ...(config?.authorization || {}),
      sapiomClient,
    });
  }

  // Add payment interceptor (if enabled)
  if (config?.payment?.enabled !== false) {
    addPaymentInterceptor(axiosInstance, {
      ...(config?.payment || {}),
      sapiomClient,
    });
  }

  // Store reference to SapiomClient for testing and advanced usage
  (axiosInstance as any).__sapiomClient = sapiomClient;

  // Return original instance (now wrapped with Sapiom interceptors)
  return axiosInstance;
}
