import type {
  CardSpendingLimitsSettings,
  CardSpendingLimitsSummary,
} from "../types/payment-card.js";
import type { HttpClient } from "./HttpClient.js";

/** Management methods for a trusted platform backend; purchasing keys cannot change limits. */
export class PaymentCardsAPI {
  constructor(private readonly httpClient: HttpClient) {}

  /** Read a card's versioned spending limits and current usage. Requires org.read. */
  async getSpendingLimits(cardId: string): Promise<CardSpendingLimitsSummary> {
    return this.httpClient.request({
      method: "GET",
      url: `/payment-cards/${encodeURIComponent(cardId)}/spending-limits`,
    });
  }

  /** All slots are explicit. Changed cumulative settings start fresh; unchanged saves preserve usage. */
  async setSpendingLimits(
    cardId: string,
    settings: CardSpendingLimitsSettings,
  ): Promise<CardSpendingLimitsSummary> {
    return this.httpClient.request({
      method: "PUT",
      url: `/payment-cards/${encodeURIComponent(cardId)}/spending-limits`,
      body: settings,
    });
  }
}
