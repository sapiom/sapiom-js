import type { HeldPlaceholder, PaymentRelay } from "../../src/index.js";
import {
  forwardRequestHeaders,
  providerResponseHeaders,
  replacePlaceholderCard,
} from "./replace-card.js";

/**
 * Demo relay for the Shopify Bogus Gateway. Not part of the published SDK.
 * Substitutes the gateway's success test card and forwards the paused request.
 * Test data only: number "1", expiry 12/2030, cvc 111.
 */
export const BOGUS_CARD = {
  number: "1",
  expMonth: 12,
  expYear: 2030,
  cvc: "111",
} as const;

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
