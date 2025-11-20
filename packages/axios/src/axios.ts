import { AxiosInstance } from "axios";

import {
  BaseSapiomIntegrationConfig,
  initializeSapiomClient,
} from "@sapiom/core";
import {
  addAuthorizationInterceptor,
  addPaymentInterceptor,
} from "./interceptors";

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
 * ```
 */
export function createSapiomAxios(
  axiosInstance: AxiosInstance,
  config?: SapiomAxiosConfig,
): AxiosInstance {
  const sapiomClient = initializeSapiomClient(config);

  const defaultMetadata: any = {};
  if (config?.agentName) defaultMetadata.agentName = config.agentName;
  if (config?.agentId) defaultMetadata.agentId = config.agentId;
  if (config?.serviceName) defaultMetadata.serviceName = config.serviceName;
  if (config?.traceId) defaultMetadata.traceId = config.traceId;
  if (config?.traceExternalId)
    defaultMetadata.traceExternalId = config.traceExternalId;

  if (Object.keys(defaultMetadata).length > 0) {
    (axiosInstance as any).__sapiomDefaultMetadata = defaultMetadata;
  }

  addAuthorizationInterceptor(axiosInstance, { sapiomClient });
  addPaymentInterceptor(axiosInstance, { sapiomClient });

  (axiosInstance as any).__sapiomClient = sapiomClient;

  return axiosInstance;
}
