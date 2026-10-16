import shopifyCardSessionJson from "./fixtures/shopify-card-session.json";
import refusalJson from "./fixtures/refusals.json";
import {
  isRelayRequest,
  parseRelayResponse,
  RELAY_REFUSAL_REASONS,
  type RelayRefusal,
  type RelayRefusalReason,
  type RelayRequest,
  type RelaySuccess,
} from "./contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadRoundTrip(value: unknown): {
  request: RelayRequest;
  response: RelaySuccess;
} {
  if (!isRecord(value) || !isRelayRequest(value.request)) {
    throw new Error("Shopify card-session fixture request is not a T7 body");
  }
  const response = parseRelayResponse(value.response);
  if (response.kind !== "relayed") {
    throw new Error("Shopify card-session fixture response is not relayed");
  }
  return { request: value.request, response };
}

function loadRefusals(
  value: unknown,
): Record<RelayRefusalReason, RelayRefusal> {
  if (!isRecord(value)) {
    throw new Error("Refusal fixtures are unreadable");
  }
  const out: Partial<Record<RelayRefusalReason, RelayRefusal>> = {};
  for (const reason of RELAY_REFUSAL_REASONS) {
    const parsed = parseRelayResponse(value[reason]);
    if (parsed.kind !== "refused" || parsed.reason !== reason) {
      throw new Error("Refusal fixture does not match its reason");
    }
    out[reason] = parsed;
  }
  if (!refusalsComplete(out)) {
    throw new Error("Refusal fixtures are missing a reason");
  }
  return out;
}

function refusalsComplete(
  value: Partial<Record<RelayRefusalReason, RelayRefusal>>,
): value is Record<RelayRefusalReason, RelayRefusal> {
  return RELAY_REFUSAL_REASONS.every((reason) => value[reason] !== undefined);
}

/**
 * One Shopify card-session round trip. The number in the request body is a
 * placeholder stand-in (a published test PAN), not a credential. The response
 * is only the provider session id.
 */
export const shopifyCardSessionRoundTrip = loadRoundTrip(
  shopifyCardSessionJson,
);

/** One refusal per reason the relay can return. None of them echo the request. */
export const relayRefusalFixtures = loadRefusals(refusalJson);
