import { TransactionStatus } from "../types/transaction";
import { TransactionResponse } from "../types/transaction";
import { SapiomClient } from "./SapiomClient";

/**
 * Transaction polling result
 */
export type TransactionPollResult =
  | { status: "authorized"; transaction: TransactionResponse }
  | { status: "denied"; transaction: TransactionResponse }
  | { status: "timeout" };

/**
 * Configuration for transaction polling
 */
export interface TransactionPollingConfig {
  timeout?: number; // Default: 30000ms
  pollInterval?: number; // Default: 1000ms
}

/**
 * Shared transaction polling with atomic reference counting
 * Used by both PaymentHandler and AuthorizationHandler
 */
export class TransactionPoller {
  private pollingPromises = new Map<
    string,
    {
      promise: Promise<TransactionPollResult>;
      refCount: number;
    }
  >();

  constructor(
    private sapiomClient: SapiomClient,
    private config: TransactionPollingConfig,
  ) {}

  /**
   * Polls transaction status until authorized/denied/timeout
   * Uses atomic Map.set() operations to prevent race conditions
   */
  async waitForAuthorization(
    transactionId: string,
  ): Promise<TransactionPollResult> {
    const entry = this.pollingPromises.get(transactionId);

    if (entry) {
      // Atomic increment
      this.pollingPromises.set(transactionId, {
        promise: entry.promise,
        refCount: entry.refCount + 1,
      });

      try {
        return await entry.promise;
      } finally {
        // Atomic decrement
        const current = this.pollingPromises.get(transactionId);
        if (current && current.refCount > 1) {
          this.pollingPromises.set(transactionId, {
            promise: current.promise,
            refCount: current.refCount - 1,
          });
        } else {
          this.pollingPromises.delete(transactionId);
        }
      }
    }

    const pollingPromise = this.pollTransactionStatus(transactionId);

    this.pollingPromises.set(transactionId, {
      promise: pollingPromise,
      refCount: 1,
    });

    try {
      return await pollingPromise;
    } finally {
      const current = this.pollingPromises.get(transactionId);
      if (current) {
        const newCount = current.refCount - 1;
        if (newCount === 0) {
          this.pollingPromises.delete(transactionId);
        } else {
          this.pollingPromises.set(transactionId, {
            ...current,
            refCount: newCount,
          });
        }
      }
    }
  }

  /**
   * Internal polling implementation
   * Returns the final transaction to avoid redundant API calls
   */
  private async pollTransactionStatus(
    transactionId: string,
  ): Promise<TransactionPollResult> {
    const timeout = this.config.timeout ?? 30000;
    const pollInterval = this.config.pollInterval ?? 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const transaction =
        await this.sapiomClient.transactions.get(transactionId);

      if (transaction.status === TransactionStatus.AUTHORIZED) {
        return { status: "authorized", transaction };
      }

      if (
        transaction.status === TransactionStatus.DENIED ||
        transaction.status === TransactionStatus.CANCELLED
      ) {
        return { status: "denied", transaction };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return { status: "timeout" };
  }
}
