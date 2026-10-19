/** Positive USD amounts are decimal strings with at most two fractional digits. */
export interface CardMoneyLimit {
  amount: string;
  currency: "USD";
}
export interface CardRecurringLimit extends CardMoneyLimit {
  period: "week" | "month" | "year";
}
export interface CardCustomLimit extends CardMoneyLimit {
  /** UTC YYYY-MM-DD; both supplied dates are inclusive. */
  startDate: string;
  endDate: string;
}
export interface CardSpendingLimitsSettings {
  /** Use the version returned by getSpendingLimits; 0 means no configuration exists yet. */
  version: number;
  purchaseLimit: CardMoneyLimit | null;
  recurringLimit: CardRecurringLimit | null;
  customLimit: CardCustomLimit | null;
}
export interface CardAllowanceUsage {
  available: boolean;
  state: "active" | "future" | "expired" | "inactive" | "unavailable";
  currency: "USD";
  allowanceVersion: number;
  startInclusive: string;
  endExclusive: string;
  resetAt: string | null;
  effectiveStartInclusive: string | null;
  /** Unavailable evidence produces null quantities, never an invented zero. */
  confirmedSpend: string | null;
  pendingCommitted: string | null;
  confirmedRefunds: string | null;
  used: string | null;
  remaining: string | null;
}
export interface CardSpendingLimitsSummary extends CardSpendingLimitsSettings {
  ruleId: string | null;
  status: "active" | "paused" | "removed";
  evaluatedAt: string;
  /** Indicates effective configuration; each proposed purchase is still checked against all limits. */
  configurationActive: boolean;
  usage: {
    purchaseLimit?: null;
    recurringLimit?: CardAllowanceUsage;
    customLimit?: CardAllowanceUsage;
  };
}
export interface RefundConfirmationRequest {
  paymentTransactionId: string;
  externalRefundId: string;
  amount: string;
  currency: "USD";
  confirmedAt: string;
  idempotencyKey: string;
  evidence: {
    source: "trusted_platform";
    sourceReference: string;
    merchantOrderId: string;
  };
}
export interface RefundConfirmationReceipt {
  id: string;
  paymentTransactionId: string;
  state: "applied" | "pending" | "conflicting" | "superseded";
  amount: string;
  currency: "USD";
  confirmedAt: string;
}
