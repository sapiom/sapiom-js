import { HttpClient, HttpRequestConfig } from "./HttpClient.js";
import { TransactionAPI } from "./TransactionAPI.js";

export interface SapiomClientConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export class SapiomClient {
  private readonly httpClient: HttpClient;
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
