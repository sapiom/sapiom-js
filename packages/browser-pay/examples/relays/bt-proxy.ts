import type { HeldPlaceholder, PaymentRelay } from "../../src/index.js";
import {
  forwardRequestHeaders,
  providerResponseHeaders,
  replacePlaceholderCard,
} from "./replace-card.js";

/**
 * Demo stand-in for W3 B6. Not part of the published SDK.
 * Sends the paused Shopify card-session request through Basis Theory's
 * ephemeral proxy. The placeholder number, expiry, and CVC are replaced with
 * token expressions; Basis Theory inserts the vaulted card. Reads
 * BT_PRIVATE_KEY and BT_TOKEN_ID from the environment when constructed from
 * `btProxyRelayFromEnv`. Never logs the key, the token id, or a card value.
 */
export function btProxyRelay(options: {
  placeholder: HeldPlaceholder;
  apiKey: string;
  tokenId: string;
  /** Defaults to `https://api.basistheory.com`, or `BT_API_BASE` when omitted. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): PaymentRelay {
  if (!/^[A-Za-z0-9._:-]+$/.test(options.tokenId)) {
    throw new Error("BT token id is not a usable token id");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (
    options.baseUrl ??
    process.env.BT_API_BASE ??
    "https://api.basistheory.com"
  ).replace(/\/$/, "");
  const expression = (path: string) =>
    `{{ token: ${options.tokenId} | json: '$.data.${path}' }}`;
  return {
    async relay(request) {
      const body = replacePlaceholderCard(
        request.body,
        options.placeholder.number,
        {
          number: expression("number"),
          expMonth: expression("expiration_month"),
          expYear: expression("expiration_year"),
          cvc: expression("cvc"),
        },
      );
      const response = await fetchImpl(`${base}/proxy`, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...forwardRequestHeaders(request.headers),
          "BT-API-KEY": options.apiKey,
          "BT-PROXY-URL": request.url,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Payment relay refused a redirect");
      }
      const destination = Number(
        response.headers.get("bt-proxy-destination-status"),
      );
      const hasDestination =
        Number.isInteger(destination) &&
        destination >= 100 &&
        destination <= 599;
      if (
        !hasDestination &&
        (response.status < 200 || response.status >= 300)
      ) {
        throw new Error(`Payment relay failed (HTTP ${response.status})`);
      }
      return {
        ok: true,
        status: hasDestination ? destination : response.status,
        headers: providerResponseHeaders(response.headers),
        body: await response.text(),
      };
    },
  };
}

export function btProxyRelayFromEnv(
  placeholder: HeldPlaceholder,
): PaymentRelay {
  const apiKey = process.env.BT_PRIVATE_KEY;
  const tokenId = process.env.BT_TOKEN_ID;
  if (!apiKey || !tokenId) {
    throw new Error("BT_PRIVATE_KEY and BT_TOKEN_ID are required for RELAY=bt");
  }
  return btProxyRelay({ placeholder, apiKey, tokenId });
}
