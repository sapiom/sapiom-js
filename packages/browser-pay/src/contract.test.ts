import { parseRelayResponse, relayHeadersFromRecord } from "./contract";

describe("parseRelayResponse", () => {
  it("rejects a payload that is not a success or a refusal", () => {
    expect(() => parseRelayResponse(null)).toThrow(
      "Payment relay returned an unreadable response",
    );
    expect(() => parseRelayResponse({ ok: false })).toThrow(
      "Payment relay returned an unreadable response",
    );
    expect(() =>
      parseRelayResponse({ ok: true, status: 200, body: 1, headers: {} }),
    ).toThrow("Payment relay returned an unreadable response");
  });

  it("maps an unknown refusal reason and keeps a known one", () => {
    expect(
      parseRelayResponse({
        ok: false,
        reason: "made_up",
        body: "4242424242424242",
      }),
    ).toEqual({ ok: false, reason: "unknown" });
    expect(parseRelayResponse({ ok: false, reason: "replay" })).toEqual({
      ok: false,
      reason: "replay",
    });
  });

  it("accepts header tuples, repeated Set-Cookie, and a base64 body", () => {
    expect(
      parseRelayResponse({
        ok: true,
        status: 200,
        headers: [
          ["content-type", "application/json"],
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
        body: Buffer.from('{"id":"s"}', "utf8").toString("base64"),
        bodyEncoding: "base64",
      }),
    ).toEqual({
      ok: true,
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      body: Buffer.from('{"id":"s"}', "utf8").toString("base64"),
      bodyEncoding: "base64",
    });
  });

  it("accepts a legacy header map and defaults body encoding to utf8", () => {
    expect(
      parseRelayResponse({
        ok: true,
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "a=1\nb=2",
        },
        body: "{}",
      }),
    ).toEqual({
      ok: true,
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
