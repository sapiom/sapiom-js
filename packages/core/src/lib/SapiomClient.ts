import { TransactionAPI } from './TransactionAPI';

export interface SapiomClientConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
}

/**
 * Internal HTTP client interface for SapiomClient
 * Uses native fetch for zero external dependencies
 */
interface FetchConfig {
  method?: string;
  url: string;
  params?: Record<string, any>;
  body?: any;
  headers?: Record<string, string>;
}

export class SapiomClient {
  private readonly baseURL: string;
  private readonly timeout: number;
  private defaultHeaders: Record<string, string>;
  public readonly transactions: TransactionAPI;

  constructor(config: SapiomClientConfig) {
    if (!config.apiKey) {
      throw new Error('API key is required');
    }

    this.baseURL = config.baseURL || 'http://localhost:3000';
    this.timeout = config.timeout || 30000;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      ...config.headers,
    };

    // Initialize API modules
    this.transactions = new TransactionAPI(this);
  }

  /**
   * Update the API key
   */
  setApiKey(apiKey: string): void {
    this.defaultHeaders['x-api-key'] = apiKey;
  }

  /**
   * Get the default headers (for testing and compatibility)
   * @deprecated Use for testing only. This method exists for backward compatibility.
   */
  getHttpClient(): { defaults: { baseURL: string; timeout: number; headers: Record<string, string> } } {
    return {
      defaults: {
        baseURL: this.baseURL,
        timeout: this.timeout,
        headers: this.defaultHeaders,
      },
    };
  }

  /**
   * Make a custom request using native fetch
   */
  async request<T = any>(config: FetchConfig): Promise<T> {
    const url = this.buildUrl(config.url, config.params);
    const headers = { ...this.defaultHeaders, ...config.headers };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: config.method || 'GET',
        headers,
        body: this.prepareRequestBody(config.body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await this.parseResponse(response);
        throw new Error(`Request failed with status ${response.status}: ${JSON.stringify(errorData)}`);
      }

      return (await this.parseResponse(response)) as T;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Prepare request body for fetch
   * Handles various body types without double-encoding
   */
  private prepareRequestBody(body: any): any {
    if (body === null || body === undefined) {
      return undefined;
    }

    // If already a string, use as-is (might be pre-stringified JSON)
    if (typeof body === 'string') {
      return body;
    }

    // If it's FormData, Blob, ArrayBuffer, etc., pass as-is
    if (
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof URLSearchParams ||
      (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
    ) {
      return body;
    }

    // For plain objects and arrays, stringify
    return JSON.stringify(body);
  }

  /**
   * Parse response based on content type
   */
  private async parseResponse(response: Response): Promise<any> {
    const contentType = response.headers.get('content-type');

    // Handle JSON responses
    if (contentType?.includes('application/json')) {
      try {
        return await response.json();
      } catch {
        // Invalid JSON, return empty object
        return {};
      }
    }

    // Handle text responses
    if (contentType?.includes('text/')) {
      return await response.text();
    }

    // No content-type or unknown type - try text first, then fall back
    const text = await response.text();

    // Empty response
    if (!text) {
      return null;
    }

    // Try to parse as JSON if it looks like JSON
    if ((text.startsWith('{') || text.startsWith('[')) && (text.endsWith('}') || text.endsWith(']'))) {
      try {
        return JSON.parse(text);
      } catch {
        // Not valid JSON, return as text
        return text;
      }
    }

    // Return as text
    return text;
  }

  /**
   * Build full URL with query parameters
   */
  private buildUrl(path: string, params?: Record<string, any>): string {
    const base = this.baseURL.endsWith('/') ? this.baseURL.slice(0, -1) : this.baseURL;
    const pathname = path.startsWith('/') ? path : `/${path}`;
    const url = `${base}${pathname}`;

    if (!params || Object.keys(params).length === 0) {
      return url;
    }

    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    });

    const queryString = searchParams.toString();
    return queryString ? `${url}?${queryString}` : url;
  }
}
