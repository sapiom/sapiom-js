/** Card-compatible names share the generic settings and accounting contract. */
export type {
  PaymentMethodMoneyLimit as CardMoneyLimit,
  PaymentMethodRecurringLimit as CardRecurringLimit,
  PaymentMethodCustomLimit as CardCustomLimit,
  PaymentMethodSpendingLimitsSettings as CardSpendingLimitsSettings,
  PaymentMethodAllowanceUsage as CardAllowanceUsage,
  PaymentMethodSpendingLimitsSummary as CardSpendingLimitsSummary,
  PaymentLimitSummary,
} from "./payment-method.js";

export interface PaymentCardView {
  id: string;
  status: "pending" | "active" | "removed" | "failed";
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  nickname: string | null;
  environment: "test" | "live";
  isDefault: boolean;
  readiness: "agentic" | "real_card_number" | "not_ready";
  readinessReasons: string[];
  readinessCodes: string[];
  routes: Array<{ program: string; status: string; errorCode: string | null }>;
  createdAt: string;
  removedAt: string | null;
}
export interface CardSetupLinkView {
  id: string;
  status: "open" | "completed" | "canceled" | "expired";
  expiresAt: string;
  returnUrl: string | null;
  cardId: string | null;
  createdAt: string;
  completedAt: string | null;
  canceledAt: string | null;
}
