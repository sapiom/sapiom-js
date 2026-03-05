import { randomUUID } from "node:crypto";

/**
 * Request configuration for the HTTP client
 */
export interface HttpRequestConfig {
  method?: string;
  url: string;
  params?: Record<string, any>;
  body?: any;
  headers?: Record<string, string>;
}

/**
 * Retry configuration for transient failures
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 200,
};

/**
 * Configuration for creating an HttpClient
 */
export interface HttpClientConfig {
  baseURL: string;
  timeout: number;
  headers: Record<string, string>;
  retry?: RetryConfig;
}

/**
 * Core HTTP client for making API requests.
 * Uses native fetch for zero external dependencies.
 */
export class HttpClient {
  private readonly baseURL: string;
  private readonly timeout: number;
  private headers: Record<string, string>;
  private readonly retry: RetryConfig;

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL;
    this.timeout = config.timeout;
    this.headers = { ...config.headers };
    const retry = config.retry ?? DEFAULT_RETRY;
    if (!Number.isFinite(retry.maxAttempts) || retry.maxAttempts < 1) {
      throw new Error("retry.maxAttempts must be a finite number >= 1");
    }
    this.retry = retry;
  }

  /**
   * Update a header value
   */
  setHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  /**
   * Get client defaults (for testing and compatibility)
   */
  getDefaults(): {
    baseURL: string;
    timeout: number;
    headers: Record<string, string>;
    retry: RetryConfig;
  } {
    return {
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: this.headers,
      retry: this.retry,
    };
  }

  /**
   * Make a request with automatic retry on transient failures.
   * Retries on 5xx and network TypeError. Does NOT retry 4xx or timeouts.
   * Auto-generates X-Idempotency-Key header for POST/PUT/PATCH.
   */
  async request<T = any>(config: HttpRequestConfig): Promise<T> {
    const method = (config.method || "GET").toUpperCase();
    const needsIdempotencyKey = ["POST", "PUT", "PATCH"].includes(method);

    // Generate idempotency key once, reuse across retries
    let headers = { ...config.headers };
    if (needsIdempotencyKey && !headers["X-Idempotency-Key"]) {
      headers["X-Idempotency-Key"] = randomUUID();
    }

    const configWithHeaders = { ...config, headers };

    let lastError: unknown;
    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      try {
        return await this.executeRequest<T>(configWithHeaders);
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error)) {
          throw error;
        }
        if (attempt < this.retry.maxAttempts - 1) {
          const delay = this.retry.baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  /**
   * Determine whether an error is safe to retry.
   */
  private isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    // Timeouts are NOT safe to retry (server may have processed)
    if (error.message.includes("Request timeout")) return false;

    // Check HTTP status from error message
    const statusMatch = error.message.match(/Request failed with status (\d+)/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1]!, 10);
      return status >= 500;
    }

    // Network-level errors (fetch throws TypeError for DNS / connection refused)
    if (error instanceof TypeError) return true;

    return false;
  }

  /**
   * Execute a single request using native fetch (no retry)
   */
  private async executeRequest<T = any>(config: HttpRequestConfig): Promise<T> {
    const url = this.buildUrl(config.url, config.params);
    const headers = { ...this.headers, ...config.headers };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: config.method || "GET",
        headers,
        body: this.prepareRequestBody(config.body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await this.parseResponse(response);
        throw new Error(
          `Request failed with status ${response.status}: ${JSON.stringify(errorData)}`,
        );
      }

      const responseData = await this.parseResponse(response);

      return responseData as T;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
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
    if (typeof body === "string") {
      return body;
    }

    // If it's FormData, Blob, ArrayBuffer, etc., pass as-is
    if (
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof URLSearchParams ||
      (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
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
    const contentType = response.headers.get("content-type");

    // Handle JSON responses
    if (contentType?.includes("application/json")) {
      try {
        return await response.json();
      } catch {
        // Invalid JSON, return empty object
        return {};
      }
    }

    // Handle text responses
    if (contentType?.includes("text/")) {
      return await response.text();
    }

    // No content-type or unknown type - try text first, then fall back
    const text = await response.text();

    // Empty response
    if (!text) {
      return null;
    }

    // Try to parse as JSON if it looks like JSON
    if (
      (text.startsWith("{") || text.startsWith("[")) &&
      (text.endsWith("}") || text.endsWith("]"))
    ) {
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
   * Automatically prefixes paths with /v1/ for API versioning
   */
  private buildUrl(path: string, params?: Record<string, any>): string {
    const base = this.baseURL.endsWith("/")
      ? this.baseURL.slice(0, -1)
      : this.baseURL;

    // Ensure path starts with /
    const pathname = path.startsWith("/") ? path : `/${path}`;

    // Add /v1 prefix if not already present
    const versionedPath = pathname.startsWith("/v1/")
      ? pathname
      : `/v1${pathname}`;

    const url = `${base}${versionedPath}`;

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
