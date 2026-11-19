/** Positive USD amounts are decimal strings with at most two fractional digits. */
export interface PaymentMethodMoneyLimit {
  amount: string;
  currency: "USD";
}
export interface PaymentMethodRecurringLimit extends PaymentMethodMoneyLimit {
  period: "week" | "month" | "year";
}
export interface PaymentMethodCustomLimit extends PaymentMethodMoneyLimit {
  /** UTC YYYY-MM-DD; both supplied dates are inclusive. */
  startDate: string;
  endDate: string;
}
export interface PaymentMethodSpendingLimitsSettings {
  /** Use the version returned by getSpendingLimits; 0 means no configuration exists yet. */
  version: number;
  purchaseLimit: PaymentMethodMoneyLimit | null;
  recurringLimit: PaymentMethodRecurringLimit | null;
  customLimit: PaymentMethodCustomLimit | null;
}
export interface PaymentMethodAllowanceUsage {
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
export interface PaymentMethodSpendingLimitsSummary extends PaymentMethodSpendingLimitsSettings {
  ruleId: string | null;
  status: "active" | "paused" | "removed";
  evaluatedAt: string;
  /** Indicates effective configuration; each proposed purchase is still checked against all limits. */
  configurationActive: boolean;
  /** Other matching or conditional payment rules, edited through the Rules API. */
  additionalLimits: PaymentLimitSummary[];
  usage: {
    purchaseLimit?: null;
    recurringLimit?: PaymentMethodAllowanceUsage;
    customLimit?: PaymentMethodAllowanceUsage;
  };
}
export interface PaymentLimitSummary {
  ruleId: string;
  constraintId: string;
  name: string;
  /** Conditional rules need the complete transaction context to establish applicability. */
  scope: "match" | "unavailable";
  limit: { kind: "money"; amount: string; currency: "USD" };
  groupBy: Array<
    "agent" | "trace" | "service" | "paymentCardId" | "paymentMethodId"
  >;
  usage: PaymentMethodAllowanceUsage | null;
}

/** Safe common presentation; unfamiliar kinds remain displayable without inventing card fields. */
export interface PaymentMethodView {
  id: string;
  kind: string;
  label: string;
  status: "pending" | "active" | "removed" | "failed";
  readiness: string;
  readinessReasons: string[];
  readinessCodes: string[];
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  nickname?: string | null;
  environment?: "test" | "live";
  /** Present only for cards; not a default across kinds. */
  isDefault?: boolean;
  routes?: Array<{ program: string; status: string; errorCode: string | null }>;
}
export interface PaymentMethodPage {
  data: PaymentMethodView[];
  links: { self: string; next: string | null; prev: string | null };
  meta: { page: { limit: number; hasNext: boolean; hasPrev: boolean } };
}
export interface PaymentMethodListOptions {
  sort?: "created_at" | "-created_at" | "updated_at" | "-updated_at";
  limit?: number;
  after?: string;
  before?: string;
}
