import { MerchantVerification } from "./merchant-verification";
import { NativeCardinal, type NativeCardinalTarget } from "./native-cardinal";
import type { VerificationRequest, VerificationState } from "./verification";

const origin = "https://shop.example";
const challenge: VerificationRequest = {
  url: "https://bank.example/challenge",
  method: "POST",
  sessionId: "session",
  frameId: "bank",
  body: new URLSearchParams({
    creq: Buffer.from(
      JSON.stringify({
        acsTransID: "11111111-1111-4111-8111-111111111111",
        threeDSServerTransID: "22222222-2222-4222-8222-222222222222",
        messageType: "CReq",
        messageVersion: "2.2.0",
        challengeWindowSize: "05",
      }),
    ).toString("base64url"),
    threeDSSessionData: "exact+opaque/session",
  }).toString(),
};
const lookup = {
  ...challenge,
  frameId: "checkout",
  networkId: "lookup",
  body: '{"amount":"11.00"}',
  url: "https://api.sandbox.braintreegateway.com/merchants/test/client_api/v1/payment_methods/tokenized/three_d_secure/lookup",
};
function fixture() {
  const state: VerificationState = {
    id: "verification",
    version: 1,
    status: "preparing",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    merchantOrigin: origin,
    total: { amount: "11.00", currency: "USD" },
    challengeCaptured: false,
    launchClaimed: false,
    checkRequested: false,
    continuationClaimed: false,
  };
  const send = jest.fn(async () => ({
    frameTree: {
      frame: { id: "checkout", url: origin + "/checkout" },
      childFrames: [
        {
          frame: {
            id: "card",
            url: "https://assets.braintreegateway.com/fields",
          },
        },
        { frame: { id: "bank", url: "about:blank" } },
      ],
    },
  }));
  const adapter = new MerchantVerification(
    { send, onEvent: () => () => {} } as never,
    () => state,
  );
  adapter.relayed(
    { body: '{"data":{"tokenizeCreditCard":{"token":"tokenized"}}}' },
    "session",
    {
      frameId: "card",
      url: "https://payments.sandbox.braintree-api.com/graphql",
    },
  );
  return { adapter, state, send };
}
beforeEach(() => {
  jest.spyOn(NativeCardinal.prototype, "enableLookup").mockResolvedValue({});
  jest.spyOn(NativeCardinal.prototype, "watchLookup").mockResolvedValue();
  jest
    .spyOn(NativeCardinal.prototype, "lookupNonce")
    .mockResolvedValue("upgraded");
  jest.spyOn(NativeCardinal.prototype, "bind").mockResolvedValue({
    frame: {
      frameId: "checkout",
      sessionId: "session",
      url: origin + "/checkout",
    },
  } as NativeCardinalTarget);
});
afterEach(() => jest.restoreAllMocks());
it("leaves malformed UTF-8 hidden by a duplicate JSON field in native checkout", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  const form = new URLSearchParams(challenge.body);
  const original = Buffer.from(form.get("creq")!, "base64url");
  form.set(
    "creq",
    Buffer.concat([
      Buffer.from('{"messageType":"'),
      Buffer.from([0xff]),
      Buffer.from('",'),
      original.subarray(1),
    ]).toString("base64url"),
  );
  expect(await f.adapter.inspect({ ...challenge, body: form.toString() })).toBe(
    "fallback",
  );
  expect(NativeCardinal.prototype.bind).not.toHaveBeenCalled();
  await f.adapter.dispose();
});
it("captures the complete form only after the relayed token's exact amount-bound lookup and native binding", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  expect(await f.adapter.inspect(challenge)).toEqual({
    capture: {
      url: challenge.url,
      body: challenge.body,
      nativeReturn: "braintree_cardinal",
    },
  });
  expect(NativeCardinal.prototype.bind).toHaveBeenCalledWith(
    expect.objectContaining({ frameId: "checkout" }),
    "upgraded",
  );
  f.state.challengeCaptured = true;
  expect(await f.adapter.inspect(challenge)).toBe("block");
  await f.adapter.dispose();
});
it.each([
  ["the same request", lookup],
  ["a second request", { ...lookup, networkId: "second-lookup" }],
  ["another amount", { ...lookup, body: '{"amount":"12.00"}' }],
])(
  "retains the original amount-bound lookup after %s",
  async (_label, later) => {
    const f = fixture();
    jest
      .mocked(NativeCardinal.prototype.watchLookup)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Native lookup unavailable"));
    await f.adapter.inspect(lookup);
    await f.adapter.inspect(later as VerificationRequest);
    expect(await f.adapter.inspect(challenge)).toEqual({
      capture: expect.anything(),
    });
    expect(NativeCardinal.prototype.watchLookup).toHaveBeenCalledTimes(1);
    expect(NativeCardinal.prototype.bind).toHaveBeenCalledWith(
      expect.anything(),
      "upgraded",
    );
    await f.adapter.dispose();
  },
);
it.each(["proposed", "captured", "launched"])(
  "blocks an uncertain bank frame once the challenge is %s",
  async (stage) => {
    const f = fixture();
    await f.adapter.inspect(lookup);
    if (stage === "proposed") {
      expect(await f.adapter.inspect(challenge)).toEqual({
        capture: expect.anything(),
      });
    } else {
      f.state.challengeCaptured = stage === "captured";
      f.state.launchClaimed = stage === "launched";
    }
    f.send.mockResolvedValue({
      frameTree: {
        frame: { id: "other", url: origin + "/checkout" },
        childFrames: [],
      },
    });
    expect(await f.adapter.inspect(challenge)).toBe("block");
    expect(
      await f.adapter.inspect({
        ...challenge,
        url: origin + "/status",
        body: "{}",
      }),
    ).toBe("continue");
    await f.adapter.dispose();
  },
);
it("blocks the captured bank request when reading its frame tree fails", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  expect(await f.adapter.inspect(challenge)).toEqual({
    capture: expect.anything(),
  });
  f.state.challengeCaptured = true;
  f.send.mockRejectedValue(new Error("frame tree unavailable"));
  expect(await f.adapter.inspect(challenge)).toBe("block");
  await f.adapter.dispose();
});
it.each([
  { ...lookup, body: '{"amount":"12.00"}' },
  { ...lookup, url: lookup.url.replace("tokenized/", "another/") },
  { ...lookup, frameId: "another-tab" },
])("leaves an unbound challenge native: %j", async (request) => {
  const f = fixture();
  await f.adapter.inspect(request);
  expect(await f.adapter.inspect(challenge)).toBe("fallback");
  expect(NativeCardinal.prototype.bind).not.toHaveBeenCalled();
  await f.adapter.dispose();
});
it("leaves an unknown native implementation native and ignores unrelated frame traffic", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  jest
    .mocked(NativeCardinal.prototype.bind)
    .mockRejectedValue(new Error("unsupported"));
  expect(
    await f.adapter.inspect({ ...challenge, frameId: "another-tab" }),
  ).toBe("continue");
  expect(await f.adapter.inspect(challenge)).toBe("fallback");
  await f.adapter.dispose();
});
it("requires a protected result and returns only the genuine native acknowledgment", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  await f.adapter.inspect(challenge);
  f.state.nativeReturnAvailable = true;
  f.state.launchClaimed = true;
  const deliver = jest
    .spyOn(NativeCardinal.prototype, "deliver")
    .mockResolvedValue();
  const continuation = await f.adapter.continuation();
  await expect(continuation!()).rejects.toThrow("unavailable");
  const result = {
    protocol: "braintree_cardinal" as const,
    jwt: "header.payload.signature",
  };
  await expect(continuation!(result)).resolves.toEqual({
    interactionReturned: true,
  });
  expect(deliver).toHaveBeenCalledWith(
    expect.anything(),
    result,
    f.state.expiresAt,
  );
  await f.adapter.dispose();
});
it.each(["%0A", "%00", "%FF", "%E2%82%AC"])(
  "keeps non-reproducible session data %s native before capture",
  async (value) => {
    const f = fixture();
    await f.adapter.inspect(lookup);
    const body = new URLSearchParams(challenge.body);
    body.delete("threeDSSessionData");
    expect(
      await f.adapter.inspect({
        ...challenge,
        body: body.toString() + "&threeDSSessionData=" + value,
      }),
    ).toBe("fallback");
    expect(NativeCardinal.prototype.bind).not.toHaveBeenCalled();
    await f.adapter.dispose();
  },
);
