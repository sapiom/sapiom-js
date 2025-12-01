import { SapiomClient } from "@sapiom/core";
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
} from "./interceptors";

/**
 * Configuration for Sapiom-enabled Fetch client
 */
export interface SapiomFetchConfig extends BaseSapiomIntegrationConfig {}

/**
 * Creates a Sapiom-enabled fetch function with automatic authorization and payment handling
 *
 * Drop-in replacement for native fetch() with Sapiom capabilities.
 * Works directly with native Request/Response objects, preserving all native fetch features
 * (FormData, Blob, streams, etc.).
 *
 * @param config - Optional configuration (reads from env vars by default)
 * @returns A fetch function with Sapiom payment and authorization handling
 *
 * @example
 * ```typescript
 * // Simplest usage (reads SAPIOM_API_KEY from environment)
 * import { createSapiomFetch } from '@sapiom/fetch';
 *
 * const fetch = createSapiomFetch();
 *
 * // Works exactly like native fetch!
 * const response = await fetch('https://api.example.com/premium-endpoint');
 * const data = await response.json();
 * ```
 *
 * @example
 * ```typescript
 * // With API key and default metadata
 * import { createSapiomFetch } from '@sapiom/fetch';
 *
 * const fetch = createSapiomFetch({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service'
 * });
 *
 * const response = await fetch('https://api.example.com/data');
 * ```
 *
 * @example
 * ```typescript
 * // With default metadata (applied to all requests)
 * const fetch = createSapiomFetch({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   serviceName: 'my-service'
 * });
 *
 * // Per-request override via __sapiom property
 * const request = new Request('/api/resource', { method: 'POST' });
 * (request as any).__sapiom = {
 *   serviceName: 'different-service',
 *   actionName: 'custom-action'
 * };
 * await fetch(request);
 *
 * // Disable Sapiom for specific request
 * const publicRequest = new Request('/api/public');
 * (publicRequest as any).__sapiom = { enabled: false };
 * await fetch(publicRequest);
 * ```
 */
export function createFetch(config?: SapiomFetchConfig): typeof fetch {
  if (config?.enabled === false) {
    return globalThis.fetch;
  }

  const sapiomClient = initializeSapiomClient(config);

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

  const sapiomFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let request = new Request(input, init);

    const requestMetadata = (request as any).__sapiom || {};
    const userMetadata = { ...defaultMetadata, ...requestMetadata };

    if (userMetadata?.enabled === false) {
      return globalThis.fetch(request);
    }

    request = await handleAuthorization(request, authConfig, defaultMetadata);

    const startTime = Date.now();
    let response: Response | null = null;
    let error: Error | null = null;

    try {
      response = await globalThis.fetch(request);

      if (response.status === 402) {
        response = await handlePayment(
          input,
          init,
          response,
          paymentConfig,
          defaultMetadata,
        );
      }

      return response;
    } catch (err) {
      error = err as Error;
      throw err;
    } finally {
      // Fire-and-forget: complete the transaction
      handleCompletion(request, response, error, completionConfig, startTime);
    }
  };

  (sapiomFetch as any).__sapiomClient = sapiomClient;

  return sapiomFetch as typeof fetch;
}

export {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors";
