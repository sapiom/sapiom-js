import type { HttpClient } from "./HttpClient.js";
import type {
  PaymentMethodListOptions,
  PaymentMethodPage,
  PaymentMethodView,
  PaymentMethodSpendingLimitsSettings,
  PaymentMethodSpendingLimitsSummary,
} from "../types/payment-method.js";

/** Discovery uses the buyer key. Limit management requires an explicit management grant. */
export class PaymentMethodsAPI {
  constructor(private readonly httpClient: HttpClient) {}

  list(options: PaymentMethodListOptions = {}): Promise<PaymentMethodPage> {
    return this.httpClient.request({
      url: "/payment-methods",
      params: {
        sort: options.sort,
        "page[limit]": options.limit,
        "page[after]": options.after,
        "page[before]": options.before,
      },
    });
  }

  get(methodId: string): Promise<PaymentMethodView> {
    return this.httpClient.request({
      url: `/payment-methods/${encodeURIComponent(methodId)}`,
    });
  }

  /** Requires org.payment_method_spending_limits.read for the buyer. */
  getSpendingLimits(
    methodId: string,
  ): Promise<PaymentMethodSpendingLimitsSummary> {
    return this.httpClient.request({
      url: `/payment-methods/${encodeURIComponent(methodId)}/spending-limits`,
    });
  }

  /** Read the version first. Requires explicit org.payment_method_spending_limits.write. */
  setSpendingLimits(
    methodId: string,
    settings: PaymentMethodSpendingLimitsSettings,
  ): Promise<PaymentMethodSpendingLimitsSummary> {
    return this.httpClient.request({
      method: "PUT",
      url: `/payment-methods/${encodeURIComponent(methodId)}/spending-limits`,
      body: settings,
      retry: false,
    });
  }
}
