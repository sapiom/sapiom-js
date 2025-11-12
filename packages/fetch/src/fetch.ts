import { SapiomHandlerConfig, withSapiomHandling } from "@sapiom/core";
import { createFetchAdapter } from "./adapter";
import { HttpClientAdapter } from "@sapiom/core";
import { SapiomClient } from "@sapiom/core";
import {
  BaseSapiomIntegrationConfig,
  initializeSapiomClient,
} from "@sapiom/core";

/**
 * Configuration for Sapiom-enabled Fetch client
 */
export interface SapiomFetchConfig extends BaseSapiomIntegrationConfig {
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
 * Creates a Sapiom-enabled fetch function with automatic authorization and payment handling
 *
 * Drop-in replacement for native fetch() with Sapiom capabilities.
 * Works exactly like native fetch - no API changes required!
 *
 * @param config - Optional configuration (reads from env vars by default)
 * @returns A fetch function with Sapiom payment and authorization handling
 *
 * @example
 * ```typescript
 * // Simplest usage (reads SAPIOM_API_KEY from environment)
 * import { createSapiomFetch } from '@sapiom/sdk/http';
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
 * import { createSapiomFetch } from '@sapiom/sdk/http';
 *
 * const fetch = createSapiomFetch({
 *   sapiom: {
 *     apiKey: 'your-api-key',
 *     baseURL: 'https://sapiom.example.com'
 *   },
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
 */
export function createSapiomFetch(config?: SapiomFetchConfig): typeof fetch {
  // Initialize SapiomClient (from config or environment)
  const sapiomClient = initializeSapiomClient(config);

  // Create adapter WITHOUT baseURL - let users provide full URLs like native fetch
  const adapter = createFetchAdapter();

  withSapiomHandling(adapter, {
    sapiomClient,
    authorization: config?.authorization,
    payment: config?.payment,
  });

  // Return a native fetch-compatible function
  const sapiomFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    // Convert fetch arguments to HttpRequest format
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const method = init?.method || "GET";
    const headers: Record<string, string> = {};

    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([key, value]) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Use the adapter's request method (which has interceptors applied)
    const response = await adapter.request({
      method,
      url,
      headers,
      body: init?.body as any,
    });

    // Convert HttpResponse back to fetch Response
    // response.data is already parsed by FetchAdapter - avoid double encoding
    const responseHeaders = new Headers(response.headers);

    let body: string | null = null;
    if (response.data !== undefined && response.data !== null) {
      // If data is already a string (text response), use it directly
      if (typeof response.data === "string") {
        body = response.data;
      } else {
        // For objects, stringify them (they were parsed from JSON)
        body = JSON.stringify(response.data);
      }
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };

  // Attach helper properties for advanced usage
  (sapiomFetch as any).__sapiomClient = sapiomClient;
  (sapiomFetch as any).__adapter = adapter;

  return sapiomFetch as typeof fetch;
}
