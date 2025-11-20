import { SapiomClient } from "@sapiom/core";
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
 * Configuration for Sapiom-enabled Fetch client
 */
export interface SapiomFetchConfig extends BaseSapiomIntegrationConfig {
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
 * // With custom configuration
 * import { createSapiomFetch } from '@sapiom/fetch';
 *
 * const fetch = createSapiomFetch({
 *   apiKey: 'sk_...',
 *   agentName: 'my-agent',
 *   authorization: {
 *     authorizedEndpoints: [
 *       { pathPattern: /^\/admin/, serviceName: 'admin-api' }
 *     ]
 *   },
 *   payment: {
 *     onPaymentRequired: (txId, payment) => {
 *       console.log(`Payment needed: ${payment.amount} ${payment.token}`);
 *     }
 *   }
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
 *   serviceName: 'my-service',
 *   traceId: 'trace-123'
 * });
 *
 * // Per-request override via __sapiom property
 * const request = new Request('/api/resource', { method: 'POST' });
 * (request as any).__sapiom = {
 *   serviceName: 'different-service',  // Overrides default
 *   actionName: 'custom-action',
 *   traceExternalId: 'ext-456'
 * };
 * await fetch(request);
 *
 * // Native fetch features fully supported
 * const formData = new FormData();
 * formData.append('file', fileBlob);
 * await fetch('/upload', { method: 'POST', body: formData });
 * ```
 */
export function createSapiomFetch(config?: SapiomFetchConfig): typeof fetch {
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

  const sapiomFetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    let request = new Request(input, init);

    if (authConfig) {
      request = await handleAuthorization(request, authConfig, defaultMetadata);
    }

    let response = await globalThis.fetch(request);

    if (paymentConfig && response.status === 402) {
      response = await handlePayment(
        request,
        response,
        paymentConfig,
        defaultMetadata
      );
    }

    return response;
  };

  (sapiomFetch as any).__sapiomClient = sapiomClient;

  return sapiomFetch as typeof fetch;
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
