import {
  CompleteTransactionRequest,
  CompleteTransactionResult,
  CreateTransactionRequest,
  ListTransactionsParams,
  PaymentProtocolData,
  TransactionResponse,
  TransactionStatus,
  TransactionCostInput,
  TransactionCostResponse,
} from "../types/transaction";
import type { HttpClient } from "./HttpClient";

export class TransactionAPI {
  constructor(private readonly httpClient: HttpClient) {}

  /**
   * Create a new transaction
   * @param data The transaction data
   * @returns The created transaction response
   */
  async create(data: CreateTransactionRequest): Promise<TransactionResponse> {
    return await this.httpClient.request<TransactionResponse>({
      method: "POST",
      url: "/transactions",
      body: data,
    });
  }

  /**
   * Get a specific transaction by ID
   * @param transactionId The transaction ID
   * @returns The transaction details
   */
  async get(transactionId: string): Promise<TransactionResponse> {
    return await this.httpClient.request<TransactionResponse>({
      method: "GET",
      url: `/transactions/${transactionId}`,
    });
  }

  /**
   * Helper method to check if a transaction is authorized
   */
  isAuthorized(transaction: TransactionResponse): boolean {
    return transaction.status === "authorized";
  }

  /**
   * Helper method to check if a transaction is completed
   */
  isCompleted(transaction: TransactionResponse): boolean {
    return transaction.status === TransactionStatus.COMPLETED;
  }

  /**
   * Helper method to check if a transaction requires payment
   */
  requiresPayment(transaction: TransactionResponse): boolean {
    return transaction.requiresPayment;
  }

  /**
   * Helper method to get the payment details from a transaction
   */
  getPaymentDetails(transaction: TransactionResponse) {
    if (!transaction.requiresPayment || !transaction.payment) {
      return null;
    }
    return transaction.payment;
  }

  /**
   * Reauthorize an existing authorized transaction with payment protocol data
   * @param transactionId The transaction ID to reauthorize
   * @param data The payment protocol data (x402, etc.)
   * @returns The updated transaction response with payment details
   */
  async reauthorizeWithPayment(
    transactionId: string,
    data: PaymentProtocolData,
  ): Promise<TransactionResponse> {
    return await this.httpClient.request<TransactionResponse>({
      method: "POST",
      url: `/transactions/${transactionId}/reauthorize`,
      body: data,
    });
  }

  /**
   * Add a cost to an existing transaction
   *
   * Used to submit actual costs that supersede estimates after LLM execution.
   *
   * @param transactionId - Transaction ID
   * @param cost - Cost data (include supersedesCostId to replace estimate)
   * @returns Created TransactionCost
   *
   * @example
   * ```typescript
   * // Submit actual cost superseding estimate
   * await client.transactions.addCost(txId, {
   *   fiatAmount: "0.250000000000000000",
   *   fiatAssetSymbol: "USD",
   *   isEstimate: false,
   *   supersedesCostId: estimatedCostId,
   *   costDetails: { inputTokens: 1000, outputTokens: 5000 }
   * });
   * ```
   */
  async addCost(
    transactionId: string,
    cost: TransactionCostInput & { supersedesCostId?: string },
  ): Promise<TransactionCostResponse> {
    return await this.httpClient.request<TransactionCostResponse>({
      method: "POST",
      url: `/transactions/${transactionId}/costs`,
      body: cost,
    });
  }

  /**
   * Add facts to an existing transaction
   *
   * Used to submit integration facts (request, response, error, partial) that enable
   * backend inference and cost calculation. Replaces addCost() for facts-based integrations.
   *
   * Backend automatically:
   * - Validates facts against schema
   * - Calculates costs from facts
   * - Supersedes estimate costs (SDK doesn't need to track cost IDs!)
   *
   * @param transactionId - Transaction ID
   * @param data - Fact data with source, version, phase, and facts
   * @returns Success indicator with created fact ID
   *
   * @example
   * ```typescript
   * // Submit response facts after LLM completion
   * await client.transactions.addFacts(txId, {
   *   source: "langchain-llm",
   *   version: "v1",
   *   factPhase: "response",
   *   facts: {
   *     actualInputTokens: 1250,
   *     actualOutputTokens: 543,
   *     finishReason: "stop",
   *   }
   * });
   * // Backend finds and supersedes the estimate automatically!
   * ```
   */
  async addFacts(
    transactionId: string,
    data: {
      source: string;
      version: string;
      factPhase: "request" | "response" | "partial" | "error";
      facts: Record<string, any>;
    },
  ): Promise<{ success: boolean; factId: string; costId?: string }> {
    return await this.httpClient.request({
      method: "POST",
      url: `/transactions/${transactionId}/facts`,
      body: data,
    });
  }

  /**
   * Complete an authorized transaction
   *
   * Marks an AUTHORIZED transaction as COMPLETED with an outcome (success/error).
   * Optionally stores response or error facts for cost calculation and analytics.
   *
   * This should be called fire-and-forget style - there's no need to block on it.
   *
   * @param transactionId - The transaction ID to complete
   * @param data - The completion data with outcome and optional response facts
   * @returns CompleteTransactionResult with transaction and optional fact/cost IDs
   *
   * @example
   * ```typescript
   * // Fire-and-forget after operation completes successfully
   * client.transactions
   *   .complete(transactionId, {
   *     outcome: 'success',
   *     responseFacts: {
   *       source: 'my-service',
   *       version: 'v1',
   *       facts: { duration: 234, itemsProcessed: 50 }
   *     }
   *   })
   *   .catch(err => console.error('Failed to complete transaction:', err));
   *
   * // On error
   * client.transactions
   *   .complete(transactionId, {
   *     outcome: 'error',
   *     responseFacts: {
   *       source: 'my-service',
   *       version: 'v1',
   *       facts: { errorType: 'TimeoutError', errorMessage: 'Request timed out' }
   *     }
   *   })
   *   .catch(err => console.error('Failed to complete transaction:', err));
   * ```
   */
  async complete(
    transactionId: string,
    data: CompleteTransactionRequest,
  ): Promise<CompleteTransactionResult> {
    return await this.httpClient.request<CompleteTransactionResult>({
      method: "POST",
      url: `/transactions/${transactionId}/complete`,
      body: data,
    });
  }
}
