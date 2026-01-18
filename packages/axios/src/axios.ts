import { AxiosInstance } from "axios";

import {
  BaseSapiomIntegrationConfig,
  initializeSapiomClient,
} from "@sapiom/core";
import {
  addAuthorizationInterceptor,
  addPaymentInterceptor,
  addCompletionInterceptor,
} from "./interceptors.js";

/**
 * Configuration for Sapiom-enabled Axios client
 */
export interface SapiomAxiosConfig extends BaseSapiomIntegrationConfig {}

/**
 * Creates a Sapiom-enabled Axios client with automatic authorization and payment handling
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
 * const data = await client.get('/premium-endpoint');
 * ```
 *
 * @example
 * ```typescript
 * // With API key and default metadata
 * import axios from 'axios';
 * import { createSapiomAxios } from '@sapiom/axios';
 *
 * const client = createSapiomAxios(axios.create({
 *   baseURL: 'https://api.example.com'
 * }), {
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service'
 * });
 *
 * // Per-request override via __sapiom
 * await client.post('/api/resource', data, {
 *   __sapiom: {
 *     serviceName: 'different-service',
 *     actionName: 'custom-action'
 *   }
 * });
 *
 * // Disable Sapiom for specific request
 * await client.get('/api/public', {
 *   __sapiom: { enabled: false }
 * });
 * ```
 */
export function withSapiom(
  axiosInstance: AxiosInstance,
  config?: SapiomAxiosConfig,
): AxiosInstance {
  if (config?.enabled === false) {
    return axiosInstance;
  }

  const sapiomClient = initializeSapiomClient(config);
  const failureMode = config?.failureMode ?? "open";

  const defaultMetadata: any = {};
  if (config?.agentName) defaultMetadata.agentName = config.agentName;
  if (config?.agentId) defaultMetadata.agentId = config.agentId;
  if (config?.serviceName) defaultMetadata.serviceName = config.serviceName;
  if (config?.traceId) defaultMetadata.traceId = config.traceId;
  if (config?.traceExternalId)
    defaultMetadata.traceExternalId = config.traceExternalId;
  if (config?.enabled !== undefined) defaultMetadata.enabled = config.enabled;

  if (Object.keys(defaultMetadata).length > 0) {
    (axiosInstance as any).__sapiomDefaultMetadata = defaultMetadata;
  }

  (axiosInstance as any).__sapiomFailureMode = failureMode;

  addAuthorizationInterceptor(axiosInstance, { sapiomClient, failureMode });
  // IMPORTANT: Completion interceptor must be added BEFORE payment interceptor
  // because Axios response interceptors run in LIFO order (last added runs first).
  // We want: request -> payment handling (retry on 402) -> completion
  addCompletionInterceptor(axiosInstance, { sapiomClient });
  addPaymentInterceptor(axiosInstance, { sapiomClient, failureMode });

  (axiosInstance as any).__sapiomClient = sapiomClient;

  return axiosInstance;
}
