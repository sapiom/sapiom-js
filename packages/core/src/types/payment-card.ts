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
  startInclusive: string | null;
  endExclusive: string | null;
  resetAt: string | null;
  /** Unavailable evidence produces null quantities, never an invented zero. */
  /** Irreversibly consumed payments; card payments become spent on credential release. */
  spent: string | null;
  pendingCommitted: string | null;
  used: string | null;
  remaining: string | null;
}
export interface CardSpendingLimitsSummary extends CardSpendingLimitsSettings {
  ruleId: string | null;
  status: "active" | "paused" | "removed";
  evaluatedAt: string;
  /** Indicates effective configuration; each proposed purchase is still checked against all limits. */
  configurationActive: boolean;
  /** Other matching or conditional payment rules, edited through the Rules API. */
  additionalLimits: PaymentLimitSummary[];
  usage: {
    purchaseLimit?: null;
    recurringLimit?: CardAllowanceUsage;
    customLimit?: CardAllowanceUsage;
  };
}
export interface PaymentLimitSummary {
  ruleId: string;
  constraintId: string;
  name: string;
  /** Conditional rules need the complete transaction context to establish applicability. */
  scope: "match" | "unavailable";
  limit: { kind: "money"; amount: string; currency: "USD" };
  groupBy: Array<"agent" | "trace" | "service" | "paymentCardId">;
  usage: CardAllowanceUsage | null;
}
