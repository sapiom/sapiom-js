import {
  HttpClientAdapter,
  HttpError,
  HttpRequest,
  HttpResponse,
} from "@sapiom/core";

/**
 * Fetch API adapter for HTTP client abstraction
 * Provides HttpClientAdapter interface using native fetch
 */
export class FetchAdapter implements HttpClientAdapter {
  private requestInterceptors: Array<
    (req: HttpRequest) => HttpRequest | Promise<HttpRequest>
  > = [];
  private responseInterceptors: Array<{
    onFulfilled: (res: HttpResponse) => HttpResponse | Promise<HttpResponse>;
    onRejected?: (err: HttpError) => any;
  }> = [];

  constructor(private baseURL?: string) {}

  async request<T = any>(request: HttpRequest): Promise<HttpResponse<T>> {
    // Apply request interceptors
    let modifiedRequest = { ...request };
    for (const interceptor of this.requestInterceptors) {
      modifiedRequest = await interceptor(modifiedRequest);
    }

    // Build full URL
    const url = this.buildUrl(modifiedRequest.url);

    try {
      // Execute fetch request
      const response = await fetch(url, {
        method: modifiedRequest.method,
        headers: modifiedRequest.headers,
        body: this.prepareRequestBody(modifiedRequest.body),
      });

      // Parse response body
      const contentType = response.headers.get("content-type");
      let data: T;

      if (contentType?.includes("application/json")) {
        data = (await response.json()) as T;
      } else if (contentType?.includes("text/")) {
        data = (await response.text()) as T;
      } else {
        // Try JSON, fall back to text
        const text = await response.text();
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = text as T;
        }
      }

      let genericResponse: HttpResponse<T> = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };

      // Check for HTTP errors (4xx, 5xx)
      if (!response.ok) {
        const httpError: HttpError = {
          message: `HTTP ${response.status}: ${response.statusText}`,
          status: response.status,
          statusText: response.statusText,
          headers: genericResponse.headers,
          data: genericResponse.data,
          request: modifiedRequest,
          response: genericResponse,
        };

        // Apply response error interceptors
        for (const interceptor of this.responseInterceptors) {
          if (interceptor.onRejected) {
            const result = await interceptor.onRejected(httpError);
            if (result) {
              return result;
            }
          }
        }

        throw httpError;
      }

      // Apply response success interceptors
      for (const interceptor of this.responseInterceptors) {
        try {
          genericResponse = await interceptor.onFulfilled(genericResponse);
        } catch (error) {
          if (interceptor.onRejected) {
            const result = await interceptor.onRejected(error as HttpError);
            if (result) {
              return result;
            }
          }
          throw error;
        }
      }

      return genericResponse;
    } catch (error: any) {
      // Handle network errors or errors thrown by interceptors
      if ("status" in error && "headers" in error) {
        // Already an HttpError from above
        throw error;
      }

      // Network error or other fetch error
      const httpError: HttpError = {
        message: error.message || "Network request failed",
        request: modifiedRequest,
      };

      // Apply error handlers
      for (const interceptor of this.responseInterceptors) {
        if (interceptor.onRejected) {
          const result = await interceptor.onRejected(httpError);
          if (result) {
            return result;
          }
        }
      }

      throw httpError;
    }
  }

  addRequestInterceptor(
    onFulfilled: (req: HttpRequest) => HttpRequest | Promise<HttpRequest>,
    onRejected?: (error: any) => any,
  ): () => void {
    this.requestInterceptors.push(onFulfilled);

    return () => {
      const index = this.requestInterceptors.indexOf(onFulfilled);
      if (index > -1) {
        this.requestInterceptors.splice(index, 1);
      }
    };
  }

  addResponseInterceptor(
    onFulfilled: (res: HttpResponse) => HttpResponse | Promise<HttpResponse>,
    onRejected?: (err: HttpError) => any,
  ): () => void {
    const interceptor = { onFulfilled, onRejected };
    this.responseInterceptors.push(interceptor);

    return () => {
      const index = this.responseInterceptors.indexOf(interceptor);
      if (index > -1) {
        this.responseInterceptors.splice(index, 1);
      }
    };
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
   * Builds full URL from base URL and request URL
   */
  private buildUrl(requestUrl: string): string {
    if (!this.baseURL) {
      return requestUrl;
    }

    // If request URL is absolute, use it as-is
    if (requestUrl.startsWith("http://") || requestUrl.startsWith("https://")) {
      return requestUrl;
    }

    // Join base URL with request URL
    const base = this.baseURL.endsWith("/")
      ? this.baseURL.slice(0, -1)
      : this.baseURL;
    const path = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
    return `${base}${path}`;
  }
}

/**
 * Convenience function to create a Fetch adapter
 * @param baseURL Optional base URL for all requests
 * @returns HttpClientAdapter using fetch API
 *
 * @example
 * ```typescript
 * import { createFetchAdapter } from '@sapiom/sdk';
 *
 * const adapter = createFetchAdapter('https://api.example.com');
 * const response = await adapter.request({
 *   method: 'GET',
 *   url: '/data',
 *   headers: {},
 * });
 * ```
 */
export function createFetchAdapter(baseURL?: string): HttpClientAdapter {
  return new FetchAdapter(baseURL);
}
