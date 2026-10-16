import {
  paymentIdempotencyKey,
  parseRelayResponse,
  relayHeadersFromRecord,
} from "./contract";

describe("paymentIdempotencyKey", () => {
  it("is sha256 of method, url, and body, stable for the same triple", () => {
    const key = paymentIdempotencyKey("POST", "https://pay.example/s", "{}");
    expect(key).toBe(
      paymentIdempotencyKey("POST", "https://pay.example/s", "{}"),
    );
    expect(key).not.toBe(
      paymentIdempotencyKey("POST", "https://pay.example/s", "{ }"),
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseRelayResponse", () => {
  it("rejects a payload that is not relayed or refused", () => {
    expect(() => parseRelayResponse(null)).toThrow(
      "Payment relay returned an unreadable response",
    );
    expect(() => parseRelayResponse({ kind: "refused" })).toThrow(
      "Payment relay returned an unreadable response",
    );
    expect(() =>
      parseRelayResponse({
        kind: "relayed",
        status: 200,
        body: 1,
        headers: {},
      }),
    ).toThrow("Payment relay returned an unreadable response");
  });

  it("maps an unknown refusal reason and keeps a known one", () => {
    expect(
      parseRelayResponse({
        kind: "refused",
        reason: "made_up",
        body: "4242424242424242",
      }),
    ).toEqual({ kind: "refused", reason: "unknown" });
    expect(
      parseRelayResponse({ kind: "refused", reason: "already_relayed" }),
    ).toEqual({ kind: "refused", reason: "already_relayed" });
    expect(
      parseRelayResponse({ kind: "refused", reason: "total_changed" }),
    ).toEqual({ kind: "refused", reason: "total_changed" });
  });

  it("accepts header tuples, repeated Set-Cookie, and a base64 body", () => {
    const body = Buffer.from('{"id":"s"}', "utf8").toString("base64");
    expect(
      parseRelayResponse({
        kind: "relayed",
        status: 200,
        headers: [
          ["content-type", "application/json"],
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
        body,
        bodyEncoding: "base64",
      }),
    ).toEqual({
      kind: "relayed",
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      body,
      bodyEncoding: "base64",
    });
  });

  it("accepts a header map and defaults body encoding to utf8", () => {
    expect(
      parseRelayResponse({
        kind: "relayed",
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "a=1\nb=2",
        },
        body: "{}",
      }),
    ).toEqual({
      kind: "relayed",
      status: 201,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      body: "{}",
      bodyEncoding: "utf8",
    });
    expect(relayHeadersFromRecord({ accept: "application/json" })).toEqual([
      ["accept", "application/json"],
    ]);
  });
});
