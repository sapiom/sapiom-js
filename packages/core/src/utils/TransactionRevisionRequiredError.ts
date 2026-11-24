import type { TransactionResponse } from "../types/transaction.js";

/** A policy decision, not an SDK outage: callers must change the purchase before trying again. */
export class TransactionRevisionRequiredError extends Error {
  readonly transactionId: string;
  readonly nextAction: TransactionResponse["nextAction"];

  constructor(public readonly transaction: TransactionResponse) {
    super(`Transaction ${transaction.id} requires a revised purchase`);
    this.name = "TransactionRevisionRequiredError";
    this.transactionId = transaction.id;
    this.nextAction = transaction.nextAction;
  }
}
