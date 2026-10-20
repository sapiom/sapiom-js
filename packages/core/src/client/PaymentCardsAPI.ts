import type {
  CardSpendingLimitsSettings,
  CardPurchaseApprovalSettings,
  CreateCardSetupLinkInput,
  CardSetupLinkView,
  CardSpendingLimitsSummary,
} from "../types/payment-card.js";
import type { HttpClient } from "./HttpClient.js";

/** Saved-card purchase policies for a trusted platform backend. Purchasing keys cannot edit policy. */
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

  /** Read the card-owned purchase approval setting. Requires org.read. */
  async getPurchaseApproval(
    cardId: string,
  ): Promise<CardPurchaseApprovalSettings> {
    return this.httpClient.request({
      method: "GET",
      url: `/payment-cards/${encodeURIComponent(cardId)}/purchase-approval`,
    });
  }

  /** Requires org.write and the current version. Disabling only pauses this card's backing rule. */
  async setPurchaseApproval(
    cardId: string,
    settings: CardPurchaseApprovalSettings,
  ): Promise<CardPurchaseApprovalSettings> {
    return this.httpClient.request({
      method: "PUT",
      url: `/payment-cards/${encodeURIComponent(cardId)}/purchase-approval`,
      body: settings,
    });
  }

  /** Mint a one-card hosted vault link. Purchase-approval options require org.write in addition to card setup permission. */
  async createSetupLink(
    input: CreateCardSetupLinkInput = {},
  ): Promise<CardSetupLinkView & { url: string }> {
    return this.httpClient.request({
      method: "POST",
      url: "/payment-cards/setup-links",
      body: input,
    });
  }

  /** Read completion and the created card's ID. The bearer URL is returned only when the link is minted. */
  async getSetupLink(linkId: string): Promise<CardSetupLinkView> {
    return this.httpClient.request({
      method: "GET",
      url: `/payment-cards/setup-links/${encodeURIComponent(linkId)}`,
    });
  }
}
