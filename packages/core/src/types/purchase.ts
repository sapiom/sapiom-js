/** Decimal strings in major currency units. */
export interface PurchaseMoney {
  amount: string;
  currency: string;
}
export interface PurchaseMerchant {
  origin: string;
  name?: string;
  countryCode?: string;
}
export type TransactionFunding =
  | {
      paymentMethodId: string;
      source?: never;
      paymentCardId?: never;
      paymentBudgetId?: never;
    }
  | {
      source: "external_card";
      paymentCardId?: string;
      paymentBudgetId?: string;
      paymentMethodId?: never;
    };

export interface PurchaseShipping {
  address?: {
    first_name?: string;
    last_name?: string;
    street_address: string;
    extended_address?: string;
    address_locality: string;
    address_region?: string;
    postal_code?: string;
    address_country: string;
  };
  contact?: { email?: string; phone_number?: string };
}
export type PurchaseRequest =
  | {
      type: "ucp_checkout";
      merchant: PurchaseMerchant;
      checkout: Record<string, unknown>;
    }
  | {
      type: "browser_checkout";
      merchant: PurchaseMerchant;
      total: { amount: string; currency: "USD" };
      description?: string;
      claimedLineItems?: {
        title: string;
        quantity: number;
        unitAmount?: string;
      }[];
      pageUrl?: string;
    };
/** Retain this key outside the SDK: the same request and key resume an uncertain create. */
export interface PurchaseWriteOptions {
  idempotencyKey: string;
}
export interface PurchaseWaitOptions {
  since?: string;
  maxWaitSeconds?: number;
}
export interface PurchaseView {
  type: PurchaseRequest["type"];
  assertedBy: "merchant" | "agent";
  merchant: PurchaseMerchant;
  total: PurchaseMoney | null;
  lineItems?: {
    title?: string;
    itemId?: string;
    quantity: number;
    unitAmount?: string;
  }[];
  revision?: number;
}
export type PurchaseOrder =
  | {
      outcome: "confirmed";
      id: string | null;
      label: string | null;
      permalinkUrl: string | null;
      links: { type: string; url: string; title?: string }[];
    }
  | { outcome: "not_confirmed" | "unknown" };
export interface TransactionCompatibility {
  merchant: { domain: string; origin: string };
  status: "supported" | "unsupported" | "unknown";
  reason: string;
  protocol: { name: "ucp"; version: string } | null;
  capabilities: { name: string; supported: boolean }[];
  checkedAt: string;
  expiresAt: string;
  retryAfterSeconds: number | null;
}
export type CheckoutNextAction =
  | {
      action: "wait";
      reason: "governing" | "paying" | "merchant";
      retryAfterSeconds: number;
    }
  | { action: "refresh"; retryAfterSeconds: number }
  | { action: "update"; messages: unknown[] }
  | {
      action: "revise";
      reasons: { ruleId: string; code: string; message: string }[];
    }
  | {
      action: "requires_action";
      kind: "security_code" | "approval" | "budget_verification" | "escalation";
      url: string | null;
      expiresAt: string | null;
      denial: Record<string, unknown> | null;
      messages: unknown[];
    }
  | {
      action: "hand_off";
      actor?: "buyer";
      continueUrl: string;
      buyerMessages: unknown[];
    }
  | { action: "submitted" | "done" }
  | {
      action: "blocked" | "closed";
      reason?: string;
      message?: string;
      [field: string]: unknown;
    };
export interface CheckoutEnvelope {
  checkout: {
    id: string | null;
    status: string;
    currency: string | null;
    totals: Record<string, unknown>[];
    lineItems: Record<string, unknown>[];
    fulfillmentMethods: Record<string, unknown>[];
    messages: unknown[];
    expiresAt: string | null;
    continueUrl: string | null;
    continueUrlWithheld: boolean;
    order: {
      id: string;
      label: string | null;
      permalinkUrl: string | null;
    } | null;
    links: { type: string; url: string; title?: string }[];
  } | null;
  session: {
    state: string;
    merchantOrigin: string;
    negotiatedVersion: string;
    transport: string;
    completion: "api_possible" | "handoff_only" | "unknown";
    observationSeq: number | null;
    expiresAt: string | null;
  };
  governance: {
    revision: number;
    decision:
      | "pending"
      | "waiting_approval"
      | "authorized"
      | "denied"
      | "closed";
    evidenceObservationSeq: number | null;
    reasons: { ruleId: string; code: string; message: string }[];
    current: boolean;
    blocker: string | null;
    closeReason?: string | null;
    closeRequestId?: string | null;
    closeMessages?: unknown[] | null;
  };
  payment: {
    paymentMethodId?: string | null;
    paymentMethodKind?: string;
    kind?: string;
    status:
      | "none"
      | "pending"
      | "preparing"
      | "authorized"
      | "settling"
      | "completed"
      | "failed"
      | "cancelled";
    amount: string | null;
    paymentCardId: string | null;
    denial: Record<string, unknown> | null;
    placeholder: {
      number: string;
      expMonth: number;
      expYear: number;
      cvc: string;
      brand: string;
      expiresAt: string;
      injectionRef: string;
      transactionId: string;
    } | null;
    submitted: boolean;
  } | null;
  nextAction: CheckoutNextAction;
  version: string;
}
