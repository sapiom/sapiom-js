import type { HeldPlaceholder, PaymentRelay } from "../../src/index.js";
import { SHOPIFY_PAYMENTS_TEST_CARD } from "./shopify-payments-test-card.js";
import {
  forwardRequestHeaders,
  providerResponseHeaders,
  replacePlaceholderCard,
} from "./replace-card.js";

/**
 * Demo relay that forwards the paused request with Shopify Payments' published
 * test card in place of the placeholder. Not part of the published SDK.
 * The dev store rejects the old Bogus Gateway success value ("1").
 */
export const BOGUS_CARD = SHOPIFY_PAYMENTS_TEST_CARD;

export function bogusShopifyRelay(options: {
  placeholder: HeldPlaceholder;
  fetchImpl?: typeof fetch;
}): PaymentRelay {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async relay(request) {
      const body = replacePlaceholderCard(
        request.body,
        options.placeholder.number,
        {
          number: BOGUS_CARD.number,
          expMonth: BOGUS_CARD.expMonth,
          expYear: BOGUS_CARD.expYear,
          cvc: BOGUS_CARD.cvc,
        },
      );
      const response = await fetchImpl(request.url, {
        method: request.method,
        redirect: "manual",
        headers: forwardRequestHeaders(request.headers),
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Payment relay refused a redirect");
      }
      return {
        ok: true,
        status: response.status,
        headers: providerResponseHeaders(response.headers),
        body: await response.text(),
      };
    },
  };
}
