import type {
  CardSpendingLimitsSettings,
  CardSpendingLimitsSummary,
  PaymentCardView,
  CardSetupLinkView,
} from "../types/payment-card.js";
import type { HttpClient } from "./HttpClient.js";

/** Management methods for a trusted platform backend; purchasing keys cannot change limits. */
export class PaymentCardsAPI {
  constructor(private readonly httpClient: HttpClient) {}

  /** Read a card's versioned spending limits and current usage. Requires org.card_spending_limits.read. */
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
      retry: false,
    });
  }
  list(): Promise<{ data: PaymentCardView[] }> {
    return this.httpClient.request({ url: "/payment-cards" });
  }
  get(cardId: string): Promise<PaymentCardView> {
    return this.httpClient.request({
      url: `/payment-cards/${encodeURIComponent(cardId)}`,
    });
  }
  /** Returns a bearer URL once. A lost answer must not trigger automatic setup-link creation. */
  createSetupLink(
    input: { returnUrl?: string } = {},
  ): Promise<CardSetupLinkView & { url: string }> {
    return this.httpClient.request({
      method: "POST",
      url: "/payment-cards/setup-links",
      body: input,
      retry: false,
    });
  }
  getSetupLink(linkId: string): Promise<CardSetupLinkView> {
    return this.httpClient.request({
      url: `/payment-cards/setup-links/${encodeURIComponent(linkId)}`,
    });
  }
  setDefault(cardId: string): Promise<PaymentCardView> {
    return this.httpClient.request({
      method: "PUT",
      url: `/payment-cards/${encodeURIComponent(cardId)}/default`,
      retry: false,
    });
  }
  remove(cardId: string): Promise<void> {
    return this.httpClient.request({
      method: "DELETE",
      url: `/payment-cards/${encodeURIComponent(cardId)}`,
      retry: false,
    });
  }
}
