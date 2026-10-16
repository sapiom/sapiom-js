import shopifyCardSessionJson from "./fixtures/shopify-card-session.json";
import refusalJson from "./fixtures/refusals.json";
import type {
  RelayRefusal,
  RelayRefusalReason,
  RelayRequest,
  RelaySuccess,
} from "./contract.js";

/**
 * One Shopify card-session round trip. The number in the request body is a
 * placeholder stand-in (a published test PAN), not a credential. The response
 * is only the provider session id.
 */
export const shopifyCardSessionRoundTrip = shopifyCardSessionJson as {
  request: RelayRequest;
  response: RelaySuccess;
};

/** One refusal per reason W3's relay can return. None of them echo the request. */
export const relayRefusalFixtures = refusalJson as Record<
  RelayRefusalReason,
  RelayRefusal
>;
