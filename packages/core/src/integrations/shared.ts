import { SapiomClient, SapiomClientConfig } from "../lib/SapiomClient";

/**
 * Base configuration shared across all Sapiom integrations
 */
export interface BaseSapiomIntegrationConfig {
  /**
   * Existing SapiomClient instance (takes precedence over other config)
   */
  sapiomClient?: SapiomClient;

  /**
   * Sapiom API key
   * If not provided, reads from SAPIOM_API_KEY environment variable
   */
  apiKey?: string;

  /**
   * Enable Sapiom authorization and payment handling
   * When false, all requests bypass Sapiom completely
   * Default: true
   */
  enabled?: boolean;

  /**
   * Sapiom API base URL (for testing or private environments)
   * @internal
   */
  baseURL?: string;

  /**
   * Request timeout in milliseconds
   * @internal
   */
  timeout?: number;

  /**
   * Custom headers to include with all requests
   * @internal
   */
  headers?: Record<string, string>;

  /**
   * Default agent name for transactions
   */
  agentName?: string;

  /**
   * Default agent ID for transactions
   */
  agentId?: string;

  /**
   * Default service name for transactions
   */
  serviceName?: string;

  /**
   * Default trace ID for transactions
   */
  traceId?: string;

  /**
   * Default external trace ID for transactions
   */
  traceExternalId?: string;
}

/**
 * Helper to initialize SapiomClient from config or environment
 * Used internally by all integration functions
 *
 * @param config - Optional configuration object
 * @returns Initialized SapiomClient instance
 * @throws Error if SAPIOM_API_KEY is not found in environment or config
 *
 * @example
 * ```typescript
 * // Initialize from environment (requires SAPIOM_API_KEY)
 * const client = initializeSapiomClient();
 *
 * // Initialize with explicit config
 * const client = initializeSapiomClient({
 *   apiKey: 'sk_...'
 * });
 *
 * // Use existing client instance
 * const existingClient = new SapiomClient({ apiKey: 'sk_...' });
 * const client = initializeSapiomClient({
 *   sapiomClient: existingClient
 * });
 * ```
 */
export function initializeSapiomClient(
  config?: BaseSapiomIntegrationConfig,
): SapiomClient {
  if (config?.sapiomClient) {
    return config.sapiomClient;
  }

  const apiKey = config?.apiKey ?? process.env.SAPIOM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SAPIOM_API_KEY environment variable is required when no config is provided. " +
        "Set it in your environment or pass config.apiKey explicitly.",
    );
  }

  return new SapiomClient({
    apiKey,
    baseURL: config?.baseURL ?? process.env.SAPIOM_BASE_URL ?? process.env.SAPIOM_API_URL,
    timeout: config?.timeout ?? (process.env.SAPIOM_TIMEOUT
      ? parseInt(process.env.SAPIOM_TIMEOUT)
      : undefined),
    headers: config?.headers,
  });
}
