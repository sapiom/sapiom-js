import { ApiKeyAPI } from "./ApiKeyAPI.js";
import { HttpClient, HttpRequestConfig } from "./HttpClient.js";
import { TransactionAPI } from "./TransactionAPI.js";

/**
 * Configuration options for initializing a SapiomClient
 */
export interface SapiomClientConfig {
  /**
   * Your Sapiom API key (starts with 'sk_')
   */
  apiKey: string;

  /**
   * Base URL for the Sapiom API
   * @default "https://api.sapiom.ai"
   */
  baseURL?: string;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Additional headers to include with all requests
   */
  headers?: Record<string, string>;
}

/**
 * Main client for interacting with the Sapiom API
 *
 * The SapiomClient provides access to all Sapiom API functionality including
 * transaction management, authorization, and payment handling.
 *
 * @example
 * ```typescript
 * import { SapiomClient } from '@sapiom/core';
 *
 * // Initialize with API key
 * const client = new SapiomClient({
 *   apiKey: process.env.SAPIOM_API_KEY!
 * });
 *
 * // Create and manage transactions
 * const tx = await client.transactions.create({
 *   serviceName: 'my-service',
 *   actionName: 'process',
 *   resourceName: 'document'
 * });
 *
 * // Complete the transaction after your operation
 * await client.transactions.complete(tx.id, {
 *   outcome: 'success',
 *   responseFacts: {
 *     source: 'my-service',
 *     version: 'v1',
 *     facts: { processedItems: 10 }
 *   }
 * });
 * ```
 */
export class SapiomClient {
  private readonly httpClient: HttpClient;
  public readonly apiKeys: ApiKeyAPI;
  public readonly transactions: TransactionAPI;

  constructor(config: SapiomClientConfig) {
    if (!config.apiKey) {
      throw new Error("API key is required");
    }

    this.httpClient = new HttpClient({
      baseURL: config.baseURL || "https://api.sapiom.ai",
      timeout: config.timeout || 30000,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        ...config.headers,
      },
    });

    // Initialize API modules
    this.apiKeys = new ApiKeyAPI(this.httpClient);
    this.transactions = new TransactionAPI(this.httpClient);
  }

  /**
   * Update the API key
   */
  setApiKey(apiKey: string): void {
    this.httpClient.setHeader("x-api-key", apiKey);
  }

  /**
   * Get the default headers (for testing and compatibility)
   * @deprecated Use for testing only. This method exists for backward compatibility.
   */
  getHttpClient(): {
    defaults: {
      baseURL: string;
      timeout: number;
      headers: Record<string, string>;
    };
  } {
    return {
      defaults: this.httpClient.getDefaults(),
    };
  }

  /**
   * Make a custom request using native fetch
   */
  async request<T = any>(config: HttpRequestConfig): Promise<T> {
    return this.httpClient.request<T>(config);
  }
}
