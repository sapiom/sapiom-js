/**
 * Core transaction authorization logic
 *
 * Centralized logic for creating and authorizing Sapiom transactions.
 * Used by both HTTP adapters and LangChain integration.
 */

import { SapiomClient } from "../client/SapiomClient";
import { TransactionPoller } from "../client/TransactionPoller";
import type {
  TransactionResponse,
  CreateTransactionRequest,
} from "../types/transaction";

/**
 * Parameters for creating and authorizing a transaction
 */
export interface AuthorizeTransactionParams {
  /**
   * Integration facts for backend inference (NEW)
   * When provided, backend infers serviceName/actionName/resourceName
   */
  requestFacts?: {
    source: string;
    version: string;
    sdk: Record<string, any>;
    request: Record<string, any>;
  };

  /**
   * Service identifier (optional if requestFacts provided)
   * Examples: "openai", "anthropic", "tool", "database"
   */
  serviceName?: string;

  /**
   * Action being performed (optional if requestFacts provided)
   * Examples: "generate", "call", "query"
   */
  actionName?: string;

  /**
   * Resource being accessed (optional if requestFacts provided)
   * Examples: "gpt-4", "weather_tool", "users_table"
   */
  resourceName?: string;

  /**
   * Workflow trace identifier (UUID)
   * Uses existing trace by internal ID
   */
  traceId?: string;

  /**
   * External trace identifier (user-provided)
   * Finds or creates trace
   */
  traceExternalId?: string;

  /**
   * Agent identifier (UUID or numeric ID like AG-001)
   * Uses existing agent
   */
  agentId?: string;

  /**
   * Agent name for find-or-create behavior
   * If agent with this name exists, uses it; otherwise creates new ACTIVE agent
   */
  agentName?: string;

  /**
   * Additional context about the operation
   */
  qualifiers?: Record<string, any>;

  /**
   * Payment data if operation requires payment
   */
  paymentData?: any;

  /**
   * Transaction costs (estimated or actual)
   * Optional if requestFacts provided (backend calculates)
   */
  costs?: Array<{
    fiatAmount: string;
    fiatAssetSymbol: string;
    isEstimate: boolean;
    costDetails?: Record<string, any>;
  }>;

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;
}

/**
 * Configuration for TransactionAuthorizer
 */
export interface TransactionAuthorizerConfig {
  /**
   * Sapiom client instance
   */
  sapiomClient: SapiomClient;

  /**
   * Authorization timeout in milliseconds
   * @default 30000
   */
  authorizationTimeout?: number;

  /**
   * Polling interval in milliseconds
   * @default 1000
   */
  pollingInterval?: number;

  /**
   * Callbacks
   */
  onAuthorizationPending?: (transactionId: string, resource: string) => void;
  onAuthorizationSuccess?: (transactionId: string, resource: string) => void;
  onAuthorizationDenied?: (
    transactionId: string,
    resource: string,
    reason?: string,
  ) => void;

  /**
   * Whether to throw on authorization denial
   * @default true
   */
  throwOnDenied?: boolean;
}

/**
 * Error thrown when transaction authorization is denied
 */
export class TransactionDeniedError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly resource: string,
    public readonly reason?: string,
  ) {
    super(
      `Transaction denied for ${resource}: ${reason || "No reason provided"}`,
    );
    this.name = "TransactionDeniedError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TransactionDeniedError);
    }
  }
}

/**
 * Error thrown when transaction authorization times out
 */
export class TransactionTimeoutError extends Error {
  constructor(
    public readonly transactionId: string,
    public readonly resource: string,
    public readonly timeout: number,
  ) {
    super(`Authorization timeout after ${timeout}ms for ${resource}`);
    this.name = "TransactionTimeoutError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TransactionTimeoutError);
    }
  }
}

/**
 * Core transaction authorizer
 *
 * Provides centralized logic for:
 * - Creating transactions with trace support
 * - Waiting for authorization
 * - Handling denied/timeout scenarios
 *
 * Used by:
 * - HTTP adapters (via AuthorizationHandler)
 * - LangChain integration (model, tool, agent wrappers)
 * - Any other integration needing transaction authorization
 */
export class TransactionAuthorizer {
  private poller: TransactionPoller;
  private config: TransactionAuthorizerConfig;

  constructor(config: TransactionAuthorizerConfig) {
    this.config = config;
    this.poller = new TransactionPoller(config.sapiomClient, {
      timeout: config.authorizationTimeout,
      pollInterval: config.pollingInterval,
    });
  }

  /**
   * Create transaction and wait for authorization
   *
   * This is the core method that all integrations should use.
   * Handles transaction creation, polling, and error scenarios.
   *
   * @param params - Transaction parameters
   * @returns Authorized transaction
   * @throws TransactionDeniedError if denied and throwOnDenied is true
   * @throws TransactionTimeoutError if authorization times out
   *
   * @example
   * ```typescript
   * const authorizer = new TransactionAuthorizer({ sapiomClient });
   *
   * const tx = await authorizer.createAndAuthorize({
   *   serviceName: "openai",
   *   actionName: "generate",
   *   resourceName: "gpt-4",
   *   traceExternalId: "my-workflow",
   *   qualifiers: { estimatedTokens: 100 }
   * });
   * ```
   */
  async createAndAuthorize(
    params: AuthorizeTransactionParams,
  ): Promise<TransactionResponse> {
    // Handle case where both agentId and agentName are provided
    // Prefer agentId (explicit reference) over agentName (find-or-create)
    const agentId = params.agentId;
    let agentName = params.agentName;

    if (params.agentId && params.agentName) {
      console.warn(
        "[Sapiom SDK] Both agentId and agentName provided. " +
          `Preferring agentId="${params.agentId}" over agentName="${params.agentName}". ` +
          "To avoid this warning, provide only one.",
      );
      // Prefer agentId (explicit reference to existing agent)
      agentName = undefined;
    }

    // Create transaction
    const tx = await this.config.sapiomClient.transactions.create({
      requestFacts: params.requestFacts,
      serviceName: params.serviceName,
      actionName: params.actionName,
      resourceName: params.resourceName,
      traceId: params.traceId,
      traceExternalId: params.traceExternalId,
      agentId,
      agentName,
      qualifiers: params.qualifiers,
      paymentData: params.paymentData,
      costs: params.costs,
      metadata: params.metadata,
    });

    this.config.onAuthorizationPending?.(
      tx.id,
      params.resourceName || "unknown",
    );

    // Wait for authorization using centralized poller
    const result = await this.poller.waitForAuthorization(tx.id);

    // Handle result
    if (result.status === "authorized") {
      this.config.onAuthorizationSuccess?.(
        tx.id,
        params.resourceName || "unknown",
      );
      return result.transaction;
    }

    if (result.status === "denied") {
      const reason =
        (result.transaction as any).declineReason || "Transaction denied";
      this.config.onAuthorizationDenied?.(
        tx.id,
        params.resourceName || "unknown",
        reason,
      );

      if (this.config.throwOnDenied !== false) {
        throw new TransactionDeniedError(
          tx.id,
          params.resourceName || "unknown",
          reason,
        );
      }

      return result.transaction;
    }

    // Timeout
    throw new TransactionTimeoutError(
      tx.id,
      params.resourceName || "unknown",
      this.config.authorizationTimeout || 30000,
    );
  }

  /**
   * Wait for an existing transaction to be authorized
   *
   * Use this when you have a transaction ID from a header or external source
   * and just need to wait for its authorization.
   *
   * @param transactionId - Existing transaction ID
   * @returns Authorized transaction
   * @throws TransactionDeniedError if denied
   * @throws TransactionTimeoutError if timeout
   */
  async waitForExisting(transactionId: string): Promise<TransactionResponse> {
    const result = await this.poller.waitForAuthorization(transactionId);

    if (result.status === "authorized") {
      return result.transaction;
    }

    if (result.status === "denied") {
      const reason =
        (result.transaction as any).declineReason || "Transaction denied";

      if (this.config.throwOnDenied !== false) {
        throw new TransactionDeniedError(transactionId, "unknown", reason);
      }

      return result.transaction;
    }

    // Timeout
    throw new TransactionTimeoutError(
      transactionId,
      "unknown",
      this.config.authorizationTimeout || 30000,
    );
  }

  /**
   * Get the Sapiom client instance
   */
  get client(): SapiomClient {
    return this.config.sapiomClient;
  }
}
