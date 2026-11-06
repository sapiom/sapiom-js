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

const cres = (change = {}) =>
  Buffer.from(
    JSON.stringify({
      acsTransID: "11111111-1111-4111-8111-111111111111",
      threeDSServerTransID: "22222222-2222-4222-8222-222222222222",
      messageType: "CRes",
      messageVersion: "2.2.0",
      challengeCompletionInd: "Y",
      transStatus: "Y",
      ...change,
    }),
  ).toString("base64url");

function fixture(relayBody = '{"id":"pm_demo"}') {
  const state = initial();
  const listeners = new Set<(event: CdpEvent) => void>();
  let responseBody = "";
  let checkoutUrl = merchantOrigin + "/checkout";
  let authUrl = "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html";
  const postMessage = jest.fn();
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
                  url: authUrl,
                },
                childFrames: [{ frame: { id: "acs", url: "about:blank" } }],
              },
            ],
          },
        };
      if (method === "Network.getResponseBody")
        return { body: responseBody, base64Encoded: false };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 12 };
      if (method === "Runtime.callFunctionOn") {
        const fn = new Function(
          "window",
          "location",
          `return (${_params.functionDeclaration});`,
        )({ postMessage }, { href: authUrl, origin: new URL(authUrl).origin });
        const args = _params.arguments as { value: unknown }[];
        return {
          result: { value: await fn(...args.map(({ value }) => value)) },
        };
      }
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
    postMessage,
    navigateAuth: (url: string) => {
      authUrl = url;
    },
    navigate: (url: string) => {
      checkoutUrl = url;
    },
  };
}

describe("Stripe Payment Element verification on the existing browser", () => {
  afterEach(() => jest.useRealTimers());

  it("returns real ACS completion to Stripe.js only after the durable continuation claim", async () => {
    const f = fixture();
    await f.start();
    await f.adapter.inspect(challenge());
    expect(await f.adapter.continuation?.()).toBeNull();
    Object.assign(f.state, {
      challengeCaptured: true,
      launchClaimed: true,
      nativeReturnAvailable: true,
      nativeReturnProtocol: "stripe_3ds2",
    });
    const resume = await f.adapter.continuation?.();
    expect(resume).toEqual(expect.any(Function));
    await expect(resume!()).rejects.toThrow();
    f.state.continuationClaimed = true;
    await resume!({ protocol: "stripe_3ds2", cres: cres() });
    expect(f.postMessage).toHaveBeenCalledWith(
      {
        type: "3ds2-trampoline",
        data: Buffer.from(cres(), "base64url").toString("base64"),
      },
      "https://js.stripe.com",
    );
    const invocation = f.send.mock.calls.find(
      ([method]) => method === "Runtime.callFunctionOn",
    )!;
    expect(invocation[1]).toMatchObject({
      executionContextId: 12,
      arguments: [
        { value: "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html" },
        { value: Buffer.from(cres(), "base64url").toString("base64") },
      ],
    });
    expect(await f.adapter.reconcile(f.state)).toBeNull();
    await expect(
      resume!({ protocol: "stripe_3ds2", cres: cres() }),
    ).rejects.toThrow();
    expect(await f.adapter.inspect(confirm())).toBe("block");
  });

  it.each(["Y", "N"])(
    "lets native challenge_complete settle the original Confirm (CRes=%s)",
    async (transStatus) => {
      const f = fixture();
      await f.start();
      await f.adapter.inspect(challenge());
      Object.assign(f.state, {
        challengeCaptured: true,
        launchClaimed: true,
        nativeReturnAvailable: true,
        nativeReturnProtocol: "stripe_3ds2",
      });
      const url = "https://api.stripe.com/v1/3ds2/challenge_complete";
      const complete = confirm({
        url,
        body: "source=src_demo",
        networkId: "complete",
      });
      expect(await f.adapter.inspect(complete)).toBe("block");
      const resume = await f.adapter.continuation?.();
      expect(resume).toEqual(expect.any(Function));
      f.state.continuationClaimed = true;
      await resume!({ protocol: "stripe_3ds2", cres: cres({ transStatus }) });
      expect(await f.adapter.inspect(complete)).toBe("continue");
      expect(
        await f.adapter.inspect({ ...complete, body: "source=src_other" }),
      ).toBe("block");
      expect(
        await f.adapter.inspect({ ...complete, frameId: "unrelated" }),
      ).toBe("block");
      expect(
        await f.adapter.inspect(
          confirm({ url: url.replace("challenge_complete", "authenticate") }),
        ),
      ).toBe("block");
      await f.respond({ state: "succeeded" }, "complete", url);
      expect(await f.adapter.reconcile(f.state)).toBeNull();
      const retrieve = confirm({
        url: confirmUrl.replace("/confirm", ""),
        method: "GET",
        body: "",
        networkId: "retrieve",
      });
      expect(await f.adapter.inspect(retrieve)).toBe("continue");
      await f.respond(
        paymentIntent({
          status: transStatus === "Y" ? "succeeded" : "requires_payment_method",
          next_action: null,
          ...(transStatus === "N" && {
            last_payment_error: {
              code: "payment_intent_authentication_failure",
            },
          }),
        }),
        "retrieve",
        retrieve.url,
      );
      expect(await f.adapter.reconcile(f.state)).toMatchObject({
        outcome: transStatus === "Y" ? "confirmed" : "failed",
      });
      expect(await f.adapter.inspect(confirm())).toBe("block");
    },
  );

  it.each([
    { acsTransID: "33333333-3333-4333-8333-333333333333" },
    { threeDSServerTransID: "33333333-3333-4333-8333-333333333333" },
    { messageVersion: "2.1.0" },
    { messageType: "CReq" },
    { challengeCompletionInd: "N" },
    { transStatus: "U" },
  ])("rejects mismatched or incomplete ACS return: case %#", async (change) => {
    const f = fixture();
    await f.start();
    await f.adapter.inspect(challenge());
    Object.assign(f.state, {
      challengeCaptured: true,
      launchClaimed: true,
      nativeReturnAvailable: true,
      nativeReturnProtocol: "stripe_3ds2",
    });
    const resume = await f.adapter.continuation?.();
    f.state.continuationClaimed = true;
    await expect(
      resume!({ protocol: "stripe_3ds2", cres: cres(change) }),
    ).rejects.toThrow();
    expect(f.send.mock.calls.map(([method]) => method)).not.toContain(
      "Runtime.callFunctionOn",
    );
    expect(await f.adapter.reconcile(f.state)).toBeNull();
  });

  it.each([
    "no-return",
    "wrong-protocol",
    "fresh-adapter",
    "claimed",
    "expired",
    "navigated",
    "disposed",
  ])("leaves continuation unavailable for %s", async (scenario) => {
    const f = fixture();
    await f.start();
    await f.adapter.inspect(challenge());
    Object.assign(f.state, {
      challengeCaptured: true,
      launchClaimed: true,
      nativeReturnAvailable: true,
      nativeReturnProtocol: "stripe_3ds2",
    });
    if (scenario === "no-return") f.state.nativeReturnAvailable = false;
    if (scenario === "wrong-protocol")
      f.state.nativeReturnProtocol = "braintree_cardinal";
    if (scenario === "claimed") f.state.continuationClaimed = true;
    if (scenario === "expired") f.state.expiresAt = new Date(0).toISOString();
    if (scenario === "navigated") f.navigate("https://other.example/checkout");
    if (scenario === "disposed") f.adapter.dispose?.();
    const adapter =
      scenario === "fresh-adapter"
        ? createStripePaymentElementVerification(f.connection, () => f.state)
        : f.adapter;
    expect(await adapter.continuation?.()).toBeNull();
    if (scenario === "fresh-adapter") adapter.dispose?.();
  });

  it.each([false, true])(
    "never redelivers after an ambiguous or rejected frame delivery (%s)",
    async (exception) => {
      const f = fixture();
      await f.start();
      await f.adapter.inspect(challenge());
      Object.assign(f.state, {
        challengeCaptured: true,
        launchClaimed: true,
        nativeReturnAvailable: true,
        nativeReturnProtocol: "stripe_3ds2",
      });
      const resume = await f.adapter.continuation?.();
      f.state.continuationClaimed = true;
      const original = f.send.getMockImplementation()!;
      f.send.mockImplementation(async (method, params, session) => {
        if (method === "Runtime.callFunctionOn") {
          if (exception) throw new Error("CDP response lost");
          return { result: { value: false } };
        }
        return original(method, params, session);
      });
      await expect(
        resume!({ protocol: "stripe_3ds2", cres: cres() }),
      ).rejects.toThrow();
      await expect(
        resume!({ protocol: "stripe_3ds2", cres: cres() }),
      ).rejects.toThrow();
      expect(
        f.send.mock.calls.filter(
          ([method]) => method === "Runtime.callFunctionOn",
        ),
      ).toHaveLength(1);
    },
  );

  it("refuses delivery when the pinned Stripe frame navigates after the claim", async () => {
    const f = fixture();
    await f.start();
    await f.adapter.inspect(challenge());
    Object.assign(f.state, {
      challengeCaptured: true,
      launchClaimed: true,
      nativeReturnAvailable: true,
      nativeReturnProtocol: "stripe_3ds2",
    });
    const resume = await f.adapter.continuation?.();
    f.state.continuationClaimed = true;
    f.navigateAuth("https://hooks.stripe.com/3d_secure_2/other");
    await expect(
      resume!({ protocol: "stripe_3ds2", cres: cres() }),
    ).rejects.toThrow("frame changed");
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    "https://hooks.stripe.com/3d_secure_2/hosted",
    "https://js.stripe.com/v3/three-ds-2-fingerprint-abc123.html",
    "https://js.stripe.com/v3/unknown.html",
  ])(
    "leaves unrecognized native receivers outside capture: %s",
    async (url) => {
      const f = fixture();
      await f.start();
      f.navigateAuth(url);
      expect(await f.adapter.inspect(challenge())).toBe("fallback");
      expect(await f.adapter.continuation?.()).toBeNull();
    },
  );

  it("binds a direct challenge's nested Stripe source before capture", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond(
      paymentIntent({
        next_action: {
          type: "use_stripe_sdk",
          use_stripe_sdk: {
            type: "stripe_3ds2_challenge",
            stripe_js: { three_d_secure_2_source: "src_demo" },
          },
        },
      }),
    );
    expect(await f.adapter.inspect(challenge())).toMatchObject({
      capture: { nativeReturn: "stripe_3ds2" },
    });
  });

  it("leaves a challenge without a bound Stripe source native", async () => {
    const f = fixture();
    await f.adapter.inspect(confirm());
    await f.respond(
      paymentIntent({
        next_action: {
          type: "use_stripe_sdk",
          use_stripe_sdk: { type: "stripe_3ds2_fingerprint" },
        },
      }),
    );
    expect(await f.adapter.inspect(challenge())).toBe("fallback");
  });

  it.each(["confirmed", "failed"] as const)(
    "settles VerificationSession.wait after the hosted return: %s",
    async (outcome) => {
      jest.useFakeTimers();
      const f = fixture();
      const report = jest.fn(async (_id, input) => {
        f.state.version++;
        if (input.kind === "challenge_observed") {
          expect(input.capture.nativeReturn).toBe("stripe_3ds2");
          Object.assign(f.state, {
            challengeCaptured: true,
            status: "requires_action",
          });
        }
        if (input.kind === "continuation_started") {
          f.state.continuationClaimed = true;
          return {
            ...f.state,
            nativeReturn: { protocol: "stripe_3ds2" as const, cres: cres() },
          };
        }
        if (input.kind === "interaction_resumed")
          f.state.interactionReturned = true;
        if (input.kind === "checkout_observed")
          Object.assign(f.state, {
            status: "ended",
            observation: {
              outcome: input.observation.outcome,
              source: "runner",
            },
          });
        return { ...f.state };
      });
      const session = await VerificationSession.attach(
        {
          register: async () => f.state,
          sync: async () => ({ ...f.state }),
          report,
        },
        f.adapter,
        "injection",
      );
      expect(await session!.inspect(confirm())).toBe("continue");
      await f.respond(paymentIntent());
      expect(await session!.inspect(challenge())).toBe("capture");
      const finished = session!.wait();
      Object.assign(f.state, {
        launchClaimed: true,
        nativeReturnAvailable: true,
        nativeReturnProtocol: "stripe_3ds2",
      });
      await jest.advanceTimersByTimeAsync(2000);
      expect(session!.current().interactionReturned).toBe(true);
      expect(session!.current()).not.toHaveProperty("nativeReturn");
      expect(session!.current().observation).toBeUndefined();
      expect(await session!.inspect(confirm())).toBe("block");
      const url = "https://api.stripe.com/v1/3ds2/challenge_complete";
      expect(
        await session!.inspect(
          confirm({ url, body: "source=src_demo", networkId: "complete" }),
        ),
      ).toBe("continue");
      if (outcome === "failed") {
        await f.respond(
          { error: { code: "payment_intent_authentication_failure" } },
          "complete",
          url,
        );
      } else {
        const url = confirmUrl.replace("/confirm", "");
        expect(
          await session!.inspect(
            confirm({ url, method: "GET", body: "", networkId: "retrieve" }),
          ),
        ).toBe("continue");
        await f.respond(
          paymentIntent({ status: "succeeded", next_action: null }),
          "retrieve",
          url,
        );
      }
      await jest.advanceTimersByTimeAsync(4000);
      expect((await finished).observation).toEqual({
        outcome,
        source: "runner",
      });
      expect(report.mock.calls.map(([, input]) => input.kind)).toEqual([
        "challenge_observed",
        "continuation_started",
        "interaction_resumed",
        "checkout_observed",
      ]);
      expect(
        f.send.mock.calls.filter(
          ([method]) => method === "Runtime.callFunctionOn",
        ),
      ).toHaveLength(1);
      await session!.close();
    },
  );

  it("exports the adapter factory and captures only the original supported bank POST", async () => {
    const f = fixture();
    expect(f.adapter).toBeInstanceOf(StripePaymentElementVerification);
    await f.start();
    const request = challenge();
    expect(await f.adapter.inspect(request)).toEqual({
      capture: {
        url: request.url,
        body: request.body,
        nativeReturn: "stripe_3ds2",
      },
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
        nativeReturn: "stripe_3ds2",
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
                  url: "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html",
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
          ? {
              capture: {
                url: request.url,
                body: request.body,
                nativeReturn: "stripe_3ds2",
              },
            }
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
