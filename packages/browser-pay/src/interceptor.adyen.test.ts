import type {
  AdyenEncryptedFields,
  AdyenEncryptRequest,
  AdyenEncryptResult,
} from "./contract";
import {
  ADYEN_DOM_CLIENT_KEY_EXPRESSION,
  type HeldPlaceholder,
} from "./detect";
import {
  attachInterceptor,
  type InterceptorEvent,
  type InterceptorHandle,
} from "./interceptor";
import type { PayLogger } from "./logger";
import {
  RelayHttpError,
  type PaymentRelay,
  type RelayCallOptions,
} from "./relay";
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
const DOM_KEY = "test_DOMKEY456";
const frameUrl = (key: string, field = "encryptedCardNumber") =>
  `https://checkoutshopper-test.adyen.com/checkoutshopper/securedfields/${key}/6.4.1/securedFields.html?type=card&d=${field}`;

const STAND_IN = {
  encryptedCardNumber: "eyJ.STANDIN_NUMBER_BLOB",
  encryptedExpiryMonth: "eyJ.STANDIN_MONTH_BLOB",
  encryptedExpiryYear: "eyJ.STANDIN_YEAR_BLOB",
  encryptedSecurityCode: "eyJ.STANDIN_CVC_BLOB",
};
const REAL: AdyenEncryptedFields = {
  encryptedCardNumber: "eyJ.REAL_NUMBER_BLOB",
  encryptedExpiryMonth: "eyJ.REAL_MONTH_BLOB",
  encryptedExpiryYear: "eyJ.REAL_YEAR_BLOB",
  encryptedSecurityCode: "eyJ.REAL_CVC_BLOB",
};

const ENCRYPTED: AdyenEncryptResult = { outcome: "encrypted", fields: REAL };
const NOT_ENABLED: AdyenEncryptResult = { outcome: "not_enabled" };

const ADVANCED = {
  url: "https://shop.example/api/payments",
  body: {
    amount: { currency: "EUR", value: 1000 },
    reference: "order-1",
    paymentMethod: {
      type: "scheme",
      holderName: "J. Smith",
      ...STAND_IN,
      checkoutAttemptId: "attempt-1",
    },
    browserInfo: { userAgent: "agent" },
  },
};
const SESSIONS = {
  url: `https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/CS123/payments?clientKey=${CLIENT_KEY}`,
  body: {
    sessionData: "Ab02b4c0!session",
    paymentMethod: { type: "scheme", ...STAND_IN },
    origin: PAGE_ORIGIN,
  },
};

interface Harness {
  stub: CdpStub;
  events: InterceptorEvent[];
  warnings: string[];
  encryptCalls: AdyenEncryptRequest[];
  relayCalls: number;
  detach(): Promise<void>;
  prepare: InterceptorHandle["prepareAdyen"];
}

async function arm(options: {
  frames?: { sessionId: string; url: string }[];
  domKey?: string | null;
  encrypt?:
    | ((
        request: AdyenEncryptRequest,
        call?: RelayCallOptions,
      ) => Promise<AdyenEncryptResult>)
    | null;
  attemptTimeoutMs?: number;
  disableAdyenEncryption?: boolean;
}): Promise<Harness> {
  const domKey = options.domKey === undefined ? null : options.domKey;
  const stub = await startCdpStub((command) => {
    if (command.method !== "Runtime.evaluate") return undefined;
    if (command.params.expression === "location.origin") {
      return { result: { type: "string", value: PAGE_ORIGIN } };
    }
    if (command.params.expression === ADYEN_DOM_CLIENT_KEY_EXPRESSION) {
      return { result: { value: domKey } };
    }
    return undefined;
  });
  const events: InterceptorEvent[] = [];
  const warnings: string[] = [];
  const encryptCalls: AdyenEncryptRequest[] = [];
  const harness: Harness = {
    stub,
    events,
    warnings,
    encryptCalls,
    relayCalls: 0,
    detach: async () => {},
    prepare: async () => ({ enabled: false, reason: "adyen_not_enabled" }),
  };
  const relay: PaymentRelay = {
    async relay() {
      harness.relayCalls += 1;
      return { outcome: "unknown" };
    },
  };
  const encrypt =
    options.encrypt === undefined ? async () => ENCRYPTED : options.encrypt;
  if (encrypt) {
    relay.adyenEncrypt = (request, call) => {
      encryptCalls.push(request);
      return encrypt(request, call);
    };
  }
  const logger: PayLogger = {
    warn(message, fields) {
      warnings.push(JSON.stringify({ message, fields }));
    },
  };
  const handle = await attachInterceptor(stub.url, {
    relay,
    placeholder: HELD,
    logger,
    ...(options.attemptTimeoutMs
      ? { attemptTimeoutMs: options.attemptTimeoutMs }
      : {}),
    ...(options.disableAdyenEncryption ? { disableAdyenEncryption: true } : {}),
  });
  harness.prepare = (input) => handle.prepareAdyen(input);
  handle.on((event) => events.push(event));
  harness.detach = () => handle.detach();
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
  return harness;
}

function count(commands: CdpCommand[], method: string): number {
  return commands.filter((command) => command.method === method).length;
}

function pause(
  stub: CdpStub,
  requestId: string,
  request: { url: string; body?: unknown; method?: string },
): void {
  stub.emit({
    method: "Fetch.requestPaused",
    sessionId: "page-1",
    params: {
      requestId,
      request: {
        url: request.url,
        method: request.method ?? "POST",
        headers: { "content-type": "application/json" },
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

function sentBody(command: CdpCommand): unknown {
  expect(command.method).toBe("Fetch.continueRequest");
  expect(typeof command.params.postData).toBe("string");
  return JSON.parse(
    Buffer.from(command.params.postData as string, "base64").toString("utf8"),
  );
}

const SECRETS = [
  CLIENT_KEY,
  DOM_KEY,
  "FRAMEKEY",
  "DOMKEY",
  "STANDIN_",
  "REAL_",
  "eyJ",
];

function assertNothingSecret(harness: Harness): void {
  const text = JSON.stringify(harness.events) + harness.warnings.join("\n");
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("interceptor on Adyen secured-fields checkouts", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.detach();
    await harness?.stub.close();
    harness = undefined;
  });

  it("swaps the four encrypted fields on the merchant's /payments call (iframe src key)", async () => {
    harness = await arm({
      frames: [
        { sessionId: "frame-number", url: frameUrl(CLIENT_KEY) },
        {
          sessionId: "frame-cvc",
          url: frameUrl(CLIENT_KEY, "encryptedSecurityCode"),
        },
      ],
      domKey: DOM_KEY,
    });
    pause(harness.stub, "req-advanced", ADVANCED);
    const settled = await settle(harness.stub, "req-advanced");

    expect(settled.sessionId).toBe("page-1");
    expect(sentBody(settled)).toStrictEqual({
      ...ADVANCED.body,
      paymentMethod: { ...ADVANCED.body.paymentMethod, ...REAL },
    });
    expect(harness.encryptCalls).toStrictEqual([
      {
        injectionRef: HELD.injectionRef,
        clientKey: CLIENT_KEY,
        pageOrigin: PAGE_ORIGIN,
      },
    ]);
    expect(harness.relayCalls).toBe(0);
    // The frame key wins: the DOM is not consulted.
    expect(
      harness.stub.commands.some(
        (command) =>
          command.params.expression === ADYEN_DOM_CLIENT_KEY_EXPRESSION,
      ),
    ).toBe(false);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events).toStrictEqual([
      {
        type: "paused",
        url: PAGE_ORIGIN,
        method: "POST",
        targetType: "page",
      },
      { type: "reencrypted", url: PAGE_ORIGIN },
    ]);
    assertNothingSecret(harness);
  });

  it("swaps the fields on Adyen's /sessions/{id}/payments call", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
    });
    pause(harness.stub, "req-sessions", SESSIONS);
    const settled = await settle(harness.stub, "req-sessions");

    expect(sentBody(settled)).toStrictEqual({
      ...SESSIONS.body,
      paymentMethod: { ...SESSIONS.body.paymentMethod, ...REAL },
    });
    expect(harness.encryptCalls).toHaveLength(1);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toStrictEqual({
      type: "reencrypted",
      url: "https://checkoutshopper-test.adyen.com",
    });
    assertNothingSecret(harness);
  });

  it("falls back to the page's adyen-web config when no secured-field frame is a target", async () => {
    harness = await arm({ domKey: DOM_KEY });
    pause(harness.stub, "req-dom", ADVANCED);
    const settled = await settle(harness.stub, "req-dom");

    expect(sentBody(settled)).toMatchObject({ paymentMethod: REAL });
    expect(harness.encryptCalls[0]?.clientKey).toBe(DOM_KEY);
    const evaluated = harness.stub.commands.find(
      (command) =>
        command.params.expression === ADYEN_DOM_CLIENT_KEY_EXPRESSION,
    );
    expect(evaluated?.sessionId).toBe("page-1");
    assertNothingSecret(harness);
  });

  it("continues requests that are not Adyen payments untouched", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
    });
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
    expect(harness.encryptCalls).toHaveLength(0);
    expect(harness.events).toStrictEqual([]);
  });

  it.each([
    [
      "the backend refuses",
      async () => {
        throw new RelayHttpError(403);
      },
    ],
    [
      "the backend is unreachable",
      async () => {
        throw new Error("connect ECONNREFUSED eyJ.REAL_NUMBER_BLOB");
      },
    ],
  ] as const)(
    "fails the request closed when %s, never sending the stand-in",
    async (_label, encrypt) => {
      harness = await arm({
        frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
        encrypt,
      });
      pause(harness.stub, "req-fail", ADVANCED);
      const settled = await settle(harness.stub, "req-fail");

      expect(settled.method).toBe("Fetch.failRequest");
      expect(count(harness.stub.commands, "Fetch.continueRequest")).toBe(0);
      await waitFor(() => harness!.events.length === 2, "two events");
      expect(harness.events[1]).toStrictEqual({
        type: "failed",
        url: PAGE_ORIGIN,
        reason: "adyen_encrypt",
      });
      expect(harness.warnings).toHaveLength(1);
      expect(harness.warnings[0]).toContain("adyen re-encryption failed");
      assertNothingSecret(harness);
    },
  );

  it("fails the request closed when re-encryption outlasts the attempt timeout", async () => {
    let aborted = false;
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      attemptTimeoutMs: 50,
      encrypt: (_request, call) =>
        new Promise(() => {
          call?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    pause(harness.stub, "req-slow", ADVANCED);
    const settled = await settle(harness.stub, "req-slow");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(aborted).toBe(true);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toMatchObject({ reason: "adyen_encrypt" });
    expect(harness.warnings[0]).toContain('"timedOut":true');
  });

  it("fails the request closed when no client key is on the page", async () => {
    harness = await arm({ domKey: null });
    pause(harness.stub, "req-nokey", ADVANCED);
    const settled = await settle(harness.stub, "req-nokey");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.encryptCalls).toHaveLength(0);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toStrictEqual({
      type: "failed",
      url: PAGE_ORIGIN,
      reason: "adyen_client_key",
    });
  });

  it("does not guess between two different client keys on one page", async () => {
    harness = await arm({
      frames: [
        { sessionId: "frame-a", url: frameUrl(CLIENT_KEY) },
        { sessionId: "frame-b", url: frameUrl("test_OTHERKEY789") },
      ],
      domKey: DOM_KEY,
    });
    pause(harness.stub, "req-ambiguous", ADVANCED);
    const settled = await settle(harness.stub, "req-ambiguous");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.encryptCalls).toHaveLength(0);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toMatchObject({ reason: "adyen_client_key" });
  });

  it("rejects a malformed key from the page's config", async () => {
    harness = await arm({ domKey: "pub.v2.8115650120946270.aHR0cA" });
    pause(harness.stub, "req-badkey", ADVANCED);
    const settled = await settle(harness.stub, "req-badkey");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.encryptCalls).toHaveLength(0);
  });

  it("relays a body holding the placeholder digits as before, not through Adyen", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
    });
    pause(harness.stub, "req-held", {
      url: "https://shop.example/api/payments",
      body: {
        paymentMethod: {
          encryptedCardNumber: `test_${HELD.number}`,
        },
      },
    });
    await waitFor(() => harness!.relayCalls === 1, "relay call");
    expect(harness.encryptCalls).toHaveLength(0);
  });
});

describe("Adyen encryption gate", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.detach();
    await harness?.stub.close();
    harness = undefined;
  });

  async function expectClosed(
    id: string,
    reason: string,
    url = PAGE_ORIGIN,
  ): Promise<void> {
    const settled = await settle(harness!.stub, id);
    expect(settled.method).toBe("Fetch.failRequest");
    expect(count(harness!.stub.commands, "Fetch.continueRequest")).toBe(0);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness!.events[1]).toStrictEqual({ type: "failed", url, reason });
    assertNothingSecret(harness!);
  }

  it("off by local option: fails closed without asking the backend or reading the key", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      disableAdyenEncryption: true,
    });
    pause(harness.stub, "req-off", ADVANCED);
    await expectClosed("req-off", "adyen_not_enabled");
    expect(harness.encryptCalls).toHaveLength(0);
    expect(harness.warnings).toStrictEqual([]);
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_not_enabled" });
    expect(harness.encryptCalls).toHaveLength(0);
  });

  it("off when the relay cannot encrypt for Adyen", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: null,
    });
    pause(harness.stub, "req-norelay", ADVANCED);
    await expectClosed("req-norelay", "adyen_not_enabled");
    expect(harness.warnings).toStrictEqual([]);
  });

  it("off by the backend: its not-enabled answer fails the request closed", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: async () => NOT_ENABLED,
    });
    pause(harness.stub, "req-be-off", SESSIONS);
    await expectClosed(
      "req-be-off",
      "adyen_not_enabled",
      "https://checkoutshopper-test.adyen.com",
    );
    expect(harness.encryptCalls).toHaveLength(1);
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_not_enabled" });
  });

  it("the local option cannot force it on past the backend", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: async () => NOT_ENABLED,
      disableAdyenEncryption: false,
    });
    pause(harness.stub, "req-force", ADVANCED);
    await expectClosed("req-force", "adyen_not_enabled");
  });

  it("on: prepareAdyen asks the backend once and the payment uses those fields", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
    });
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: true });
    pause(harness.stub, "req-on", ADVANCED);
    const settled = await settle(harness.stub, "req-on");
    expect(sentBody(settled)).toStrictEqual({
      ...ADVANCED.body,
      paymentMethod: { ...ADVANCED.body.paymentMethod, ...REAL },
    });
    expect(harness.encryptCalls).toHaveLength(1);

    // Prepared fields are used once: a second payment asks again.
    pause(harness.stub, "req-again", ADVANCED);
    await settle(harness.stub, "req-again");
    expect(harness.encryptCalls).toHaveLength(2);
    assertNothingSecret(harness);
  });

  it("a later not-enabled answer drops fields an earlier prepareAdyen fetched", async () => {
    const answers = [ENCRYPTED, NOT_ENABLED, NOT_ENABLED];
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: async () => answers.shift()!,
    });
    const input = { clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN };
    await expect(harness.prepare(input)).resolves.toStrictEqual({
      enabled: true,
    });
    await expect(harness.prepare(input)).resolves.toStrictEqual({
      enabled: false,
      reason: "adyen_not_enabled",
    });
    pause(harness.stub, "req-denied", ADVANCED);
    await expectClosed("req-denied", "adyen_not_enabled");
    expect(harness.encryptCalls).toHaveLength(3);
  });

  it("an older prepareAdyen finishing last does not restore fields a newer one cleared", async () => {
    let releaseFirst: (result: AdyenEncryptResult) => void = () => {};
    const answers: Array<Promise<AdyenEncryptResult>> = [
      new Promise((resolve) => (releaseFirst = resolve)),
      Promise.resolve(NOT_ENABLED),
      Promise.resolve(NOT_ENABLED),
    ];
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: () => answers.shift()!,
    });
    const input = { clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN };
    const older = harness.prepare(input);
    await expect(harness.prepare(input)).resolves.toMatchObject({
      enabled: false,
    });
    releaseFirst(ENCRYPTED);
    await older;
    pause(harness.stub, "req-race", ADVANCED);
    await expectClosed("req-race", "adyen_not_enabled");
    expect(harness.encryptCalls).toHaveLength(3);
  });

  it("prepareAdyen after detach says not enabled without asking the backend", async () => {
    harness = await arm({});
    await harness.detach();
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_not_enabled" });
    expect(harness.encryptCalls).toHaveLength(0);
  });

  it("prepareAdyen says not enabled when detach lands while the backend answers", async () => {
    let release: (result: AdyenEncryptResult) => void = () => {};
    harness = await arm({
      encrypt: () => new Promise((resolve) => (release = resolve)),
    });
    const pending = harness.prepare({
      clientKey: CLIENT_KEY,
      pageOrigin: PAGE_ORIGIN,
    });
    await waitFor(() => harness!.encryptCalls.length === 1, "encrypt call");
    await harness.detach();
    release(ENCRYPTED);
    await expect(pending).resolves.toStrictEqual({
      enabled: false,
      reason: "adyen_not_enabled",
    });
  });

  it("prepareAdyen reports a backend failure without throwing or logging values", async () => {
    harness = await arm({
      encrypt: async () => {
        throw new RelayHttpError(500);
      },
    });
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_encrypt" });
    await expect(
      harness.prepare({ clientKey: "not-a-key", pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_encrypt" });
    expect(harness.encryptCalls).toHaveLength(1);
    assertNothingSecret(harness);
  });
});
