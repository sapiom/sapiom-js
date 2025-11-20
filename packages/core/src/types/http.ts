/**
 * Sapiom-specific metadata for transactions
 * Users can provide this to override default behavior
 */
export interface SapiomTransactionMetadata {
  serviceName?: string; // Override extracted service name
  actionName?: string; // Override default action
  resourceName?: string; // Override resource identifier
  qualifiers?: Record<string, any>; // Additional context
  metadata?: Record<string, any>; // Custom metadata for transaction
  enabled?: boolean; // Override Sapiom handling for this request (bypasses authorization and payment)

  // Trace configuration
  traceId?: string; // Use existing trace by internal UUID
  traceExternalId?: string; // Find or create trace by external ID

  // Agent configuration
  agentId?: string; // Use existing agent (UUID or numeric ID like AG-001)
  agentName?: string; // Find or create agent by name
}

/**
 * Generic HTTP request representation
 * HTTP-client agnostic interface for representing outgoing requests
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
  params?: Record<string, any>;
  __sapiom?: SapiomTransactionMetadata; // User-provided transaction metadata
  metadata?: Record<string, any>; // Internal flags like __is402Retry, __skipSapiomAuth
}

/**
 * Generic HTTP response representation
 * HTTP-client agnostic interface for representing responses
 */
export interface HttpResponse<T = any> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
}

/**
 * Generic HTTP error representation
 * HTTP-client agnostic interface for representing errors
 */
export interface HttpError {
  message: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  data?: any;
  request?: HttpRequest;
  response?: HttpResponse;
}

/**
 * HTTP client adapter interface
 * Provides a unified interface for different HTTP libraries
 *
 * Implementations must:
 * - Execute requests and return normalized responses
 * - Support request/response interceptors
 * - Handle errors consistently
 */
export interface HttpClientAdapter {
  /**
   * Execute a HTTP request
   * @param request The request to execute
   * @returns The response from the server
   * @throws HttpError on request failure
   */
  request<T = any>(request: HttpRequest): Promise<HttpResponse<T>>;

  /**
   * Add request interceptor
   * Interceptors are called before the request is sent
   *
   * @param onFulfilled Function to modify the request
   * @param onRejected Optional error handler
   * @returns Cleanup function to remove the interceptor
   */
  addRequestInterceptor(
    onFulfilled: (request: HttpRequest) => HttpRequest | Promise<HttpRequest>,
    onRejected?: (error: any) => any,
  ): () => void;

  /**
   * Add response interceptor
   * Interceptors are called after the response is received (or on error)
   *
   * @param onFulfilled Function to modify successful responses
   * @param onRejected Function to handle errors (can return response to recover)
   * @returns Cleanup function to remove the interceptor
   */
  addResponseInterceptor(
    onFulfilled: (
      response: HttpResponse,
    ) => HttpResponse | Promise<HttpResponse>,
    onRejected?: (error: HttpError) => any,
  ): () => void;
}
