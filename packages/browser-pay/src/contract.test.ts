import { parseRelayResponse } from "./contract";

describe("parseRelayResponse", () => {
  it("rejects a payload that is not a success or a known refusal", () => {
    expect(() => parseRelayResponse(null)).toThrow(
      "Payment relay returned an unreadable response",
    );
    expect(() =>
      parseRelayResponse({
        ok: false,
        reason: "made_up",
        body: "4242424242424242",
      }),
    ).toThrow("Payment relay returned an unreadable response");
    expect(() =>
      parseRelayResponse({ ok: true, status: 200, body: 1, headers: {} }),
    ).toThrow("Payment relay returned an unreadable response");
  });
});
