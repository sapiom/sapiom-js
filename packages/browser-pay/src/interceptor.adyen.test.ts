import { createHash } from "node:crypto";

import { ADYEN_BLOB_BINDING, ADYEN_WATCH_WORLD } from "./adyen-blobs";
import type { RelayRequest, RelayResponse } from "./contract";
import type { HeldPlaceholder } from "./detect";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import type { PayLogger } from "./logger";
import type { PaymentRelay } from "./relay";
import {
  startCdpStub,
  waitFor,
  type CdpCommand,
  type CdpStub,
} from "../test/cdp-stub";

const HELD: HeldPlaceholder = {
  number: "4242424242424242",
  injectionRef: "inj_adyen",
};
const PAGE_ORIGIN = "https://shop.example";
const CLIENT_KEY = "test_FRAMEKEY123";
const ADYEN_TEST = "https://checkoutshopper-test.adyen.com/checkoutshopper";
const frameUrl = (key: string, field = "encryptedCardNumber") =>
  `https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/${key}/6.4.1/securedFields.html?type=card&d=${field}`;

/** What the page's secured fields encrypted: the placeholder card. */
const PLACEHOLDER_BLOBS = {
  encryptedCardNumber: "eyJ.PLACEHOLDER_NUMBER_BLOB",
  encryptedExpiryMonth: "eyJ.PLACEHOLDER_MONTH_BLOB",
  encryptedExpiryYear: "eyJ.PLACEHOLDER_YEAR_BLOB",
  encryptedSecurityCode: "eyJ.PLACEHOLDER_CVC_BLOB",
};
type BlobField = keyof typeof PLACEHOLDER_BLOBS;

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const HASHES = Object.fromEntries(
  Object.entries(PLACEHOLDER_BLOBS).map(([field, blob]) => [
    field,
    sha256(blob),
  ]),
) as Record<BlobField, string>;

const ADVANCED = {
  url: "https://shop.example/api/payments",
  body: {
    amount: { currency: "EUR", value: 1000 },
    reference: "order-1",
    paymentMethod: {
      type: "scheme",
      holderName: "J. Smith",
      ...PLACEHOLDER_BLOBS,
      checkoutAttemptId: "attempt-1",
    },
    browserInfo: { userAgent: "agent" },
  },
};
const SESSIONS = {
  url: `https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS123/payments?clientKey=${CLIENT_KEY}`,
  body: {
    sessionData: "Ab02b4c0!session",
    paymentMethod: { type: "scheme", ...PLACEHOLDER_BLOBS },
    origin: PAGE_ORIGIN,
  },
};

const AUTHORISED: RelayResponse = {
  outcome: "relayed",
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    setCookies: ["adyen_session=s1; Path=/; HttpOnly"],
    body: JSON.stringify({ resultCode: "Authorised", pspReference: "PSP1" }),
  },
};

interface Harness {
  stub: CdpStub;
  events: InterceptorEvent[];
  warnings: string[];
  relayCalls: RelayRequest[];
  detach(): Promise<void>;
}

async function arm(options: {
  frames?: { sessionId: string; url: string }[];
  answer?: (request: RelayRequest) => Promise<RelayResponse>;
  profileId?: string;
  /** Blobs the page's secured fields posted; all four unless given. */
  observed?: Partial<Record<BlobField, string>>;
}): Promise<Harness> {
  const stub = await startCdpStub((command) => {
    if (command.method !== "Runtime.evaluate") return undefined;
    if (command.params.expression === "location.origin") {
      return { result: { type: "string", value: PAGE_ORIGIN } };
    }
    return undefined;
  });
  const events: InterceptorEvent[] = [];
  const warnings: string[] = [];
  const relayCalls: RelayRequest[] = [];
  const answer = options.answer ?? (async () => AUTHORISED);
  const relay: PaymentRelay = {
    async relay(request) {
      relayCalls.push(request);
      return answer(request);
    },
  };
  const logger: PayLogger = {
    warn(message, fields) {
      warnings.push(JSON.stringify({ message, fields }));
    },
  };
  const handle = await attachInterceptor(stub.url, {
    relay,
    placeholder: HELD,
    logger,
    ...(options.profileId ? { profileId: options.profileId } : {}),
  });
  handle.on((event) => events.push(event));
  const harness: Harness = {
    stub,
    events,
    warnings,
    relayCalls,
    detach: () => handle.detach(),
  };
  stub.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId: "page-1",
      waitingForDebugger: true,
      targetInfo: {
        targetId: "target-page",
        type: "page",
        url: `${PAGE_ORIGIN}/checkout`,
      },
    },
  });
  for (const frame of options.frames ?? []) {
    stub.emit({
      method: "Target.attachedToTarget",
      sessionId: "page-1",
      params: {
        sessionId: frame.sessionId,
        waitingForDebugger: true,
        targetInfo: {
          targetId: `target-${frame.sessionId}`,
          type: "iframe",
          url: frame.url,
        },
      },
    });
  }
  const sessions = 1 + (options.frames?.length ?? 0);
  await waitFor(
    () => count(stub.commands, "Fetch.enable") === sessions,
    "Fetch.enable on every session",
  );
  observe(stub, options.observed ?? PLACEHOLDER_BLOBS);
  return harness;
}

/** What the watch script reports for each secured-fields encryption message. */
function observe(
  stub: CdpStub,
  blobs: Partial<Record<BlobField, string>>,
  sessionId = "page-1",
  name = ADYEN_BLOB_BINDING,
  world = ADYEN_WATCH_WORLD,
): void {
  stub.emit({
    method: "Runtime.executionContextCreated",
    sessionId,
    params: { context: { id: 1, name: world, auxData: { isDefault: false } } },
  });
  for (const [field, blob] of Object.entries(blobs)) {
    stub.emit({
      method: "Runtime.bindingCalled",
      sessionId,
      params: {
        name,
        payload: JSON.stringify({ field, blob }),
        executionContextId: 1,
      },
    });
  }
}

function count(commands: CdpCommand[], method: string): number {
  return commands.filter((command) => command.method === method).length;
}

function pause(
  stub: CdpStub,
  requestId: string,
  request: {
    url: string;
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
  },
): void {
  stub.emit({
    method: "Fetch.requestPaused",
    sessionId: "page-1",
    params: {
      requestId,
      request: {
        url: request.url,
        method: request.method ?? "POST",
        headers: { "content-type": "application/json", ...request.headers },
        ...(request.body !== undefined
          ? { postData: JSON.stringify(request.body), hasPostData: true }
          : {}),
      },
    },
  });
}

function settledWith(stub: CdpStub, requestId: string): CdpCommand | undefined {
  return stub.commands.find(
    (command) =>
      (command.method === "Fetch.continueRequest" ||
        command.method === "Fetch.fulfillRequest" ||
        command.method === "Fetch.failRequest") &&
      command.params.requestId === requestId,
  );
}

async function settle(stub: CdpStub, requestId: string): Promise<CdpCommand> {
  await waitFor(
    () => settledWith(stub, requestId) !== undefined,
    `request ${requestId} settled`,
  );
  return settledWith(stub, requestId)!;
}

const SECRETS = [
  CLIENT_KEY,
  "FRAMEKEY",
  "PLACEHOLDER_",
  "eyJ",
  "s1;",
  "shop_session",
  ...Object.values(HASHES),
];

function assertNothingSecret(harness: Harness): void {
  const text = JSON.stringify(harness.events) + harness.warnings.join("\n");
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

const KEY_FRAME = [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }];

describe("interceptor on Adyen secured-fields checkouts", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.detach();
    await harness?.stub.close();
    harness = undefined;
  });

  it("relays the merchant's /payments call verbatim with profile adyen-checkout and the frame's client key, and fulfils the page with the relay's answer", async () => {
    harness = await arm({
      frames: [
        ...KEY_FRAME,
        {
          sessionId: "frame-cvc",
          url: frameUrl(CLIENT_KEY, "encryptedSecurityCode"),
        },
      ],
    });
    pause(harness.stub, "req-advanced", {
      ...ADVANCED,
      headers: {
        Accept: "application/json",
        Origin: PAGE_ORIGIN,
        Cookie: "shop_session=abc",
        "X-Csrf-Token": "t1",
      },
    });
    const settled = await settle(harness.stub, "req-advanced");

    expect(harness.relayCalls).toHaveLength(1);
    const sent = harness.relayCalls[0]!;
    expect(sent).toStrictEqual({
      injectionRef: HELD.injectionRef,
      profileId: "adyen-checkout",
      adyen: { clientKey: CLIENT_KEY, placeholderBlobHashes: HASHES },
      pageOrigin: PAGE_ORIGIN,
      request: {
        method: "POST",
        url: ADVANCED.url,
        headers: expect.anything(),
        body: JSON.stringify(ADVANCED.body),
      },
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The merchant's own endpoint gets the page's session cookie and CSRF
    // header, under the same rules as any relayed request.
    expect({ ...sent.request.headers }).toStrictEqual({
      accept: "application/json",
      "content-type": "application/json",
      origin: PAGE_ORIGIN,
      cookie: "shop_session=abc",
      "x-csrf-token": "t1",
    });

    expect(settled.sessionId).toBe("page-1");
    expect(settled.method).toBe("Fetch.fulfillRequest");
    expect(settled.params).toStrictEqual({
      requestId: "req-advanced",
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "Set-Cookie", value: "adyen_session=s1; Path=/; HttpOnly" },
      ],
      body: Buffer.from(
        JSON.stringify({ resultCode: "Authorised", pspReference: "PSP1" }),
      ).toString("base64"),
    });
    expect(count(harness.stub.commands, "Fetch.continueRequest")).toBe(0);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events).toStrictEqual([
      { type: "paused", url: PAGE_ORIGIN, method: "POST", targetType: "page" },
      { type: "relayed", url: PAGE_ORIGIN, status: 200 },
    ]);
    assertNothingSecret(harness);
  });

  it("relays Adyen's /sessions/{id}/payments call, keeping the page's Origin", async () => {
    harness = await arm({ frames: KEY_FRAME });
    pause(harness.stub, "req-sessions", {
      ...SESSIONS,
      headers: { Origin: PAGE_ORIGIN },
    });
    const settled = await settle(harness.stub, "req-sessions");

    expect(settled.method).toBe("Fetch.fulfillRequest");
    const sent = harness.relayCalls[0]!;
    expect(sent.profileId).toBe("adyen-checkout");
    expect(sent.adyen).toStrictEqual({
      clientKey: CLIENT_KEY,
      placeholderBlobHashes: HASHES,
    });
    expect(sent.request.url).toBe(SESSIONS.url);
    expect(sent.request.body).toBe(JSON.stringify(SESSIONS.body));
    expect(sent.request.headers.origin).toBe(PAGE_ORIGIN);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toStrictEqual({
      type: "relayed",
      url: "https://checkoutshopper-test.adyen.com",
      status: 200,
    });
    assertNothingSecret(harness);
  });

  it("never sends merchant cookies or CSRF headers to Adyen's sessions endpoint", async () => {
    harness = await arm({ frames: KEY_FRAME });
    pause(harness.stub, "req-sessions-cookie", {
      ...SESSIONS,
      headers: {
        Accept: "application/json",
        Origin: PAGE_ORIGIN,
        Cookie: "shop_session=abc",
        "X-Csrf-Token": "t1",
      },
    });
    await settle(harness.stub, "req-sessions-cookie");

    expect({ ...harness.relayCalls[0]!.request.headers }).toStrictEqual({
      accept: "application/json",
      "content-type": "application/json",
      origin: PAGE_ORIGIN,
    });
    assertNothingSecret(harness);
  });

  it.each(["application/json", "text/plain"])(
    "fails an unrelated collector locally without relaying (%s)",
    async (contentType) => {
      harness = await arm({ frames: KEY_FRAME });
      pause(harness.stub, "req-collector", {
        url: "https://collector.example/x",
        body: ADVANCED.body,
        headers: {
          "content-type": contentType,
          "sec-fetch-mode": "no-cors",
        },
      });
      const settled = await settle(harness.stub, "req-collector");

      expect(harness.relayCalls.length).toBe(0);
      expect(settled.method).toBe("Fetch.failRequest");
      expect(count(harness.stub.commands, "Fetch.continueRequest")).toBe(0);
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.events[1]).toStrictEqual({
        type: "failed",
        url: "https://collector.example",
        reason: "destination_not_allowed",
      });
      assertNothingSecret(harness);
    },
  );

  it.each([
    ["https://shop.example.evil.example/api/payments", "POST"],
    [
      "https://checkoutshopper-test.adyen.com.evil.example/checkoutshopper/v1/sessions/CS123/payments",
      "POST",
    ],
    [
      "https://checkoutshopper-test.adyen.com/checkoutshopper/v1/payments",
      "POST",
    ],
    [
      "https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS123/payments/extra",
      "POST",
    ],
    [
      "http://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS123/payments",
      "POST",
    ],
    [
      "https://checkoutshopper-live.adyen.com/checkoutshopper/v1/sessions/CS123/payments",
      "POST",
    ],
    [
      "https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS123/payments#fragment",
      "POST",
    ],
    [
      "https://user@checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS123/payments",
      "POST",
    ],
    [
      "https://checkoutshopper-test.adyen.com:8443/checkoutshopper/v1/sessions/CS123/payments",
      "POST",
    ],
    [SESSIONS.url, "PUT"],
    [ADVANCED.url, "PUT"],
  ])(
    "fails a destination outside the checkout contract (%s, %s)",
    async (url, method) => {
      harness = await arm({ frames: KEY_FRAME });
      pause(harness.stub, "req-destination", { ...ADVANCED, url, method });
      const settled = await settle(harness.stub, "req-destination");

      expect(harness.relayCalls.length).toBe(0);
      expect(settled.method).toBe("Fetch.failRequest");
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.events[1]).toMatchObject({
        type: "failed",
        reason: "destination_not_allowed",
      });
      assertNothingSecret(harness);
    },
  );

  it("sends the page origin as Origin when the paused request carries none", async () => {
    harness = await arm({ frames: KEY_FRAME });
    pause(harness.stub, "req-no-origin", ADVANCED);
    await settle(harness.stub, "req-no-origin");

    expect(harness.relayCalls[0]?.request.headers.origin).toBe(PAGE_ORIGIN);
  });

  it("uses adyen-checkout even when the attach names another profile", async () => {
    harness = await arm({ frames: KEY_FRAME, profileId: "shopify-card-vault" });
    pause(harness.stub, "req-advanced", ADVANCED);
    await settle(harness.stub, "req-advanced");

    expect(harness.relayCalls[0]?.profileId).toBe("adyen-checkout");
  });

  it("hands the page Adyen's refusal, 3-D Secure action or error as the relay returned it", async () => {
    const challenge = JSON.stringify({
      resultCode: "ChallengeShopper",
      action: { type: "threeDS2", token: "tok" },
    });
    harness = await arm({
      frames: KEY_FRAME,
      answer: async () => ({
        outcome: "relayed",
        response: { status: 200, headers: {}, body: challenge },
      }),
    });
    pause(harness.stub, "req-3ds", ADVANCED);
    const settled = await settle(harness.stub, "req-3ds");

    expect(settled.method).toBe("Fetch.fulfillRequest");
    expect(
      Buffer.from(settled.params.body as string, "base64").toString("utf8"),
    ).toBe(challenge);
  });

  it.each([
    ["card_fields_invalid", false],
    ["destination_not_allowed", false],
    ["adyen_client_key_unknown", undefined],
  ] as const)(
    "fails the page request cleanly when the relay refuses (%s), never sending the placeholder's blobs on",
    async (reason, retryable) => {
      harness = await arm({
        frames: KEY_FRAME,
        answer: async () => ({
          outcome: "refused",
          reason,
          ...(retryable !== undefined ? { retryable } : {}),
        }),
      });
      pause(harness.stub, "req-refused", ADVANCED);
      const settled = await settle(harness.stub, "req-refused");

      expect(settled.method).toBe("Fetch.failRequest");
      expect(count(harness.stub.commands, "Fetch.continueRequest")).toBe(0);
      expect(harness.relayCalls).toHaveLength(1);
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.events[1]).toStrictEqual({
        type: "refused",
        url: PAGE_ORIGIN,
        reason,
        ...(retryable !== undefined ? { retryable } : {}),
      });
      assertNothingSecret(harness);
    },
  );

  it("fails the page request when the relay outcome is unknown or the relay errors", async () => {
    harness = await arm({
      frames: KEY_FRAME,
      answer: async (request) => {
        if (request.request.url.endsWith("/unknown")) {
          return { outcome: "unknown" };
        }
        throw new Error("connect ECONNREFUSED eyJ.PLACEHOLDER_NUMBER_BLOB");
      },
    });
    pause(harness.stub, "req-unknown", {
      ...ADVANCED,
      url: `${PAGE_ORIGIN}/api/payments/unknown`,
    });
    pause(harness.stub, "req-error", ADVANCED);
    for (const id of ["req-unknown", "req-error"]) {
      expect((await settle(harness.stub, id)).method).toBe("Fetch.failRequest");
    }
    expect(count(harness.stub.commands, "Fetch.continueRequest")).toBe(0);
    await waitFor(() => harness!.events.length === 4, "four events");
    expect(
      harness.events
        .filter((event) => event.type === "failed")
        .map((event) => event.type === "failed" && event.reason)
        .sort(),
    ).toStrictEqual(["network", "unknown"]);
    assertNothingSecret(harness);
  });

  it.each([
    ["a clientKeys path", { url: `${ADYEN_TEST}/v1/clientKeys/${CLIENT_KEY}` }],
    [
      "an x-client-key header",
      {
        url: `${ADYEN_TEST}/v3/analytics`,
        headers: { "X-Client-Key": CLIENT_KEY },
      },
    ],
  ])(
    "takes the key from Adyen's own request (%s) when no secured-field frame is a target",
    async (_label, request) => {
      harness = await arm({});
      pause(harness.stub, "req-key", { ...request, method: "GET" });
      await settle(harness.stub, "req-key");
      pause(harness.stub, "req-pay", ADVANCED);
      await settle(harness.stub, "req-pay");

      expect(harness.relayCalls[0]?.adyen).toStrictEqual({
        clientKey: CLIENT_KEY,
        placeholderBlobHashes: HASHES,
      });
      assertNothingSecret(harness);
    },
  );

  it("ignores keys from lookalike hosts, plain http, a wrong environment or a bad shape", async () => {
    harness = await arm({});
    const urls = [
      `https://checkoutshopper-test.adyen.com.evil.example/checkoutshopper/v1/clientKeys/${CLIENT_KEY}`,
      `http://checkoutshopper-test.adyen.com/checkoutshopper/v1/clientKeys/${CLIENT_KEY}`,
      `https://checkoutshopper-live-us.adyen.com.evil.example/checkoutshopper/v1/clientKeys/live_FRAMEKEY123`,
      `https://checkoutshopper-live-us.adyen.com/checkoutshopper/v1/clientKeys/${CLIENT_KEY}`,
      `https://checkoutanalytics-test.adyen.com/checkoutanalytics/v3/analytics?clientKey=${CLIENT_KEY}`,
      `${ADYEN_TEST}/v1/clientKeys/live_FRAMEKEY123`,
      `${ADYEN_TEST}/v1/clientKeys/test_frame-key`,
      `${PAGE_ORIGIN}/checkout?clientKey=${CLIENT_KEY}`,
    ];
    urls.forEach((url, i) =>
      pause(harness!.stub, `req-${i}`, { url, method: "GET" }),
    );
    for (const [i] of urls.entries()) await settle(harness.stub, `req-${i}`);
    pause(harness.stub, "req-pay", ADVANCED);
    const settled = await settle(harness.stub, "req-pay");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.relayCalls).toHaveLength(0);
  });

  it("continues requests that are not Adyen payments untouched", async () => {
    harness = await arm({ frames: KEY_FRAME });
    pause(harness.stub, "req-analytics", {
      url: "https://checkoutshopper-test.adyen.com/checkoutshopper/v3/analytics",
      body: { info: [{ type: "rendered" }] },
    });
    pause(harness.stub, "req-other", {
      url: "https://shop.example/api/cart",
      body: { encryptedCardNumber: "eyJ.top-level-is-not-adyen" },
    });
    pause(harness.stub, "req-form", {
      url: "https://shop.example/api/payments",
      body: "paymentMethod.encryptedCardNumber=eyJ",
    });
    pause(harness.stub, "req-get", {
      url: "https://shop.example/api/payments",
      method: "GET",
    });
    for (const id of ["req-analytics", "req-other", "req-form", "req-get"]) {
      const settled = await settle(harness.stub, id);
      expect(settled.method).toBe("Fetch.continueRequest");
      expect(settled.params).toStrictEqual({ requestId: id });
    }
    expect(harness.relayCalls).toHaveLength(0);
    expect(harness.events).toStrictEqual([]);
  });

  it("refuses encrypted payments without any Adyen signal and warns once per attach", async () => {
    harness = await arm({});
    for (const id of ["req-unsupported", "req-retry"]) {
      pause(harness.stub, id, ADVANCED);
      expect((await settle(harness.stub, id)).method).toBe("Fetch.failRequest");
    }
    expect(harness.relayCalls).toHaveLength(0);
    await waitFor(() => harness!.events.length === 4, "four events");
    const outcome = [
      { type: "paused", url: PAGE_ORIGIN, method: "POST", targetType: "page" },
      {
        type: "failed",
        url: PAGE_ORIGIN,
        reason: "unsupported_encrypted_checkout",
      },
    ];
    expect(harness.events).toStrictEqual([...outcome, ...outcome]);
    expect(harness.warnings).toStrictEqual([
      JSON.stringify({
        message: "encrypted checkout has no supported PSP signal",
      }),
    ]);
    assertNothingSecret(harness);
  });

  it.each([
    "http://checkoutshopper-test.adyen.com/checkoutshopper",
    "https://checkoutshopper-test.adyen.com.evil.example/checkoutshopper",
  ])(
    "does not identify Adyen from an untrusted frame or request (%s)",
    async (url) => {
      harness = await arm({ frames: [{ sessionId: "frame-lookalike", url }] });
      pause(harness.stub, "req-lookalike", { url, method: "GET" });
      await settle(harness.stub, "req-lookalike");
      pause(harness.stub, "req-pay", ADVANCED);
      expect((await settle(harness.stub, "req-pay")).method).toBe(
        "Fetch.failRequest",
      );
      expect(harness.relayCalls).toHaveLength(0);
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.events[1]).toStrictEqual({
        type: "failed",
        url: PAGE_ORIGIN,
        reason: "unsupported_encrypted_checkout",
      });
      assertNothingSecret(harness);
    },
  );

  it.each(["Fetch.requestPaused", "Network.requestWillBeSent"])(
    "fails the request closed, without asking the relay, when no Adyen request named a client key (%s)",
    async (method) => {
      harness = await arm({});
      harness.stub.emit({
        method,
        sessionId: "page-1",
        params: {
          requestId: "req-adyen",
          request: {
            url: `${ADYEN_TEST}/v3/analytics`,
            method: "GET",
            headers: {},
          },
        },
      });
      if (method === "Fetch.requestPaused")
        await settle(harness.stub, "req-adyen");
      pause(harness.stub, "req-nokey", ADVANCED);
      const settled = await settle(harness.stub, "req-nokey");

      expect(settled.method).toBe("Fetch.failRequest");
      expect(harness.relayCalls).toHaveLength(0);
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.warnings).toStrictEqual([
        JSON.stringify({
          message: "adyen client key not seen in adyen requests",
        }),
      ]);
      expect(harness.events[1]).toStrictEqual({
        type: "failed",
        url: PAGE_ORIGIN,
        reason: "adyen_client_key",
      });
    },
  );

  it("does not guess between two different client keys on one page", async () => {
    harness = await arm({
      frames: [
        { sessionId: "frame-a", url: frameUrl(CLIENT_KEY) },
        { sessionId: "frame-b", url: frameUrl("test_OTHERKEY789") },
      ],
    });
    pause(harness.stub, "req-ambiguous", ADVANCED);
    const settled = await settle(harness.stub, "req-ambiguous");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.relayCalls).toHaveLength(0);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toMatchObject({ reason: "adyen_client_key" });
    expect(harness.warnings).toStrictEqual([
      JSON.stringify({
        message: "two different adyen client keys seen in adyen requests",
      }),
    ]);
  });

  it("does not guess when Adyen's requests name a key other than the frame's", async () => {
    harness = await arm({ frames: KEY_FRAME });
    pause(harness.stub, "req-other-key", {
      url: `${ADYEN_TEST}/v1/clientKeys/test_OTHERKEY789`,
      method: "GET",
    });
    await settle(harness.stub, "req-other-key");
    pause(harness.stub, "req-ambiguous", ADVANCED);
    const settled = await settle(harness.stub, "req-ambiguous");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.relayCalls).toHaveLength(0);
  });

  it("relays with a lowercase client key from the secured-field frame", async () => {
    const lowercase = "test_870be2854add4f56b86778353010f36c";
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(lowercase) }],
    });
    pause(harness.stub, "req-lower", ADVANCED);
    await settle(harness.stub, "req-lower");

    expect(harness.relayCalls[0]?.adyen).toStrictEqual({
      clientKey: lowercase,
      placeholderBlobHashes: HASHES,
    });
  });

  it("relays a plain card request without an Adyen signal under the attach's own profile", async () => {
    harness = await arm({ profileId: "shopify-card-vault" });
    const request = { url: ADVANCED.url, body: { number: HELD.number } };
    pause(harness.stub, "req-plain", request);
    expect((await settle(harness.stub, "req-plain")).method).toBe(
      "Fetch.fulfillRequest",
    );
    expect(harness.relayCalls).toHaveLength(1);
    expect(harness.relayCalls[0]?.profileId).toBe("shopify-card-vault");
    expect(harness.relayCalls[0]?.request.body).toBe(
      JSON.stringify(request.body),
    );
    expect(harness.relayCalls[0]).not.toHaveProperty("adyen");
    expect(harness.warnings).toStrictEqual([]);
    assertNothingSecret(harness);
  });

  it("relays a body holding the placeholder digits as before, under the attach's own profile", async () => {
    harness = await arm({ frames: KEY_FRAME });
    pause(harness.stub, "req-held", {
      url: "https://shop.example/api/payments",
      body: { paymentMethod: { encryptedCardNumber: `test_${HELD.number}` } },
    });
    await waitFor(() => harness!.relayCalls.length === 1, "relay call");
    expect(harness.relayCalls[0]).not.toHaveProperty("profileId");
    expect(harness.relayCalls[0]).not.toHaveProperty("adyen");
  });

  it("installs the passive secured-fields listener on every armed session before it runs", async () => {
    harness = await arm({ frames: KEY_FRAME });
    for (const sessionId of ["page-1", "frame-number"]) {
      // A session's setup can still be in flight when arm returns; its resume is the last step.
      await waitFor(
        () =>
          harness!.stub.commands.some(
            (command) =>
              command.sessionId === sessionId &&
              command.method === "Runtime.runIfWaitingForDebugger",
          ),
        `${sessionId} resumed`,
      );
      const methods = harness.stub.commands
        .filter((command) => command.sessionId === sessionId)
        .map((command) => command.method);
      const resumed = methods.indexOf("Runtime.runIfWaitingForDebugger");
      expect(methods.indexOf("Runtime.addBinding")).toBeGreaterThan(-1);
      expect(methods.indexOf("Runtime.addBinding")).toBeLessThan(resumed);
      expect(
        methods.indexOf("Page.addScriptToEvaluateOnNewDocument"),
      ).toBeLessThan(resumed);
    }
    const binding = harness.stub.commands.find(
      (command) => command.method === "Runtime.addBinding",
    );
    expect(binding?.params).toStrictEqual({
      name: ADYEN_BLOB_BINDING,
      executionContextName: ADYEN_WATCH_WORLD,
    });
    const script = harness.stub.commands.find(
      (command) => command.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(script?.params.worldName).toBe(ADYEN_WATCH_WORLD);
  });

  it.each(Object.keys(PLACEHOLDER_BLOBS) as BlobField[])(
    "fails the Pay locally, without asking the relay, when %s was never observed",
    async (missing) => {
      const observed: Partial<Record<BlobField, string>> = {
        ...PLACEHOLDER_BLOBS,
      };
      delete observed[missing];
      harness = await arm({ frames: KEY_FRAME, observed });
      pause(harness.stub, "req-unobserved", ADVANCED);
      const settled = await settle(harness.stub, "req-unobserved");

      expect(settled.method).toBe("Fetch.failRequest");
      expect(harness.relayCalls).toHaveLength(0);
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.events[1]).toStrictEqual({
        type: "failed",
        url: PAGE_ORIGIN,
        reason: "adyen_placeholder_unobserved",
      });
      expect(harness.warnings).toStrictEqual([
        JSON.stringify({
          message: "adyen placeholder blobs not observed",
          fields: { missing },
        }),
      ]);
      assertNothingSecret(harness);
    },
  );

  it("ignores binding calls under another name, from an unknown session, from outside the watch world, or with a bad shape", async () => {
    harness = await arm({ frames: KEY_FRAME, observed: {} });
    observe(harness.stub, PLACEHOLDER_BLOBS, "page-1", "otherBinding");
    observe(harness.stub, PLACEHOLDER_BLOBS, "stranger");
    observe(
      harness.stub,
      PLACEHOLDER_BLOBS,
      "frame-number",
      ADYEN_BLOB_BINDING,
      "",
    );
    for (const payload of [
      "not json",
      JSON.stringify({ field: "encryptedCardNumberX", blob: "eyJ.x" }),
      JSON.stringify({ field: "encryptedCardNumber", blob: "" }),
      JSON.stringify({ field: "encryptedCardNumber", blob: 7 }),
    ]) {
      harness.stub.emit({
        method: "Runtime.bindingCalled",
        sessionId: "page-1",
        params: { name: ADYEN_BLOB_BINDING, payload, executionContextId: 1 },
      });
    }
    pause(harness.stub, "req-ignored", ADVANCED);
    const settled = await settle(harness.stub, "req-ignored");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.relayCalls).toHaveLength(0);
  });

  it("sends the hash of the latest blob per field, observed in any armed frame", async () => {
    harness = await arm({ frames: KEY_FRAME });
    observe(
      harness.stub,
      { encryptedSecurityCode: "eyJ.RETYPED_CVC_BLOB" },
      "frame-number",
    );
    pause(harness.stub, "req-latest", ADVANCED);
    await settle(harness.stub, "req-latest");

    expect(harness.relayCalls[0]?.adyen?.placeholderBlobHashes).toStrictEqual({
      ...HASHES,
      encryptedSecurityCode: sha256("eyJ.RETYPED_CVC_BLOB"),
    });
  });
});
