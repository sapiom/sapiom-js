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
function fixture(
  shopifyResponse?: string,
  parentSession: (sessionId: string) => string | undefined = () => undefined,
) {
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
  const send = jest.fn(
    async (
      _method?: string,
      _params?: Record<string, unknown>,
      _sessionId?: string,
    ) => ({
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
    }),
  );
  const adapter = new MerchantVerification(
    { send, onEvent: () => () => {} } as never,
    () => state,
    parentSession,
  );
  if (shopifyResponse)
    adapter.relayed({ body: shopifyResponse }, "session", {
      frameId: "card",
      url: "https://checkout.pci.shopifyinc.com/sessions",
    });
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
  jest.spyOn(NativeCardinal.prototype, "lookupChallenge").mockResolvedValue({
    nonce: "upgraded",
    acsUrl: challenge.url,
    acsTransactionId: "11111111-1111-4111-8111-111111111111",
    threeDSecureServerTransactionId: "22222222-2222-4222-8222-222222222222",
  });
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
it("continues a bank challenge proven to belong to another page after capture", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  await f.adapter.inspect(challenge);
  f.state.challengeCaptured = true;
  f.send.mockResolvedValue({
    frameTree: {
      frame: { id: "other-page", url: "https://other.example/checkout" },
      childFrames: [],
    },
  });
  expect(
    await f.adapter.inspect({
      ...challenge,
      sessionId: "other-page-session",
      frameId: "other-bank",
    }),
  ).toBe("continue");
  await f.adapter.dispose();
});
it.each([true, false])(
  "keeps an owned or uncertain out-of-process frame blocked (parent known=%s)",
  async (known) => {
    const f = fixture(undefined, (session) =>
      known && session === "bank-oop" ? "session" : undefined,
    );
    await f.adapter.inspect(lookup);
    await f.adapter.inspect(challenge);
    const tree = {
      frameTree: {
        frame: {
          id: "bank",
          parentId: "checkout",
          url: "https://bank.example",
        },
        childFrames: [],
      },
    };
    f.send.mockResolvedValue(tree);
    expect(
      await f.adapter.inspect({ ...challenge, sessionId: "bank-oop" }),
    ).toBe("block");
    await f.adapter.dispose();
  },
);
it("continues a bank challenge in an out-of-process frame proven to belong to another page", async () => {
  const f = fixture(undefined, (session) =>
    session === "other-bank-oop" ? "other-page-session" : undefined,
  );
  await f.adapter.inspect(lookup);
  await f.adapter.inspect(challenge);
  f.send.mockImplementation(async (_method, _params, session) =>
    session === "other-bank-oop"
      ? {
          frameTree: {
            frame: {
              id: "other-bank",
              parentId: "other-page",
              url: "https://bank.example",
            },
            childFrames: [],
          },
        }
      : {
          frameTree: {
            frame: { id: "other-page", url: "https://other.example" },
            childFrames: [],
          },
        },
  );
  expect(
    await f.adapter.inspect({
      ...challenge,
      sessionId: "other-bank-oop",
      frameId: "other-bank",
    }),
  ).toBe("continue");
  await f.adapter.dispose();
});
it.each(["proposed", "captured", "launched"])(
  "blocks another bound lookup after capture is %s",
  async (stage) => {
    const f = fixture();
    await f.adapter.inspect(lookup);
    if (stage === "proposed") await f.adapter.inspect(challenge);
    else if (stage === "captured") f.state.challengeCaptured = true;
    else f.state.launchClaimed = true;
    expect(
      await f.adapter.inspect({ ...lookup, networkId: "another-lookup" }),
    ).toBe("block");
    await f.adapter.dispose();
  },
);
it.each(["{}", '{"id":""}', '{"id":123}'])(
  "does not select Shopify from an unusable session response %s",
  async (body) => {
    const f = fixture(body);
    await f.adapter.inspect(lookup);
    expect(await f.adapter.inspect(challenge)).toEqual({
      capture: expect.anything(),
    });
    await f.adapter.dispose();
  },
);
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

it("rechecks takeover after lookup ancestry inspection waits", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  const tree = await f.send();
  let release!: (value: typeof tree) => void;
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const later = f.adapter.inspect({ ...lookup, networkId: "later-lookup" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(await f.adapter.inspect(challenge)).toEqual({
    capture: expect.anything(),
  });
  release(tree);
  expect(await later).toBe("block");
  await f.adapter.dispose();
});
it.each([' {"messageType":"CReq"}', '\t\n\r{"creq":"unsupported"}'])(
  "fences whitespace-prefixed JSON challenge markers after capture: %j",
  async (body) => {
    const f = fixture();
    await f.adapter.inspect(lookup);
    await f.adapter.inspect(challenge);
    expect(await f.adapter.inspect({ ...challenge, body })).toBe("block");
    await f.adapter.dispose();
  },
);
it.each(["url", "acsTransID", "threeDSServerTransID"])(
  "preserves the capture slot for the tracked lookup when another challenge differs in %s",
  async (field) => {
    const f = fixture();
    await f.adapter.inspect(lookup);
    const form = new URLSearchParams(challenge.body);
    const creq = JSON.parse(
      Buffer.from(form.get("creq")!, "base64url").toString("utf8"),
    );
    if (field !== "url") {
      creq[field] = "33333333-3333-4333-8333-333333333333";
      form.set("creq", Buffer.from(JSON.stringify(creq)).toString("base64url"));
    }
    expect(
      await f.adapter.inspect({
        ...challenge,
        url:
          field === "url"
            ? "https://bank.example/other-challenge"
            : challenge.url,
        body: form.toString(),
      }),
    ).toBe("continue");
    expect(NativeCardinal.prototype.bind).not.toHaveBeenCalled();
    expect(await f.adapter.inspect(challenge)).toEqual({
      capture: expect.anything(),
    });
    await f.adapter.dispose();
  },
);

it.each(["ancestry", "lookup", "binding"])(
  "admits only one capture while a competing challenge waits for %s",
  async (stage) => {
    const f = fixture();
    await f.adapter.inspect(lookup);
    const tree = await f.send();
    const lookupResult = await NativeCardinal.prototype.lookupChallenge();
    const target = await NativeCardinal.prototype.bind(
      { sessionId: "session", frameId: "checkout", url: origin + "/checkout" },
      "upgraded",
    );
    jest.mocked(NativeCardinal.prototype.bind).mockClear();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = async () => {
      started();
      await gate;
    };
    if (stage === "ancestry")
      f.send.mockImplementationOnce(async () => {
        await pause();
        return tree;
      });
    else if (stage === "lookup")
      jest
        .mocked(NativeCardinal.prototype.lookupChallenge)
        .mockImplementationOnce(async () => {
          await pause();
          return lookupResult;
        });
    else
      jest
        .mocked(NativeCardinal.prototype.bind)
        .mockImplementationOnce(async () => {
          await pause();
          return target;
        });
    const waiting = f.adapter.inspect(challenge);
    await entered;
    expect(await f.adapter.inspect(challenge)).toEqual({
      capture: expect.anything(),
    });
    release();
    expect(await waiting).toBe("block");
    await f.adapter.dispose();
  },
);
it("keeps the original checkout native when lookup challenge identities are unavailable", async () => {
  const f = fixture();
  await f.adapter.inspect(lookup);
  jest
    .mocked(NativeCardinal.prototype.lookupChallenge)
    .mockResolvedValue(undefined);
  expect(await f.adapter.inspect(challenge)).toBe("fallback");
  expect(NativeCardinal.prototype.bind).not.toHaveBeenCalled();
  await f.adapter.dispose();
});
