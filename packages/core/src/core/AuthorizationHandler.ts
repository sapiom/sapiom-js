import { HttpRequest, SapiomTransactionMetadata } from "../http/types";
import type { HttpClientRequestFacts } from "../integrations/http/schemas/http-client-v1";
import { captureUserCallSite } from "../lib/telemetry";
import { SapiomClient } from "../lib/SapiomClient";
import { TransactionPoller } from "../lib/TransactionPoller";
import { getHeader, setHeader } from "../lib/utils";
import { TransactionStatus } from "../types/transaction";

// SDK version for facts
const SDK_VERSION = "1.0.0"; // TODO: Read from package.json

/**
 * Authorization error thrown when transaction is denied
 */
export class AuthorizationDeniedError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly endpoint: string,
    public readonly reason?: string,
  ) {
    super(
      `Authorization denied for ${endpoint}: ${reason || "No reason provided"}`,
    );
    this.name = "AuthorizationDeniedError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthorizationDeniedError);
    }
  }
}

/**
 * Authorization error thrown when transaction times out
 */
export class AuthorizationTimeoutError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly endpoint: string,
    public readonly timeout: number,
  ) {
    super(`Authorization timeout after ${timeout}ms for ${endpoint}`);
    this.name = "AuthorizationTimeoutError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthorizationTimeoutError);
    }
  }
}

/**
 * Endpoint authorization rule for pattern matching
 */
export interface EndpointAuthorizationRule {
  method?: string | string[] | RegExp;
  pathPattern: RegExp;
  serviceName: string;
  actionName?: string;
  qualifiers?:
    | Record<string, any>
    | ((request: HttpRequest) => Record<string, any>);
  resourceExtractor?: (request: HttpRequest) => string;
  metadata?: Record<string, any>;
}

/**
 * Configuration for AuthorizationHandler
 */
export interface AuthorizationHandlerConfig {
  sapiomClient: SapiomClient;

  // Opt-out flag
  enabled?: boolean; // Default: true

  /**
   * Optional endpoint patterns requiring authorization
   * If not provided or empty, ALL requests will require authorization
   */
  authorizedEndpoints?: EndpointAuthorizationRule[];

  authorizationTimeout?: number; // Default: 30000ms
  pollingInterval?: number; // Default: 1000ms

  onAuthorizationPending?: (transactionId: string, endpoint: string) => void;
  onAuthorizationSuccess?: (transactionId: string, endpoint: string) => void;
  onAuthorizationDenied?: (
    transactionId: string,
    endpoint: string,
    reason?: string,
  ) => void;

  throwOnDenied?: boolean; // Default: true
}

/**
 * Core authorization handler (HTTP-agnostic)
 * Handles pre-emptive authorization by creating Sapiom transactions before requests
 */
export class AuthorizationHandler {
  private poller: TransactionPoller;

  constructor(private config: AuthorizationHandlerConfig) {
    this.poller = new TransactionPoller(config.sapiomClient, {
      timeout: config.authorizationTimeout,
      pollInterval: config.pollingInterval,
    });
  }

  /**
   * Handles authorization for outgoing request
   * Returns modified request with X-Sapiom-Transaction-Id header
   */
  async handleRequest(request: HttpRequest): Promise<HttpRequest> {
    // Skip if this is a payment retry - payment handler already validated the transaction
    if (request.metadata?.__is402Retry) {
      return request;
    }

    // If request already has transaction ID, validate and handle appropriately
    // Use case-insensitive header check (HTTP headers are case-insensitive per RFC 7230)
    const existingTransactionId = getHeader(
      request.headers,
      "X-Sapiom-Transaction-Id",
    );
    if (existingTransactionId) {
      const transaction = await this.config.sapiomClient.transactions.get(
        existingTransactionId,
      );
      const endpoint = request.url;

      switch (transaction.status) {
        case TransactionStatus.AUTHORIZED:
          // Valid authorization - continue with existing transaction
          return request;

        case TransactionStatus.PENDING:
        case TransactionStatus.PREPARING: {
          // Wait for authorization to complete (don't call onAuthorizationPending - already created)
          const authResult = await this.poller.waitForAuthorization(
            existingTransactionId,
          );

          if (authResult.status === "authorized") {
            this.config.onAuthorizationSuccess?.(
              existingTransactionId,
              endpoint,
            );
            return request;
          } else if (authResult.status === "denied") {
            this.config.onAuthorizationDenied?.(
              existingTransactionId,
              endpoint,
            );

            if (this.config.throwOnDenied ?? true) {
              throw new AuthorizationDeniedError(
                existingTransactionId,
                endpoint,
              );
            }
            return request;
          } else {
            // Timeout
            throw new AuthorizationTimeoutError(
              existingTransactionId,
              endpoint,
              this.config.authorizationTimeout ?? 30000,
            );
          }
        }

        case TransactionStatus.DENIED:
        case TransactionStatus.CANCELLED:
          // Transaction was denied/cancelled
          this.config.onAuthorizationDenied?.(existingTransactionId, endpoint);

          if (this.config.throwOnDenied ?? true) {
            throw new AuthorizationDeniedError(existingTransactionId, endpoint);
          }
          return request;

        default:
          // Unknown status - throw error
          throw new Error(
            `Transaction ${existingTransactionId} has unexpected status: ${transaction.status}`,
          );
      }
    }

    // Skip if explicitly disabled via __sapiom
    if (request.__sapiom?.skipAuthorization) {
      return request;
    }

    // Check if endpoint requires authorization
    const requiresAuth = this.shouldAuthorize(request);
    if (!requiresAuth) {
      return request;
    }

    // Get user-provided metadata or build from endpoint rule
    const userMetadata = request.__sapiom;
    const rule = this.findMatchingRule(request);

    const endpoint = request.url;

    // ============================================
    // Collect Request Facts
    // ============================================
    const callSite = captureUserCallSite();

    // Parse URL
    let urlParsed: HttpClientRequestFacts["urlParsed"];
    try {
      const parsed = new URL(request.url);
      urlParsed = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        pathname: parsed.pathname,
        search: parsed.search,
        port: parsed.port ? parseInt(parsed.port) : null,
      };
    } catch {
      // Relative URL
      urlParsed = {
        protocol: "",
        hostname: "",
        pathname: request.url,
        search: "",
        port: null,
      };
    }

    // Sanitize headers (remove auth tokens)
    const sanitizedHeaders: Record<string, string> = {};
    if (request.headers) {
      Object.entries(request.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (
          !lowerKey.includes("auth") &&
          !lowerKey.includes("key") &&
          !lowerKey.includes("token")
        ) {
          sanitizedHeaders[key] = String(value);
        }
      });
    }

    const requestFacts: HttpClientRequestFacts = {
      method: request.method,
      url: request.url,
      urlParsed,
      headers: sanitizedHeaders,
      hasBody: !!request.body,
      bodySizeBytes: request.body
        ? JSON.stringify(request.body).length
        : undefined,
      contentType: request.headers?.["content-type"],
      clientType: "fetch", // TODO: Detect actual client type
      callSite,
      timestamp: new Date().toISOString(),
    };

    // ============================================
    // Create authorization transaction with facts
    // ============================================
    const transaction = await this.config.sapiomClient.transactions.create({
      // NEW: Send request facts
      requestFacts: {
        source: "http-client",
        version: "v1",
        sdk: {
          name: "@sapiom/sdk",
          version: SDK_VERSION,
        },
        request: requestFacts,
      },

      // Allow overrides from user or rule
      serviceName: userMetadata?.serviceName || rule?.serviceName,
      actionName: userMetadata?.actionName || rule?.actionName,
      resourceName: userMetadata?.resourceName,

      // Trace configuration
      traceId: userMetadata?.traceId,
      traceExternalId: userMetadata?.traceExternalId,

      // Agent configuration
      agentId: userMetadata?.agentId,
      agentName: userMetadata?.agentName,

      // Qualifiers and metadata
      qualifiers:
        userMetadata?.qualifiers ||
        (typeof rule?.qualifiers === "function"
          ? rule.qualifiers(request)
          : rule?.qualifiers),
      metadata: {
        ...userMetadata?.metadata,
        ...rule?.metadata,
        preemptiveAuthorization: true,
      },
    });

    // Check for denied or cancelled
    if (
      transaction.status === TransactionStatus.DENIED ||
      transaction.status === TransactionStatus.CANCELLED
    ) {
      this.config.onAuthorizationDenied?.(transaction.id, endpoint);

      if (this.config.throwOnDenied ?? true) {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      }

      return request; // Continue without authorization
    }

    // Check immediate authorization
    if (transaction.status === TransactionStatus.AUTHORIZED) {
      this.config.onAuthorizationSuccess?.(transaction.id, endpoint);

      return {
        ...request,
        headers: setHeader(
          request.headers,
          "X-Sapiom-Transaction-Id",
          transaction.id,
        ),
      };
    }

    // Status is PENDING - wait for authorization
    this.config.onAuthorizationPending?.(transaction.id, endpoint);

    const authResult = await this.poller.waitForAuthorization(transaction.id);

    if (authResult.status === "authorized") {
      this.config.onAuthorizationSuccess?.(transaction.id, endpoint);

      return {
        ...request,
        headers: setHeader(
          request.headers,
          "X-Sapiom-Transaction-Id",
          transaction.id,
        ),
      };
    } else if (authResult.status === "denied") {
      this.config.onAuthorizationDenied?.(transaction.id, endpoint);

      if (this.config.throwOnDenied ?? true) {
        throw new AuthorizationDeniedError(transaction.id, endpoint);
      }

      return request;
    } else {
      // Timeout
      throw new AuthorizationTimeoutError(
        transaction.id,
        endpoint,
        this.config.authorizationTimeout ?? 30000,
      );
    }
  }

  /**
   * Determines if request should be authorized
   * If authorizedEndpoints is empty/undefined, authorize ALL requests
   */
  private shouldAuthorize(request: HttpRequest): boolean {
    // If user provided __sapiom metadata, always authorize
    if (request.__sapiom) {
      return true;
    }

    // If no endpoint patterns configured, authorize everything
    if (
      !this.config.authorizedEndpoints ||
      this.config.authorizedEndpoints.length === 0
    ) {
      return true;
    }

    // Check if request matches any pattern
    return this.findMatchingRule(request) !== undefined;
  }

  /**
   * Finds matching authorization rule for request
   */
  private findMatchingRule(
    request: HttpRequest,
  ): EndpointAuthorizationRule | undefined {
    if (!this.config.authorizedEndpoints) {
      return undefined;
    }

    const method = request.method.toUpperCase();
    const path = request.url;

    return this.config.authorizedEndpoints.find((rule) => {
      // Check method match
      if (rule.method) {
        if (typeof rule.method === "string") {
          if (rule.method.toUpperCase() !== method) return false;
        } else if (Array.isArray(rule.method)) {
          if (!rule.method.map((m) => m.toUpperCase()).includes(method))
            return false;
        } else if (rule.method instanceof RegExp) {
          if (!rule.method.test(method)) return false;
        }
      }

      // Check path match
      return rule.pathPattern.test(path);
    });
  }

  /**
   * Maps HTTP method to transaction action
   */
  private mapMethodToAction(method: string): string {
    const actionMap: Record<string, string> = {
      GET: "read",
      POST: "create",
      PUT: "update",
      PATCH: "update",
      DELETE: "delete",
    };
    return actionMap[method.toUpperCase()] || "execute";
  }

  /**
   * Extracts service name from URL
   */
  private extractServiceFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      return pathParts[0] || "api";
    } catch {
      // Relative URL - extract from path
      const pathParts = url.split("/").filter(Boolean);
      return pathParts[0] || "api";
    }
  }
}
