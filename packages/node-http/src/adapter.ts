import * as http from "http";
import * as https from "https";
import { URL } from "url";

import {
  HttpClientAdapter,
  HttpError,
  HttpRequest,
  HttpResponse,
} from "@sapiom/core";

/**
 * Node.js HTTP/HTTPS adapter for HTTP client abstraction
 * Uses native Node.js http/https modules
 */
export class NodeHttpAdapter implements HttpClientAdapter {
  private requestInterceptors: Array<
    (req: HttpRequest) => HttpRequest | Promise<HttpRequest>
  > = [];
  private responseInterceptors: Array<{
    onFulfilled: (res: HttpResponse) => HttpResponse | Promise<HttpResponse>;
    onRejected?: (err: HttpError) => any;
  }> = [];

  async request<T = any>(request: HttpRequest): Promise<HttpResponse<T>> {
    // Apply request interceptors
    let modifiedRequest = { ...request };
    for (const interceptor of this.requestInterceptors) {
      modifiedRequest = await interceptor(modifiedRequest);
    }

    return new Promise((resolve, reject) => {
      const url = new URL(modifiedRequest.url);
      const isHttps = url.protocol === "https:";
      const client = isHttps ? https : http;

      // Build query string from params
      if (modifiedRequest.params) {
        const searchParams = new URLSearchParams(modifiedRequest.params);
        const queryString = searchParams.toString();
        if (queryString) {
          url.search = queryString;
        }
      }

      // Prepare body and calculate Content-Length if needed
      let bodyString: string | undefined;
      if (modifiedRequest.body) {
        bodyString =
          typeof modifiedRequest.body === "string"
            ? modifiedRequest.body
            : JSON.stringify(modifiedRequest.body);

        // Set Content-Length header before creating request
        if (!modifiedRequest.headers["Content-Length"]) {
          modifiedRequest.headers["Content-Length"] =
            Buffer.byteLength(bodyString).toString();
        }
      }

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: modifiedRequest.method,
        headers: modifiedRequest.headers,
      };

      const req = client.request(options, async (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk.toString();
        });

        res.on("end", async () => {
          const status = res.statusCode || 0;
          const statusText = res.statusMessage || "";
          const headers = res.headers as Record<string, string>;

          // Parse response body
          let parsedData: T;
          const contentType = headers["content-type"];

          try {
            if (contentType?.includes("application/json")) {
              parsedData = JSON.parse(data);
            } else if (contentType?.includes("text/")) {
              parsedData = data as T;
            } else {
              // Try JSON, fall back to text
              try {
                parsedData = JSON.parse(data);
              } catch {
                parsedData = data as T;
              }
            }
          } catch (parseError) {
            parsedData = data as T;
          }

          let genericResponse: HttpResponse<T> = {
            status,
            statusText,
            headers,
            data: parsedData,
          };

          // Check for HTTP errors (4xx, 5xx)
          if (status >= 400) {
            const httpError: HttpError = {
              message: `HTTP ${status}: ${statusText}`,
              status,
              statusText,
              headers,
              data: parsedData,
              request: modifiedRequest,
              response: genericResponse,
            };

            // Apply response error interceptors
            for (const interceptor of this.responseInterceptors) {
              if (interceptor.onRejected) {
                try {
                  const result = await interceptor.onRejected(httpError);
                  if (result) {
                    return resolve(result);
                  }
                } catch (error) {
                  return reject(error);
                }
              }
            }

            return reject(httpError);
          }

          // Apply response success interceptors
          try {
            for (const interceptor of this.responseInterceptors) {
              genericResponse = await interceptor.onFulfilled(genericResponse);
            }
            resolve(genericResponse);
          } catch (error) {
            // Error thrown in success interceptor
            for (const interceptor of this.responseInterceptors) {
              if (interceptor.onRejected) {
                try {
                  const result = await interceptor.onRejected(
                    error as HttpError,
                  );
                  if (result) {
                    return resolve(result);
                  }
                } catch (handlerError) {
                  return reject(handlerError);
                }
              }
            }
            reject(error);
          }
        });
      });

      req.on("error", async (error) => {
        const httpError: HttpError = {
          message: error.message || "Network request failed",
          request: modifiedRequest,
        };

        // Apply error handlers
        for (const interceptor of this.responseInterceptors) {
          if (interceptor.onRejected) {
            try {
              const result = await interceptor.onRejected(httpError);
              if (result) {
                return resolve(result);
              }
            } catch (handlerError) {
              return reject(handlerError);
            }
          }
        }

        reject(httpError);
      });

      // Write request body if present (already prepared above)
      if (bodyString) {
        req.write(bodyString);
      }

      req.end();
    });
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
}

/**
 * Convenience function to create a Node.js HTTP adapter
 * @returns HttpClientAdapter using native Node.js http/https modules
 *
 * @example
 * ```typescript
 * import { createNodeHttpAdapter } from '@sapiom/sdk';
 *
 * const adapter = createNodeHttpAdapter();
 * const response = await adapter.request({
 *   method: 'GET',
 *   url: 'https://api.example.com/data',
 *   headers: { 'Authorization': 'Bearer token' },
 * });
 * ```
 */
export function createNodeHttpAdapter(): HttpClientAdapter {
  return new NodeHttpAdapter();
}
