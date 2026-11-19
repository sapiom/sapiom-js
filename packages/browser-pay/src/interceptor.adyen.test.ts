import type {
  AdyenEncryptedFields,
  AdyenEncryptRequest,
  AdyenEncryptResult,
  AdyenResultRequest,
  AdyenResultResponse,
} from "./contract";
import type { HeldPlaceholder } from "./detect";
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
const ADYEN_TEST = "https://checkoutshopper-test.adyen.com/checkoutshopper";
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
  resultCalls: AdyenResultRequest[];
  /** What `Fetch.getResponseBody` answers, by request id. */
  responseBodies: Map<string, string>;
  relayCalls: number;
  detach(): Promise<void>;
  prepare: InterceptorHandle["prepareAdyen"];
}

async function arm(options: {
  frames?: { sessionId: string; url: string }[];
  encrypt?:
    | ((
        request: AdyenEncryptRequest,
        call?: RelayCallOptions,
      ) => Promise<AdyenEncryptResult>)
    | null;
  result?: (request: AdyenResultRequest) => Promise<AdyenResultResponse>;
  attemptTimeoutMs?: number;
  disableAdyenEncryption?: boolean;
  logger?: PayLogger;
  /** Runs while `Fetch.getResponseBody` is being answered. */
  onResponseBody?: () => void;
  /** Runs while the answer's own `Fetch.continueRequest` is being answered. */
  onAnswerContinue?: () => void;
}): Promise<Harness> {
  const responseBodies = new Map<string, string>();
  const stub = await startCdpStub((command) => {
    if (command.method === "Fetch.getResponseBody") {
      options.onResponseBody?.();
      const body = responseBodies.get(String(command.params.requestId)) ?? "";
      return {
        body: Buffer.from(body, "utf8").toString("base64"),
        base64Encoded: true,
      };
    }
    if (
      command.method === "Fetch.continueRequest" &&
      command.params.postData === undefined
    ) {
      options.onAnswerContinue?.();
    }
    if (command.method !== "Runtime.evaluate") return undefined;
    if (command.params.expression === "location.origin") {
      return { result: { type: "string", value: PAGE_ORIGIN } };
    }
    return undefined;
  });
  const events: InterceptorEvent[] = [];
  const warnings: string[] = [];
  const encryptCalls: AdyenEncryptRequest[] = [];
  const resultCalls: AdyenResultRequest[] = [];
  const harness: Harness = {
    stub,
    events,
    warnings,
    encryptCalls,
    resultCalls,
    responseBodies,
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
  const result = options.result;
  if (result) {
    relay.adyenResult = (request) => {
      resultCalls.push(request);
      return result(request);
    };
  }
  const logger: PayLogger = options.logger ?? {
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
  request: {
    url: string;
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
  },
  networkId?: string,
): void {
  stub.emit({
    method: "Fetch.requestPaused",
    sessionId: "page-1",
    params: {
      requestId,
      ...(networkId ? { networkId } : {}),
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

const SECRETS = [CLIENT_KEY, "FRAMEKEY", "STANDIN_", "REAL_", "eyJ"];

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
      const settled = await settle(harness.stub, "req-pay");

      expect(sentBody(settled)).toMatchObject({ paymentMethod: REAL });
      expect(harness.encryptCalls[0]?.clientKey).toBe(CLIENT_KEY);
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
    expect(harness.encryptCalls).toHaveLength(0);
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

  it("fails the request closed when no Adyen request named a client key", async () => {
    harness = await arm({});
    pause(harness.stub, "req-nokey", ADVANCED);
    const settled = await settle(harness.stub, "req-nokey");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.encryptCalls).toHaveLength(0);
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
    expect(
      harness.stub.commands
        .filter((command) => command.method === "Runtime.evaluate")
        .map((command) => command.params.expression),
    ).toStrictEqual(["location.origin"]);
  });

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
    expect(harness.encryptCalls).toHaveLength(0);
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toMatchObject({ reason: "adyen_client_key" });
    expect(harness.warnings).toStrictEqual([
      JSON.stringify({
        message: "two different adyen client keys seen in adyen requests",
      }),
    ]);
  });

  it("does not guess when Adyen's requests name a key other than the frame's", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
    });
    pause(harness.stub, "req-other-key", {
      url: `${ADYEN_TEST}/v1/clientKeys/test_OTHERKEY789`,
      method: "GET",
    });
    await settle(harness.stub, "req-other-key");
    pause(harness.stub, "req-ambiguous", ADVANCED);
    const settled = await settle(harness.stub, "req-ambiguous");

    expect(settled.method).toBe("Fetch.failRequest");
    expect(harness.encryptCalls).toHaveLength(0);
  });

  it("prepareAdyen answers adyen_client_key, without asking the backend, once two keys were seen", async () => {
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
    });
    pause(harness.stub, "req-other-key", {
      url: `${ADYEN_TEST}/v1/clientKeys/test_OTHERKEY789`,
      method: "GET",
    });
    await settle(harness.stub, "req-other-key");

    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_client_key" });
    expect(harness.encryptCalls).toHaveLength(0);
  });

  it("re-encrypts with a lowercase client key from the secured-field frame", async () => {
    const lowercase = "test_870be2854add4f56b86778353010f36c";
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(lowercase) }],
    });
    pause(harness.stub, "req-lower", ADVANCED);
    const settled = await settle(harness.stub, "req-lower");

    expect(sentBody(settled)).toMatchObject({ paymentMethod: REAL });
    expect(harness.encryptCalls[0]?.clientKey).toBe(lowercase);
  });

  it("does not release a paused payment when a second key appears during encryption", async () => {
    let resolveEncrypt!: (result: AdyenEncryptResult) => void;
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: () =>
        new Promise((resolve) => {
          resolveEncrypt = resolve;
        }),
    });
    pause(harness.stub, "req-race", ADVANCED);
    await waitFor(() => harness!.encryptCalls.length === 1, "encrypt call");
    harness.stub.emit({
      method: "Network.requestWillBeSent",
      sessionId: "page-1",
      params: {
        requestId: "net-late",
        request: {
          url: `${ADYEN_TEST}/v1/clientKeys/test_OTHERKEY789`,
          method: "GET",
          headers: {},
        },
      },
    });
    // Same socket, so the marker settling means the late key was recorded.
    pause(harness.stub, "req-marker", {
      url: `${PAGE_ORIGIN}/x`,
      method: "GET",
    });
    await settle(harness.stub, "req-marker");
    resolveEncrypt(ENCRYPTED);
    const settled = await settle(harness.stub, "req-race");

    expect(settled.method).toBe("Fetch.failRequest");
    await waitFor(() => harness!.events.length === 2, "two events");
    expect(harness.events[1]).toMatchObject({
      type: "failed",
      reason: "adyen_client_key",
    });
    assertNothingSecret(harness);
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

  it("a not-enabled answer for one key drops fields prepared for every other key", async () => {
    const answers = [ENCRYPTED, NOT_ENABLED, ENCRYPTED];
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: async () => answers.shift()!,
    });
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: true });
    await expect(
      harness.prepare({
        clientKey: CLIENT_KEY,
        pageOrigin: "https://other-shop.example",
      }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_not_enabled" });
    pause(harness.stub, "req-cross", ADVANCED);
    await settle(harness.stub, "req-cross");
    // The payment asked the backend again instead of spending the cached fields.
    expect(harness.encryptCalls).toHaveLength(3);
  });

  it("an older prepareAdyen succeeding after a newer denial answers not enabled", async () => {
    let releaseFirst: (result: AdyenEncryptResult) => void = () => {};
    const answers: Array<Promise<AdyenEncryptResult>> = [
      new Promise((resolve) => (releaseFirst = resolve)),
      Promise.resolve(NOT_ENABLED),
    ];
    harness = await arm({ encrypt: () => answers.shift()! });
    const older = harness.prepare({
      clientKey: CLIENT_KEY,
      pageOrigin: PAGE_ORIGIN,
    });
    await expect(
      harness.prepare({
        clientKey: CLIENT_KEY,
        pageOrigin: "https://other-shop.example",
      }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_not_enabled" });
    releaseFirst(ENCRYPTED);
    await expect(older).resolves.toStrictEqual({
      enabled: false,
      reason: "adyen_not_enabled",
    });
  });

  it("a payment whose encryption succeeds after a newer denial fails closed", async () => {
    let releasePayment: (result: AdyenEncryptResult) => void = () => {};
    const answers: Array<Promise<AdyenEncryptResult>> = [
      new Promise((resolve) => (releasePayment = resolve)),
      Promise.resolve(NOT_ENABLED),
    ];
    harness = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      encrypt: () => answers.shift()!,
    });
    pause(harness.stub, "req-pending", ADVANCED);
    await waitFor(() => harness!.encryptCalls.length === 1, "encrypt call");
    await expect(
      harness.prepare({ clientKey: CLIENT_KEY, pageOrigin: PAGE_ORIGIN }),
    ).resolves.toStrictEqual({ enabled: false, reason: "adyen_not_enabled" });
    releasePayment(ENCRYPTED);
    await expectClosed("req-pending", "adyen_not_enabled");
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

describe("Adyen's answer to a re-encrypted payment", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.detach();
    await harness?.stub.close();
    harness = undefined;
  });

  const PII = "pii-marker@example.com";
  const recorded = async (
    request: AdyenResultRequest,
  ): Promise<AdyenResultResponse> => ({
    outcome: "pending",
    resultCode: request.resultCode,
  });

  async function payAndAnswer(
    options: Parameters<typeof arm>[0],
    /** `status: null` is a request that failed before any answer. */
    answer: { body: string; status?: number | null },
    payment: { url: string; body: unknown } = ADVANCED,
  ): Promise<Harness> {
    const armed = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      ...options,
    });
    armed.responseBodies.set("req-pay", answer.body);
    pause(armed.stub, "req-pay", payment);
    await waitFor(
      () => armed.events.some((event) => event.type === "reencrypted"),
      "reencrypted",
    );
    respond(
      armed.stub,
      "req-pay",
      answer.status === null ? undefined : (answer.status ?? 200),
    );
    return armed;
  }

  function respond(stub: CdpStub, requestId: string, status?: number): void {
    stub.emit({
      method: "Fetch.requestPaused",
      sessionId: "page-1",
      params: {
        requestId,
        request: { url: ADVANCED.url, method: "POST", headers: {} },
        ...(status !== undefined
          ? {
              responseStatusCode: status,
              responseHeaders: [
                { name: "content-type", value: "application/json" },
              ],
            }
          : { responseErrorReason: "Failed" }),
      },
    });
  }

  function responseCommands(stub: CdpStub, requestId: string): CdpCommand[] {
    const continued = stub.commands.filter(
      (command) =>
        command.params.requestId === requestId &&
        command.method === "Fetch.continueRequest",
    );
    // The first continue is the re-encrypted request itself.
    return [
      ...stub.commands.filter(
        (command) =>
          command.params.requestId === requestId &&
          command.method !== "Fetch.continueRequest",
      ),
      ...continued.slice(1),
    ];
  }

  async function resultEvent(
    armed: Harness,
  ): Promise<InterceptorEvent | undefined> {
    await waitFor(
      () => armed.events.some((event) => event.type === "adyen_result"),
      "adyen_result",
    );
    return armed.events.find((event) => event.type === "adyen_result");
  }

  it("asks for the answer of that one request only", async () => {
    harness = await payAndAnswer({ result: recorded }, { body: "{}" });
    const continued = await settle(harness.stub, "req-pay");
    expect(continued.params.interceptResponse).toBe(true);
    const enable = harness.stub.commands.find(
      (command) => command.method === "Fetch.enable",
    );
    expect(enable?.params).toStrictEqual({
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  });

  it.each([
    [{ resultCode: "Authorised", pspReference: "PSP123" }, "Authorised"],
    [{ resultCode: "Refused", refusalReason: "Refused" }, "Refused"],
    [{ resultCode: "RedirectShopper", action: {} }, "RedirectShopper"],
    [{ pspReference: "PSP123" }, "unknown"],
    [{ resultCode: "authorised" }, "unknown"],
    ["<html>Bad gateway</html>", "unknown"],
  ] as const)("reports %j as %s", async (answer, resultCode) => {
    const body = typeof answer === "string" ? answer : JSON.stringify(answer);
    harness = await payAndAnswer({ result: recorded }, { body });

    expect(await resultEvent(harness)).toStrictEqual({
      type: "adyen_result",
      url: PAGE_ORIGIN,
      resultCode,
      status: 200,
      reported: true,
    });
    expect(harness.resultCalls).toStrictEqual([
      {
        injectionRef: HELD.injectionRef,
        resultCode,
        ...(typeof answer === "object" && "pspReference" in answer
          ? { pspReference: answer.pspReference }
          : {}),
      },
    ]);
  });

  it("passes the answer to the page unchanged", async () => {
    harness = await payAndAnswer(
      { result: recorded },
      { body: JSON.stringify({ resultCode: "Refused" }), status: 422 },
    );
    await resultEvent(harness);

    expect(
      responseCommands(harness.stub, "req-pay").map((command) => ({
        method: command.method,
        params: command.params,
      })),
    ).toStrictEqual([
      { method: "Fetch.getResponseBody", params: { requestId: "req-pay" } },
      { method: "Fetch.continueRequest", params: { requestId: "req-pay" } },
    ]);
    expect(harness.events.at(-1)).toMatchObject({ status: 422 });
  });

  it("reports once when the same request's answer pauses again", async () => {
    harness = await payAndAnswer(
      { result: recorded },
      { body: JSON.stringify({ resultCode: "Authorised" }) },
    );
    await resultEvent(harness);
    respond(harness.stub, "req-pay", 200);
    await waitFor(
      () => responseCommands(harness!.stub, "req-pay").length === 3,
      "second answer continued",
    );

    expect(harness.resultCalls).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === "adyen_result"),
    ).toHaveLength(1);
    expect(count(harness.stub.commands, "Fetch.getResponseBody")).toBe(1);
  });

  it("continues an answer it did not ask for and reports nothing", async () => {
    harness = await arm({ result: recorded });
    respond(harness.stub, "req-other", 200);
    const continued = await settle(harness.stub, "req-other");

    expect(continued.params).toStrictEqual({ requestId: "req-other" });
    expect(count(harness.stub.commands, "Fetch.getResponseBody")).toBe(0);
    expect(harness.resultCalls).toHaveLength(0);
    expect(harness.events).toStrictEqual([]);
  });

  it("reports nothing when the request failed before any answer", async () => {
    harness = await payAndAnswer(
      { result: recorded },
      { body: "", status: null },
    );
    await waitFor(
      () => responseCommands(harness!.stub, "req-pay").length >= 1,
      "failed answer continued",
    );

    expect(count(harness.stub.commands, "Fetch.getResponseBody")).toBe(0);
    expect(harness.resultCalls).toHaveLength(0);
  });

  async function payWithoutAnswer(): Promise<Harness> {
    const armed = await arm({
      frames: [{ sessionId: "frame-number", url: frameUrl(CLIENT_KEY) }],
      result: recorded,
    });
    armed.responseBodies.set(
      "req-pay",
      JSON.stringify({ resultCode: "Authorised" }),
    );
    pause(armed.stub, "req-pay", ADVANCED, "net-pay");
    await waitFor(
      () => armed.events.some((event) => event.type === "reencrypted"),
      "reencrypted",
    );
    return armed;
  }

  async function answerUnwatched(armed: Harness): Promise<void> {
    respond(armed.stub, "req-pay", 200);
    await waitFor(
      () => responseCommands(armed.stub, "req-pay").length >= 1,
      "answer continued",
    );
    expect(count(armed.stub.commands, "Fetch.getResponseBody")).toBe(0);
    expect(armed.resultCalls).toHaveLength(0);
    expect(armed.events.some((event) => event.type === "adyen_result")).toBe(
      false,
    );
  }

  it("forgets a payment whose loading failed without an answer", async () => {
    harness = await payWithoutAnswer();
    harness.stub.emit({
      method: "Network.loadingFailed",
      sessionId: "page-1",
      params: { requestId: "net-pay", errorText: "net::ERR_FAILED" },
    });

    await answerUnwatched(harness);
  });

  it("keeps watching when another request's loading failed", async () => {
    harness = await payWithoutAnswer();
    harness.stub.emit({
      method: "Network.loadingFailed",
      sessionId: "page-1",
      params: { requestId: "net-other", errorText: "net::ERR_FAILED" },
    });
    respond(harness.stub, "req-pay", 200);

    expect(await resultEvent(harness)).toMatchObject({
      resultCode: "Authorised",
    });
  });

  it("forgets a payment whose page detached before its answer", async () => {
    harness = await payWithoutAnswer();
    harness.stub.emit({
      method: "Target.detachedFromTarget",
      params: { sessionId: "page-1", targetId: "target-page" },
    });

    await answerUnwatched(harness);
  });

  it.each([
    [
      "refuses with a conflict",
      async (): Promise<AdyenResultResponse> => ({
        outcome: "refused",
        status: 409,
        code: "RESULT_CONFLICT",
        retryable: false,
      }),
      { status: 409, code: "RESULT_CONFLICT" },
    ],
    [
      "fails",
      async (): Promise<AdyenResultResponse> => {
        throw new RelayHttpError(500);
      },
      { status: 500, timedOut: false },
    ],
    [
      "throws with the body in its message",
      async (): Promise<AdyenResultResponse> => {
        throw new Error(`boom ${PII}`);
      },
      { timedOut: false },
    ],
  ] as const)(
    "keeps the page's answer and logs only codes when the backend %s",
    async (_label, result, logged) => {
      const body = JSON.stringify({
        resultCode: "Authorised",
        additionalData: { shopperEmail: PII },
      });
      harness = await payAndAnswer({ result }, { body });

      expect(await resultEvent(harness)).toMatchObject({
        resultCode: "Authorised",
        reported: false,
      });
      expect(
        responseCommands(harness.stub, "req-pay").at(-1)?.params,
      ).toStrictEqual({ requestId: "req-pay" });
      expect(harness.warnings).toHaveLength(1);
      expect(JSON.parse(harness.warnings[0])).toStrictEqual({
        message: expect.stringMatching(/^adyen result report /),
        fields: { resultCode: "Authorised", ...logged },
      });
      expect(JSON.stringify([harness.events, harness.warnings])).not.toContain(
        "pii-marker",
      );
    },
  );

  it("never puts the answer's body in an event or a log line", async () => {
    harness = await payAndAnswer(
      { result: recorded },
      {
        body: JSON.stringify({
          resultCode: "Refused",
          pspReference: PII,
          additionalData: { shopperEmail: PII },
        }),
      },
    );
    await resultEvent(harness);

    expect(harness.resultCalls).toStrictEqual([
      { injectionRef: HELD.injectionRef, resultCode: "Refused" },
    ]);
    expect(JSON.stringify([harness.events, harness.warnings])).not.toContain(
      "pii-marker",
    );
  });

  it.each([
    [
      "throws",
      (): void => {
        throw new Error("sink closed");
      },
    ],
    ["rejects", (): Promise<void> => Promise.reject(new Error("sink closed"))],
  ] as const)(
    "emits reported false when the logger %s",
    async (_label, warn) => {
      harness = await payAndAnswer(
        {
          result: async () => {
            throw new RelayHttpError(500);
          },
          logger: { warn },
        },
        { body: JSON.stringify({ resultCode: "Authorised" }) },
      );

      expect(await resultEvent(harness)).toMatchObject({
        resultCode: "Authorised",
        reported: false,
      });
    },
  );

  it.each(["onResponseBody", "onAnswerContinue"] as const)(
    "reports the answer before detach() returns when detach() starts in %s",
    async (hook) => {
      let detaching: Promise<void> | undefined;
      harness = await payAndAnswer(
        {
          result: recorded,
          [hook]: () => {
            detaching ??= harness!.detach();
          },
        },
        { body: JSON.stringify({ resultCode: "Authorised" }) },
      );
      await waitFor(() => detaching !== undefined, "detach started");
      await detaching;

      expect(harness.resultCalls).toStrictEqual([
        { injectionRef: HELD.injectionRef, resultCode: "Authorised" },
      ]);
      expect(
        harness.events.find((event) => event.type === "adyen_result"),
      ).toMatchObject({ resultCode: "Authorised", reported: true });
    },
  );

  describe("while the report is still with the backend", () => {
    let answerReport: () => void = () => {};

    async function payWithPendingReport(): Promise<Harness> {
      const reportHeld = new Promise<void>((resolve) => {
        answerReport = resolve;
      });
      const armed = await payAndAnswer(
        {
          result: async (request) => {
            await reportHeld;
            return recorded(request);
          },
        },
        { body: JSON.stringify({ resultCode: "Authorised" }) },
      );
      await waitFor(() => armed.resultCalls.length === 1, "report sent");
      return armed;
    }

    afterEach(() => answerReport());

    it("holds every detach() call until the report settles", async () => {
      harness = await payWithPendingReport();
      let detached = 0;
      const detaches = [harness.detach(), harness.detach()].map((call) =>
        call.then(() => {
          detached += 1;
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(detached).toBe(0);

      answerReport();
      await Promise.all(detaches);

      expect(
        harness.events.find((event) => event.type === "adyen_result"),
      ).toMatchObject({ resultCode: "Authorised", reported: true });
    });

    it("lets a tab opened during detach() run without waiting for it", async () => {
      harness = await payWithPendingReport();
      const detaching = harness.detach();
      harness.stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-2",
          waitingForDebugger: true,
          targetInfo: {
            targetId: "target-page-2",
            type: "page",
            url: `${PAGE_ORIGIN}/other`,
          },
        },
      });

      await waitFor(
        () =>
          harness!.stub.commands.some(
            (command) =>
              command.method === "Runtime.runIfWaitingForDebugger" &&
              command.sessionId === "page-2",
          ),
        "new tab resumed",
      );
      answerReport();
      await detaching;
    });
  });

  it("emits reported false when the relay cannot report", async () => {
    harness = await payAndAnswer(
      {},
      { body: JSON.stringify({ resultCode: "Authorised" }) },
    );

    expect(await resultEvent(harness)).toMatchObject({
      resultCode: "Authorised",
      reported: false,
    });
  });

  describe("after a 3-D Secure code", () => {
    const DETAILS = {
      url: `${PAGE_ORIGIN}/api/payments/details`,
      body: { details: { threeDSResult: "opaque" } },
    };

    async function challenged(): Promise<Harness> {
      const armed = await payAndAnswer(
        { result: recorded },
        {
          body: JSON.stringify({ resultCode: "ChallengeShopper", action: {} }),
        },
      );
      await resultEvent(armed);
      return armed;
    }

    function resultCodes(armed: Harness): string[] {
      return armed.resultCalls.map((call) => call.resultCode);
    }

    it("reports the final code from the details answer once", async () => {
      harness = await challenged();
      harness.responseBodies.set(
        "req-details",
        JSON.stringify({ resultCode: "Authorised", pspReference: "PSP456" }),
      );
      pause(harness.stub, "req-details", DETAILS);
      const continued = await settle(harness.stub, "req-details");
      // The page's own details body goes on unchanged; only its answer is read.
      expect(continued.params).toStrictEqual({
        requestId: "req-details",
        interceptResponse: true,
      });
      respond(harness.stub, "req-details", 200);
      await waitFor(
        () => harness!.resultCalls.length === 2,
        "final result reported",
      );
      respond(harness.stub, "req-details", 200);

      expect(harness.resultCalls.at(-1)).toStrictEqual({
        injectionRef: HELD.injectionRef,
        resultCode: "Authorised",
        pspReference: "PSP456",
      });
      expect(resultCodes(harness)).toStrictEqual([
        "ChallengeShopper",
        "Authorised",
      ]);
      expect(
        harness.events
          .filter((event) => event.type === "adyen_result")
          .map((event) => "resultCode" in event && event.resultCode),
      ).toStrictEqual(["ChallengeShopper", "Authorised"]);
    });

    it("watches details that pause before the 3-D Secure answer's continue returns", async () => {
      let detailsSent = false;
      harness = await payAndAnswer(
        {
          result: recorded,
          onAnswerContinue: () => {
            if (detailsSent) return;
            detailsSent = true;
            pause(harness!.stub, "req-details", DETAILS);
          },
        },
        {
          body: JSON.stringify({ resultCode: "ChallengeShopper", action: {} }),
        },
      );

      expect(
        (await settle(harness.stub, "req-details")).params.interceptResponse,
      ).toBe(true);
    });

    it("keeps watching through a second 3-D Secure code", async () => {
      harness = await challenged();
      harness.responseBodies.set(
        "req-details",
        JSON.stringify({ resultCode: "IdentifyShopper", action: {} }),
      );
      harness.responseBodies.set(
        "req-details-2",
        JSON.stringify({ resultCode: "Refused" }),
      );
      pause(harness.stub, "req-details", DETAILS);
      await settle(harness.stub, "req-details");
      respond(harness.stub, "req-details", 200);
      await waitFor(() => harness!.resultCalls.length === 2, "second code");
      pause(harness.stub, "req-details-2", DETAILS);
      expect(
        (await settle(harness.stub, "req-details-2")).params.interceptResponse,
      ).toBe(true);
      respond(harness.stub, "req-details-2", 200);
      await waitFor(() => harness!.resultCalls.length === 3, "final code");

      expect(resultCodes(harness)).toStrictEqual([
        "ChallengeShopper",
        "IdentifyShopper",
        "Refused",
      ]);
    });

    it.each([
      [
        "an error",
        422,
        JSON.stringify({ status: 422, errorCode: "14_0", message: "x" }),
      ],
      ["a non-JSON", 502, "<html>Bad gateway</html>"],
    ])(
      "keeps watching after %s details answer, so a retry is reported",
      async (_label, status, body) => {
        harness = await challenged();
        harness.responseBodies.set("req-details", body);
        harness.responseBodies.set(
          "req-details-2",
          JSON.stringify({ resultCode: "Authorised" }),
        );
        pause(harness.stub, "req-details", DETAILS);
        await settle(harness.stub, "req-details");
        respond(harness.stub, "req-details", status);
        await waitFor(() => harness!.resultCalls.length === 2, "unknown code");
        pause(harness.stub, "req-details-2", DETAILS);
        expect(
          (await settle(harness.stub, "req-details-2")).params
            .interceptResponse,
        ).toBe(true);
        respond(harness.stub, "req-details-2", 200);
        await waitFor(() => harness!.resultCalls.length === 3, "final code");

        expect(resultCodes(harness)).toStrictEqual([
          "ChallengeShopper",
          "unknown",
          "Authorised",
        ]);
      },
    );

    it("reports no final result when no details answer comes", async () => {
      harness = await challenged();

      expect(resultCodes(harness)).toStrictEqual(["ChallengeShopper"]);
    });

    it("does not watch details on another origin", async () => {
      harness = await challenged();
      pause(harness.stub, "req-elsewhere", {
        ...DETAILS,
        url: "https://other.example/api/payments/details",
      });

      expect(
        (await settle(harness.stub, "req-elsewhere")).params,
      ).toStrictEqual({ requestId: "req-elsewhere" });
    });

    it("does not watch details from another tab on the same origin", async () => {
      harness = await challenged();
      harness.stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-2",
          waitingForDebugger: false,
          targetInfo: {
            targetId: "target-page-2",
            type: "page",
            url: `${PAGE_ORIGIN}/checkout`,
          },
        },
      });
      await waitFor(
        () => count(harness!.stub.commands, "Fetch.enable") === 3,
        "Fetch.enable on the second tab",
      );
      harness.stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-2",
        params: {
          requestId: "req-other-tab",
          request: {
            url: DETAILS.url,
            method: "POST",
            headers: { "content-type": "application/json" },
            postData: JSON.stringify(DETAILS.body),
            hasPostData: true,
          },
        },
      });

      expect(
        (await settle(harness.stub, "req-other-tab")).params,
      ).toStrictEqual({ requestId: "req-other-tab" });
    });

    it("watches only its own Adyen session's details", async () => {
      harness = await payAndAnswer(
        { result: recorded },
        {
          body: JSON.stringify({ resultCode: "ChallengeShopper", action: {} }),
        },
        SESSIONS,
      );
      await resultEvent(harness);
      const details = (id: string) => ({
        url: `https://checkoutshopper-test.adyen.com/checkoutshopper/v1/sessions/${id}/paymentDetails?clientKey=${CLIENT_KEY}`,
        body: { sessionData: "Ab02b4c0!session", details: {} },
      });
      pause(harness.stub, "req-other-session", details("CS999"));
      pause(harness.stub, "req-own-session", details("CS123"));

      expect(
        (await settle(harness.stub, "req-other-session")).params,
      ).toStrictEqual({ requestId: "req-other-session" });
      expect(
        (await settle(harness.stub, "req-own-session")).params
          .interceptResponse,
      ).toBe(true);
    });

    it("watches a merchant's details under its own /sessions/{id}/ route", async () => {
      const route = `${PAGE_ORIGIN}/api/sessions/cart-123/payments`;
      harness = await payAndAnswer(
        { result: recorded },
        {
          body: JSON.stringify({ resultCode: "ChallengeShopper", action: {} }),
        },
        { ...ADVANCED, url: route },
      );
      await resultEvent(harness);
      pause(harness.stub, "req-details", {
        ...DETAILS,
        url: `${route}/details`,
      });

      expect(
        (await settle(harness.stub, "req-details")).params.interceptResponse,
      ).toBe(true);
    });

    it("reports one final code when two details answers are outstanding", async () => {
      harness = await challenged();
      for (const id of ["req-details", "req-details-2"]) {
        harness.responseBodies.set(
          id,
          JSON.stringify({ resultCode: "Authorised" }),
        );
        pause(harness.stub, id, DETAILS);
        await settle(harness.stub, id);
      }
      for (const id of ["req-details", "req-details-2"]) {
        respond(harness.stub, id, 200);
      }
      await waitFor(
        () =>
          ["req-details", "req-details-2"].every(
            (id) => responseCommands(harness!.stub, id).length === 2,
          ),
        "both answers handed to the page",
      );
      // detach() waits for every answer already paused to be reported.
      await harness.detach();

      expect(resultCodes(harness)).toStrictEqual([
        "ChallengeShopper",
        "Authorised",
      ]);
    });

    it("does not watch details that start after detach()", async () => {
      let answerReport: () => void = () => {};
      const reportHeld = new Promise<void>((resolve) => {
        answerReport = resolve;
      });
      let detaching: Promise<void> | undefined;
      harness = await payAndAnswer(
        {
          result: async (request) => {
            await reportHeld;
            return recorded(request);
          },
          onResponseBody: () => {
            detaching ??= harness!.detach();
          },
        },
        {
          body: JSON.stringify({ resultCode: "ChallengeShopper", action: {} }),
        },
      );
      await waitFor(() => harness!.resultCalls.length === 1, "report sent");
      pause(harness.stub, "req-details", DETAILS);
      const continued = (await settle(harness.stub, "req-details")).params;
      answerReport();
      await detaching;

      expect(continued).toStrictEqual({ requestId: "req-details" });
      expect(resultCodes(harness)).toStrictEqual(["ChallengeShopper"]);
    });

    it.each([
      ["after the 3-D Secure answer", false],
      ["while the 3-D Secure answer is read", true],
    ])("forgets a tab closed %s", async (_label, duringRead) => {
      const close = (): void => {
        harness!.stub.emit({
          method: "Target.detachedFromTarget",
          params: { sessionId: "page-1" },
        });
      };
      let closed = false;
      harness = await payAndAnswer(
        {
          result: recorded,
          onResponseBody: () => {
            if (!duringRead || closed) return;
            closed = true;
            close();
          },
        },
        {
          body: JSON.stringify({ resultCode: "ChallengeShopper", action: {} }),
        },
      );
      await resultEvent(harness);
      if (!duringRead) close();
      // A later tab given the same session id must start with no watch.
      harness.stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-1",
          waitingForDebugger: false,
          targetInfo: {
            targetId: "target-page-3",
            type: "page",
            url: `${PAGE_ORIGIN}/checkout`,
          },
        },
      });
      await waitFor(
        () => count(harness!.stub.commands, "Fetch.enable") === 3,
        "Fetch.enable on the new tab",
      );
      pause(harness.stub, "req-details", DETAILS);

      expect((await settle(harness.stub, "req-details")).params).toStrictEqual({
        requestId: "req-details",
      });
    });

    it.each(["Authorised", "Refused"])(
      "does not watch details after a final %s on /payments",
      async (resultCode) => {
        harness = await payAndAnswer(
          { result: recorded },
          { body: JSON.stringify({ resultCode }) },
        );
        await resultEvent(harness);
        pause(harness.stub, "req-details", DETAILS);

        expect(
          (await settle(harness.stub, "req-details")).params,
        ).toStrictEqual({ requestId: "req-details" });
        expect(resultCodes(harness)).toStrictEqual([resultCode]);
      },
    );
  });
});
