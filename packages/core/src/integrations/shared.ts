import { SapiomClient, SapiomClientConfig } from '../lib/SapiomClient';

/**
 * Base configuration shared across all Sapiom integrations
 */
export interface BaseSapiomIntegrationConfig {
  /**
   * Existing SapiomClient instance (takes precedence over 'sapiom' config)
   */
  sapiomClient?: SapiomClient;

  /**
   * Config to create new SapiomClient
   * If not provided, reads from environment:
   * - SAPIOM_API_KEY (required)
   * - SAPIOM_BASE_URL or SAPIOM_API_URL (optional)
   */
  sapiom?: SapiomClientConfig;
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
 *   sapiom: { apiKey: 'sk_...' }
 * });
 *
 * // Use existing client instance
 * const existingClient = new SapiomClient({ apiKey: 'sk_...' });
 * const client = initializeSapiomClient({
 *   sapiomClient: existingClient
 * });
 * ```
 */
export function initializeSapiomClient(config?: BaseSapiomIntegrationConfig): SapiomClient {
  // Option 1: Use provided SapiomClient instance
  if (config?.sapiomClient) {
    return config.sapiomClient;
  }

  // Option 2: Create from provided config
  if (config?.sapiom) {
    return new SapiomClient(config.sapiom);
  }

  // Option 3: Create from environment variables
  const apiKey = process.env.SAPIOM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'SAPIOM_API_KEY environment variable is required when no config is provided. ' +
        'Set it in your environment or pass config.sapiom.apiKey explicitly.',
    );
  }

  return new SapiomClient({
    apiKey,
    baseURL: process.env.SAPIOM_BASE_URL || process.env.SAPIOM_API_URL,
    timeout: process.env.SAPIOM_TIMEOUT ? parseInt(process.env.SAPIOM_TIMEOUT) : undefined,
  });
}
