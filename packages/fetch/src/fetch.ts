import { SapiomClient } from "@sapiom/core";
import {
  BaseSapiomIntegrationConfig,
  fetchDroppingIdentityCrossOrigin,
  initializeSapiomClient,
} from "@sapiom/core";
import type { IdentityFetchOptions } from "@sapiom/core";
import type { TransactionPollingConfig } from "@sapiom/core";
import {
  handleAuthorization,
  handlePayment,
  handleCompletion,
  AuthorizationConfig,
  PaymentConfig,
  CompletionConfig,
} from "./interceptors.js";

/**
 * Configuration for Sapiom-enabled Fetch client
 */
export interface SapiomFetchConfig extends BaseSapiomIntegrationConfig {
  /**
   * Polling configuration for transaction authorization.
   * Overrides default timeout (30s) and poll interval (1s).
   */
  polling?: TransactionPollingConfig;
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
 * import { createFetch } from '@sapiom/fetch';
 *
 * const fetch = createFetch();
 *
 * // Works exactly like native fetch!
 * const response = await fetch('https://api.example.com/premium-endpoint');
 * const data = await response.json();
 * ```
 *
 * @example
 * ```typescript
 * // With API key and default metadata
 * import { createFetch } from '@sapiom/fetch';
 *
 * const fetch = createFetch({
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
 * import { createFetch } from '@sapiom/fetch';
 *
 * const fetch = createFetch({
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
 * // Disable Sapiom for specific request (on the Request or in init)
 * const publicRequest = new Request('/api/public');
 * (publicRequest as any).__sapiom = { enabled: false };
 * await fetch(publicRequest);
 * await fetch('/api/public', { __sapiom: { enabled: false } } as RequestInit);
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
  if (config?.integration) defaultMetadata.integration = config.integration;
  if (config?.enabled !== undefined) defaultMetadata.enabled = config.enabled;

  const failureMode = config?.failureMode ?? "open";

  const authConfig: AuthorizationConfig = {
    sapiomClient,
    failureMode,
    polling: config?.polling,
  };
  const paymentConfig: PaymentConfig = {
    sapiomClient,
    failureMode,
    polling: config?.polling,
  };
  const completionConfig: CompletionConfig = { sapiomClient };

  const sapiomFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Read before `new Request(...)`: a copied Request does not carry the expando.
    const requestMetadata =
      (init as any)?.__sapiom ??
      (input instanceof Request ? (input as any).__sapiom : undefined) ??
      {};
    const userMetadata = { ...defaultMetadata, ...requestMetadata };

    if (userMetadata?.enabled === false) {
      return globalThis.fetch(input, init);
    }

    let request = new Request(input, init);
    // A request rebuilt for a redirect would lose the caller's undici dispatcher.
    const identityOptions: IdentityFetchOptions = {
      dispatcher: (init as any)?.dispatcher,
    };

    // Attach identity header if target matches token audience
    if (sapiomClient.identity) {
      const identityHeaders = await sapiomClient.identity.getHeaderIfMatch(
        request.url,
      );
      if (identityHeaders["Sapiom-Identity"]) {
        const headers = new Headers(request.headers);
        headers.set("Sapiom-Identity", identityHeaders["Sapiom-Identity"]);
        request = new Request(request, { headers });
      }
    }

    request = await handleAuthorization(request, authConfig, userMetadata);

    const startTime = Date.now();
    let response: Response | null = null;
    let error: Error | null = null;

    try {
      // Clone before sending: an unconsumed body for a 402 retry or a 307/308 resend
      const requestForRetry = request.clone();
      response = await fetchDroppingIdentityCrossOrigin(
        globalThis.fetch,
        request,
        "@sapiom/fetch",
        { ...identityOptions, replay: requestForRetry },
      );

      if (response.status === 402) {
        response = await handlePayment(
          requestForRetry,
          response,
          paymentConfig,
          request,
          userMetadata,
          identityOptions,
        );
      }

      return response;
    } catch (err) {
      error = err as Error;
      throw err;
    } finally {
      // Fire-and-forget: complete the transaction
      handleCompletion(
        request,
        response,
        error,
        completionConfig,
        startTime,
        userMetadata,
      );
    }
  };

  (sapiomFetch as any).__sapiomClient = sapiomClient;

  return sapiomFetch as typeof fetch;
}

export {
  AuthorizationDeniedError,
  AuthorizationTimeoutError,
} from "./interceptors.js";
