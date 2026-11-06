import type { CdpConnection, CdpEvent } from "./cdp";
import {
  createStripePaymentElementVerification,
  StripePaymentElementVerification,
} from "./index";
import { VerificationSession, type VerificationState } from "./verification";

const merchantOrigin = "https://shop.example";
const intentId = "pi_demo";
const confirmUrl = `https://api.stripe.com/v1/payment_intents/${intentId}/confirm`;
const creq = (change = {}) =>
  Buffer.from(
    JSON.stringify({
      acsTransID: "11111111-1111-4111-8111-111111111111",
      threeDSServerTransID: "22222222-2222-4222-8222-222222222222",
      messageType: "CReq",
      messageVersion: "2.2.0",
      challengeWindowSize: "05",
      ...change,
    }),
  ).toString("base64url");
const initial = (): VerificationState => ({
  id: "verification",
  version: 1,
  status: "preparing",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  merchantOrigin,
  total: { amount: "11.00", currency: "USD" },
  challengeCaptured: false,
  launchClaimed: false,
  checkRequested: false,
  continuationClaimed: false,
});
const paymentIntent = (change = {}) => ({
  id: intentId,
  object: "payment_intent",
  payment_method: "pm_demo",
  amount: 1100,
  currency: "usd",
  status: "requires_action",
  next_action: {
    type: "use_stripe_sdk",
    use_stripe_sdk: {
      type: "stripe_3ds2_fingerprint",
      three_d_secure_2_source: "src_demo",
    },
  },
  ...change,
});
const confirm = (change = {}) => ({
  url: confirmUrl,
  method: "POST",
  body: "payment_method=pm_demo",
  sessionId: "browser",
  frameId: "element",
  networkId: "confirm",
  ...change,
});
const challenge = (change = {}) => ({
  url: "https://bank.example/challenge?reference=exact",
  method: "POST",
  body: "creq=" + creq(),
  sessionId: "browser",
  frameId: "acs",
  ...change,
});

function fixture(relayBody = '{"id":"pm_demo"}') {
  const state = initial();
  const listeners = new Set<(event: CdpEvent) => void>();
  let responseBody = "";
  let checkoutUrl = merchantOrigin + "/checkout";
  const send = jest.fn(
    async (
      method: string,
      _params: Record<string, unknown> = {},
      _sessionId?: string,
    ): Promise<unknown> => {
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: "checkout", url: checkoutUrl },
            childFrames: [
              {
                frame: {
                  id: "element",
                  url: "https://js.stripe.com/v3/element",
                },
              },
              {
                frame: {
                  id: "auth",
                  url: "https://hooks.stripe.com/3d_secure_2/hosted",
                },
                childFrames: [{ frame: { id: "acs", url: "about:blank" } }],
              },
            ],
          },
        };
      if (method === "Network.getResponseBody")
        return { body: responseBody, base64Encoded: false };
      return {};
    },
  );
  const onEvent = (listener: (event: CdpEvent) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const connection = { send, onEvent } as unknown as CdpConnection;
  const adapter = createStripePaymentElementVerification(
    connection,
    () => state,
  );
  adapter.relayed({ body: relayBody }, "browser", { frameId: "element" });
  const emit = (
    method: string,
    params: Record<string, unknown>,
    sessionId = "browser",
  ) => {
    for (const listener of listeners) listener({ method, params, sessionId });
  };
  const respond = async (
    payload: unknown,
    requestId = "confirm",
    url = confirmUrl,
    sessionId = "browser",
  ) => {
    responseBody = JSON.stringify(payload);
    emit(
      "Network.responseReceived",
      {
        requestId,
        response: { url, mimeType: "application/json", status: 200 },
      },
      sessionId,
    );
    emit(
      "Network.loadingFinished",
      { requestId, encodedDataLength: responseBody.length },
      sessionId,
    );
    await adapter.reconcile(state);
  };
  const start = async () => {
    expect(await adapter.inspect(confirm())).toBe("continue");
    await respond(paymentIntent());
  };
  return {
    adapter,
    state,
    send,
    connection,
    emit,
    respond,
    start,
    listeners,
    navigate: (url: string) => {
      checkoutUrl = url;
    },
  };
}

describe("Stripe Payment Element verification on the existing browser", () => {
  afterEach(() => jest.useRealTimers());

  it("exports the adapter factory and captures only the original supported bank POST", async () => {
    const f = fixture();
    expect(f.adapter).toBeInstanceOf(StripePaymentElementVerification);
    await f.start();
    const request = challenge();
    expect(await f.adapter.inspect(request)).toEqual({
      capture: { url: request.url, body: request.body },
    });
    expect(await f.adapter.reconcile(f.state)).toBeNull();
    expect(
      f.send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn"),
    ).toBe(false);
  });

  it.each([
    "",
    "not json",
    "{}",
    '{"id":42}',
    '{"id":""}',
    JSON.stringify({ id: "x".repeat(256) }),
  ])(
    "leaves Confirm native without a usable relay session: case %#",
    async (body) => {
      const f = fixture(body);
      expect(await f.adapter.inspect(confirm())).toBe("fallback");
      expect(await f.adapter.inspect(challenge())).toBe("fallback");
    },
  );

  it("pins the first relay and rejects another payment method or intent", async () => {
    const f = fixture();
    f.adapter.relayed({ body: '{"id":"pm_other"}' }, "browser", {
      frameId: "element",
    });
    expect(
      await f.adapter.inspect(confirm({ body: "payment_method=pm_other" })),
    ).toBe("fallback");
    await f.start();
    expect(
      await f.adapter.inspect(
        confirm({ url: confirmUrl.replace(intentId, "pi_other") }),
      ),
    ).toBe("block");
  });

  it.each(["challengeCaptured", "launchClaimed"] as const)(
    "fences Confirm and auth after durable %s, including a fresh adapter",
    async (key) => {
      const f = fixture();
      f.state[key] = true;
      expect(await f.adapter.inspect(confirm())).toBe("block");
      expect(await f.adapter.inspect(challenge())).toBe("block");
      expect(
        await f.adapter.inspect({
          ...confirm(),
          url: merchantOrigin + "/checkout/confirm",
        }),
      ).toBe("block");
    },
  );

  it("never replays Confirm and fences a duplicate even before challenge capture", async () => {
    const f = fixture();
    expect(await f.adapter.inspect(confirm())).toBe("continue");
    expect(await f.adapter.inspect(confirm())).toBe("block");
    expect(
      f.send.mock.calls.every(([method]) => method === "Page.getFrameTree"),
    ).toBe(true);
  });

  it("claims only one of two concurrent Confirm requests", async () => {
    const f = fixture();
    expect(
      await Promise.all([
        f.adapter.inspect(confirm()),
        f.adapter.inspect(confirm({ networkId: "second" })),
      ]),
    ).toEqual(["continue", "block"]);
  });

  it("leaves an unobservable Confirm native without a Network request ID", async () => {
    const f = fixture();
    expect(await f.adapter.inspect(confirm({ networkId: undefined }))).toBe(
      "fallback",
    );
  });

  it("allows unrelated merchant traffic, Stripe lookalikes, and unbound retrieves", async () => {
    const f = fixture();
    for (const request of [
      confirm({ url: merchantOrigin + "/checkout/events" }),
      confirm({
        url: confirmUrl.replace(
          "api.stripe.com",
          "api.stripe.com.evil.example",
        ),
      }),
      confirm({
        url: confirmUrl.replace("/confirm", ""),
        method: "GET",
        body: "",
      }),
    ])
      expect(await f.adapter.inspect(request)).toBe("continue");
  });

  it("binds the relay checkout before accepting Confirm or bank traffic", async () => {
    const f = fixture();
    expect(
      await f.adapter.inspect(
        confirm({ frameId: "unrelated", sessionId: "other-tab" }),
      ),
    ).toBe("fallback");
    f.navigate("https://other.example/checkout");
    expect(await f.adapter.inspect(confirm())).toBe("fallback");
    expect(await f.adapter.inspect(challenge())).toBe("fallback");
  });

  it.each([
    ["extra fields", "creq=" + creq() + "&threeDSSessionData=opaque"],
    ["duplicate", "creq=" + creq() + "&creq=" + creq()],
    ["unknown version", "creq=" + creq({ messageVersion: "2.3.0" })],
    ["noncanonical base64", "creq=Zh"],
    ["JSON challenge", JSON.stringify({ creq: creq() })],
  ])(
    "falls back for unsupported %s without claiming completion",
    async (_reason, body) => {
      const f = fixture();
      await f.start();
      expect(await f.adapter.inspect(challenge({ body }))).toBe("fallback");
      expect(await f.adapter.reconcile(f.state)).toBeNull();
    },
  );

  it.each([
    { url: "http://bank.example/challenge" },
    { url: "https://user:pass@bank.example/challenge" },
    { url: "https://bank.example/challenge#fragment" },
    { url: "https://bank.example/challenge\n" },
    { url: "https://bank.example/" + "x".repeat(2048) },
    { body: "creq=" + "x".repeat(8192) },
    { frameId: "unrelated" },
    { frameId: "element" },
  ])("refuses unsupported URL, payload or frame: case %#", async (change) => {
    const f = fixture();
    await f.start();
    expect(await f.adapter.inspect(challenge(change))).toBe("fallback");
  });

  it.each([
    { next_action: null },
    {
      next_action: {
        type: "redirect_to_url",
        redirect_to_url: { url: "https://bank.example" },
      },
    },
    {
      next_action: {
        type: "use_stripe_sdk",
        use_stripe_sdk: { type: "unknown" },
      },
    },
  ])("leaves uncapturable next_action native: case %#", async (change) => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond(paymentIntent(change));
    expect(await f.adapter.inspect(challenge())).toBe("fallback");
    expect(await f.adapter.reconcile(f.state)).toBeNull();
  });

  it.each(["payment_intent_authentication_failure", "authentication_failure"])(
    "reports %s without an ACS modal or another Confirm",
    async (code) => {
      const f = fixture();
      await f.adapter.inspect(confirm());
      await f.respond({
        error: {
          code,
          payment_intent: paymentIntent({
            status: "requires_payment_method",
            next_action: null,
          }),
        },
      });
      expect(await f.adapter.reconcile(f.state)).toEqual({
        outcome: "failed",
        cardSession: "pm_demo",
        amount: "11.00",
        currency: "USD",
      });
      expect(f.send.mock.calls.map(([method]) => method)).not.toContain(
        "Runtime.callFunctionOn",
      );
    },
  );

  it("observes frictionless success only from a correlated succeeded intent", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond(paymentIntent({ status: "succeeded", next_action: null }));
    expect(await f.adapter.reconcile(f.state)).toMatchObject({
      outcome: "confirmed",
      cardSession: "pm_demo",
    });
  });

  it("reports the original Confirm authentication error even when Stripe omits its intent", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond({
      error: { code: "payment_intent_authentication_failure" },
    });
    expect(await f.adapter.reconcile(f.state)).toMatchObject({
      outcome: "failed",
    });
  });

  it("leaves invisible auth native and observes its failure after requires_action", async () => {
    const f = fixture();
    await f.start();
    const url = "https://api.stripe.com/v1/3ds2/authenticate";
    const request = confirm({
      url,
      body: "source=src_demo",
      networkId: "auth",
    });
    expect(await f.adapter.inspect(request)).toBe("continue");
    await f.respond({ error: { code: "authentication_failure" } }, "auth", url);
    expect(await f.adapter.reconcile(f.state)).toMatchObject({
      outcome: "failed",
    });
    expect(await f.adapter.inspect(challenge())).toBe("fallback");
  });

  it("ignores an authentication response for another Stripe source", async () => {
    const f = fixture();
    await f.start();
    const url = "https://api.stripe.com/v1/3ds2/authenticate";
    await f.adapter.inspect(
      confirm({ url, body: "source=src_other", networkId: "auth" }),
    );
    await f.respond({ error: { code: "authentication_failure" } }, "auth", url);
    expect(await f.adapter.reconcile(f.state)).toBeNull();
  });

  it("pins a relayed intent when the card request itself returned one", async () => {
    const f = fixture(JSON.stringify({ payment_intent: paymentIntent() }));
    await f.start();
    await f.adapter.inspect(
      confirm({
        url: confirmUrl.replace("/confirm", ""),
        method: "GET",
        body: "",
        networkId: "retrieve",
      }),
    );
    await f.respond(
      paymentIntent({ status: "succeeded" }),
      "retrieve",
      confirmUrl.replace("/confirm", ""),
    );
    expect(await f.adapter.reconcile(f.state)).toMatchObject({
      outcome: "confirmed",
      cardSession: intentId,
    });
  });

  it("never treats an order number or generic merchant success text as completion", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond({ order_number: "123456", message: "Payment succeeded" });
    expect(await f.adapter.reconcile(f.state)).toBeNull();
  });

  it("does not read oversized network responses", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    f.emit("Network.responseReceived", {
      requestId: "confirm",
      response: { url: confirmUrl, mimeType: "application/json" },
    });
    f.emit("Network.loadingFinished", {
      requestId: "confirm",
      encodedDataLength: 262145,
    });
    expect(await f.adapter.reconcile(f.state)).toBeNull();
    expect(f.send.mock.calls.map(([method]) => method)).not.toContain(
      "Network.getResponseBody",
    );
  });

  it.each([
    { id: "pi_other" },
    { payment_method: "pm_other" },
    { amount: 1200 },
    { currency: "eur" },
    { status: "processing" },
    { status: "requires_capture" },
    { status: "requires_confirmation" },
  ])(
    "does not invent completion for mismatched or pending intents: case %#",
    async (change) => {
      const f = fixture();
      await f.adapter.inspect(confirm());
      await f.respond(
        paymentIntent({ status: "succeeded", next_action: null, ...change }),
      );
      expect(await f.adapter.reconcile(f.state)).toBeNull();
    },
  );

  it("reads the bound retrieve response passively", async () => {
    const f = fixture();
    await f.start();
    const url = `https://api.stripe.com/v1/payment_intents/${intentId}`;
    expect(
      await f.adapter.inspect(
        confirm({ url, method: "GET", body: "", networkId: "retrieve" }),
      ),
    ).toBe("continue");
    await f.respond(
      paymentIntent({ status: "succeeded", next_action: null }),
      "retrieve",
      url,
    );
    expect(await f.adapter.reconcile(f.state)).toMatchObject({
      outcome: "confirmed",
    });
  });

  it("observes a merchant Confirm returning a nested payment_intent", async () => {
    const f = fixture();
    const url = merchantOrigin + "/checkout/confirm";
    expect(
      await f.adapter.inspect(
        confirm({
          url,
          frameId: "checkout",
          body: JSON.stringify({
            payment_intent: intentId,
            payment_method: "pm_demo",
          }),
        }),
      ),
    ).toBe("continue");
    await f.respond({ payment_intent: paymentIntent() }, "confirm", url);
    expect(await f.adapter.inspect(challenge())).toEqual({
      capture: {
        url: challenge().url,
        body: challenge().body,
      },
    });
  });

  it("ignores responses from another session or a redirected endpoint", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond(
      paymentIntent({ status: "succeeded" }),
      "confirm",
      confirmUrl,
      "other-tab",
    );
    expect(await f.adapter.reconcile(f.state)).toBeNull();
    await f.respond(
      paymentIntent({ status: "succeeded" }),
      "confirm",
      "https://other.example/confirm",
    );
    expect(await f.adapter.reconcile(f.state)).toBeNull();
  });

  it("withdraws capture when CDP cannot verify frame ancestry", async () => {
    const f = fixture();
    await f.start();
    f.send.mockRejectedValue(new Error("CDP unavailable"));
    expect(await f.adapter.inspect(challenge())).toBe("fallback");
  });

  it.each(["checkout", "unrelated"])(
    "verifies Stripe OOP iframe ancestry through the factory (parent=%s)",
    async (parentId) => {
      const f = fixture("{}");
      const original = f.send.getMockImplementation()!;
      f.send.mockImplementation(async (method, params, sessionId) => {
        if (method === "Page.getFrameTree") {
          if (sessionId === "element-session")
            return {
              frameTree: {
                frame: {
                  id: "element",
                  parentId: "checkout",
                  url: "https://js.stripe.com/v3/element",
                },
              },
            };
          if (sessionId === "auth-session")
            return {
              frameTree: {
                frame: {
                  id: "auth",
                  parentId,
                  url: "https://hooks.stripe.com/3d_secure_2/hosted",
                },
              },
            };
          if (sessionId === "acs-session")
            return {
              frameTree: {
                frame: {
                  id: "acs",
                  parentId: "auth",
                  url: "about:blank",
                },
              },
            };
          return {
            frameTree: {
              frame: { id: "checkout", url: merchantOrigin + "/checkout" },
            },
          };
        }
        return original(method, params, sessionId);
      });
      for (const [sessionId, targetId, parentSession] of [
        ["browser", "checkout", "root"],
        ["element-session", "element", "browser"],
        ["auth-session", "auth", "browser"],
        ["acs-session", "acs", "auth-session"],
      ])
        f.emit(
          "Target.attachedToTarget",
          { sessionId, targetInfo: { targetId } },
          parentSession,
        );
      f.adapter.relayed({ body: '{"id":"pm_demo"}' }, "element-session", {
        frameId: "element",
      });
      expect(
        await f.adapter.inspect(confirm({ sessionId: "element-session" })),
      ).toBe("continue");
      await f.respond(
        paymentIntent(),
        "confirm",
        confirmUrl,
        "element-session",
      );
      const request = challenge({ sessionId: "acs-session" });
      expect(await f.adapter.inspect(request)).toEqual(
        parentId === "checkout"
          ? { capture: { url: request.url, body: request.body } }
          : "fallback",
      );
    },
  );

  it("removes its listener and retained protocol material on dispose", async () => {
    const f = fixture();
    await f.start();
    f.adapter.dispose?.();
    expect(f.listeners.size).toBe(0);
    expect(await f.adapter.reconcile(f.state)).toBeNull();
    expect(await f.adapter.inspect(challenge())).toBe("continue");
  });

  it("publishes invisible-auth failure through VerificationSession.wait", async () => {
    jest.useFakeTimers();
    const f = fixture();
    let state = f.state;
    const report = jest.fn(async (_id, input) => {
      state = {
        ...state,
        version: state.version + 1,
        status: "ended",
        observation: {
          outcome: input.observation.outcome,
          source: "runner",
        },
      };
      return state;
    });
    const session = await VerificationSession.attach(
      {
        register: async () => state,
        sync: async () => state,
        report,
      },
      f.adapter,
      "injection",
    );
    expect(await session!.inspect(confirm())).toBe("continue");
    const finished = session!.wait();
    await f.respond({
      error: {
        code: "payment_intent_authentication_failure",
        payment_intent: paymentIntent({
          status: "requires_payment_method",
          next_action: null,
        }),
      },
    });
    await jest.advanceTimersByTimeAsync(2000);
    expect((await finished).observation).toEqual({
      outcome: "failed",
      source: "runner",
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
    await session!.close();
  });
});
