import crypto from "node:crypto";
import type {
  VerificationAdapter,
  VerificationState,
} from "./verification-types";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CdpCommandError } from "./cdp";
import {
  attachInterceptor,
  type InterceptorEvent,
  type InterceptorTarget,
} from "./interceptor";
import {
  createStripePaymentElementVerification,
  type HeldPlaceholder,
  type RelayRequest,
  type RelayResponse,
} from "./index";
import { stubPaymentRelay } from "../test/stub-relay";
import { httpPaymentRelay, type RelayCallOptions } from "./relay";

const HELD: HeldPlaceholder = {
  number: "4242424242424242",
  injectionRef: "inj_protocol",
};

const CARD = JSON.stringify({
  credit_card: {
    number: HELD.number,
    month: 12,
    year: 2028,
    verification_value: "123",
  },
});

interface Command {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const REMOTE_STEP = "REMOTE_STEP_TEXT";

interface StubOptions {
  frameTree?: unknown;
  responseBody?: string;
  failAutoAttach?: boolean;
  failChildAutoAttach?: boolean;
  failResume?: boolean;
  failAttachToTarget?: boolean;
  failCloseTarget?: boolean;
  failFetch?: boolean;
  fetchErrorCode?: number;
  fetchErrorMessage?: string;
  failFulfill?: boolean;
  holdFulfill?: boolean;
  postData?: string;
  postDataError?: boolean;
  targets?: { targetId: string; type: string; url: string }[];
  attachedSessionId?: string;
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function startStub(options: StubOptions = {}): Promise<{
  url: string;
  commands: Command[];
  sawClose: () => boolean;
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}> {
  const commands: Command[] = [];
  let socket: Duplex | undefined;
  let sawClose = false;
  const chunks: Buffer[] = [];
  let buffered = 0;

  const reply = (
    id: number,
    result: unknown,
    error?: { message: string; code?: number },
  ) => {
    const message = error ? { id, error } : { id, result };
    socket?.write(serverFrame(JSON.stringify(message)));
  };

  const consume = (length: number): Buffer | null => {
    if (buffered < length) return null;
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const head = chunks[0];
      const need = length - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        chunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    buffered -= length;
    return out;
  };

  const peek = (length: number): Buffer | null => {
    if (buffered < length) return null;
    if (chunks[0] && chunks[0].length >= length)
      return chunks[0].subarray(0, length);
    const out = Buffer.allocUnsafe(length);
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, length - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (offset >= length) break;
    }
    return out;
  };

  const onMessage = (text: string) => {
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (!message.id || !message.method) return;
    commands.push({
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    });
    if (message.method === "Target.setAutoAttach" && options.failAutoAttach) {
      reply(message.id, undefined, { message: "auto-attach refused" });
      return;
    }
    if (
      message.method === "Target.setAutoAttach" &&
      message.sessionId &&
      options.failChildAutoAttach
    ) {
      reply(message.id, undefined, { message: REMOTE_STEP, code: -32000 });
      return;
    }
    if (
      message.method === "Runtime.runIfWaitingForDebugger" &&
      options.failResume
    ) {
      reply(message.id, undefined, { message: REMOTE_STEP, code: -32000 });
      return;
    }
    if (message.method === "Target.closeTarget" && options.failCloseTarget) {
      reply(message.id, undefined, { message: REMOTE_STEP, code: -32000 });
      return;
    }
    if (message.method === "Fetch.enable" && options.failFetch) {
      reply(message.id, undefined, {
        message: options.fetchErrorMessage ?? "Fetch is unsupported",
        ...(options.fetchErrorCode !== undefined
          ? { code: options.fetchErrorCode }
          : {}),
      });
      return;
    }
    if (message.method === "Target.getTargets") {
      reply(message.id, { targetInfos: options.targets ?? [] });
      return;
    }
    if (message.method === "Target.attachToTarget") {
      if (options.failAttachToTarget) {
        reply(message.id, undefined, { message: REMOTE_STEP, code: -32000 });
        return;
      }
      reply(message.id, {
        sessionId: options.attachedSessionId ?? "iframe-existing",
      });
      return;
    }
    if (message.method === "Runtime.evaluate") {
      reply(message.id, {});
      return;
    }
    if (message.method === "Page.getFrameTree" && options.frameTree) {
      reply(message.id, { frameTree: options.frameTree });
      return;
    }
    if (message.method === "Network.getResponseBody") {
      reply(message.id, {
        body: options.responseBody ?? "",
        base64Encoded: false,
      });
      return;
    }
    if (message.method === "Network.getRequestPostData") {
      if (options.postDataError) {
        reply(message.id, undefined, { message: "no body" });
        return;
      }
      reply(message.id, { postData: options.postData ?? "" });
      return;
    }
    if (message.method === "Fetch.fulfillRequest" && options.failFulfill) {
      reply(message.id, undefined, { message: "request is gone" });
      return;
    }
    if (message.method === "Fetch.fulfillRequest" && options.holdFulfill) {
      return;
    }
    reply(message.id, {});
  };

  const parse = () => {
    for (;;) {
      const header = peek(2);
      if (!header) return;
      const second = header[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        const extended = peek(4);
        if (!extended) return;
        length = extended.readUInt16BE(2);
        offset = 4;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      const frame = consume(offset + length);
      if (!frame) return;
      let payload = frame.subarray(offset);
      if (masked) {
        const mask = frame.subarray(maskOffset, maskOffset + 4);
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index++) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }
      if ((header[0] & 0x0f) === 0x8) {
        sawClose = true;
        return;
      }
      if ((header[0] & 0x0f) !== 0x1) continue;
      onMessage(payload.toString("utf8"));
    }
  };

  const server = http.createServer();
  server.on("upgrade", (request, upgraded, head) => {
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    upgraded.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket = upgraded;
    if (head?.length) {
      chunks.push(Buffer.from(head));
      buffered += head.length;
    }
    upgraded.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      buffered += chunk.length;
      parse();
    });
  });

  await awaitListen(server);
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    commands,
    sawClose: () => sawClose,
    emit(event) {
      socket?.write(serverFrame(JSON.stringify(event)));
    },
    close() {
      socket?.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function awaitListen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function multipartPause(
  requestId: string,
  networkId: string,
): Record<string, unknown> {
  return {
    method: "Fetch.requestPaused",
    sessionId: "page-1",
    params: {
      requestId,
      networkId,
      request: {
        url: "https://checkout.example/sessions",
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        hasPostData: true,
      },
    },
  };
}

function attachPage(
  emit: (event: Record<string, unknown>) => void,
  sessionId = "page-1",
) {
  emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId,
      waitingForDebugger: true,
      targetInfo: {
        targetId: "target-page",
        type: "page",
        url: "https://shop.example/checkout",
      },
    },
  });
}

const success = (): RelayResponse => ({
  outcome: "relayed",
  response: {
    status: 201,
    headers: { "content-type": "application/json" },
    body: '{"id":"sess"}',
  },
});

function header(
  headers: RelayRequest["request"]["headers"],
  name: string,
): string | undefined {
  return headers[name.toLowerCase()];
}

type StepWarning = {
  message: string;
  fields?: Readonly<Record<string, string | number | boolean>>;
};

function stepLogger(warnings: StepWarning[]) {
  return {
    warn(
      message: string,
      fields?: Readonly<Record<string, string | number | boolean>>,
    ) {
      warnings.push(fields ? { message, fields } : { message });
    },
  };
}

describe("interceptor CDP decisions", () => {
  it.each(["capture", "invisible-auth-failure"])(
    "wires the explicit Stripe factory through attach and original CDP traffic: %s",
    async (scenario) => {
      const confirmUrl =
        "https://api.stripe.com/v1/payment_intents/pi_demo/confirm";
      const stub = await startStub({
        frameTree: {
          frame: { id: "checkout", url: "https://shop.example/checkout" },
          childFrames: [
            {
              frame: {
                id: "auth",
                url: "https://js.stripe.com/v3/three-ds-2-challenge-abc123.html",
              },
              childFrames: [{ frame: { id: "acs", url: "about:blank" } }],
            },
          ],
        },
        responseBody: JSON.stringify(
          scenario === "capture"
            ? {
                id: "pi_demo",
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
              }
            : { error: { code: "payment_intent_authentication_failure" } },
        ),
      });
      let state: VerificationState = {
        id: "verification",
        version: 1,
        status: "preparing",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        merchantOrigin: "https://shop.example",
        total: { amount: "11.00", currency: "USD" },
        challengeCaptured: false,
        launchClaimed: false,
        checkRequested: false,
        continuationClaimed: false,
      };
      const relay = jest.fn(async () => ({
        ...success(),
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"id":"pm_demo"}',
        },
      }));
      const reports: Record<string, unknown>[] = [];
      const handle = await attachInterceptor(stub.url, {
        placeholder: HELD,
        verificationAdapter: createStripePaymentElementVerification,
        relay: stubPaymentRelay(relay),
        verification: {
          initial: state,
          runner: {
            sync: async () => state,
            report: async (_id, report) => {
              reports.push(report);
              state = {
                ...state,
                version: state.version + 1,
                ...(report.kind === "challenge_observed"
                  ? {
                      status: "requires_action" as const,
                      challengeCaptured: true,
                    }
                  : report.kind === "checkout_observed"
                    ? {
                        status: "ended" as const,
                        observation: {
                          outcome: "failed" as const,
                          source: "runner" as const,
                        },
                      }
                    : {}),
              };
              return state;
            },
          },
        },
      });
      try {
        expect(handle.verification).toBeDefined();
        attachPage(stub.emit);
        await waitFor(
          () => stub.commands.some((c) => c.method === "Fetch.enable"),
          "Fetch enabled",
        );
        const pause = (
          requestId: string,
          url: string,
          body: string,
          frameId = "checkout",
        ) =>
          stub.emit({
            method: "Fetch.requestPaused",
            sessionId: "page-1",
            params: {
              requestId,
              frameId,
              networkId: requestId,
              request: {
                url,
                method: "POST",
                postData: body,
                headers: { "content-type": "application/json" },
              },
            },
          });
        pause("card", "https://api.stripe.com/v1/payment_methods", CARD);
        await waitFor(
          () =>
            stub.commands.some(
              (c) =>
                c.method === "Fetch.fulfillRequest" &&
                c.params.requestId === "card",
            ),
          "card relayed",
        );
        pause("confirm", confirmUrl, "payment_method=pm_demo");
        await waitFor(
          () =>
            stub.commands.some(
              (c) =>
                c.method === "Fetch.continueRequest" &&
                c.params.requestId === "confirm",
            ),
          "original Confirm continued",
        );
        stub.emit({
          method: "Network.responseReceived",
          sessionId: "page-1",
          params: {
            requestId: "confirm",
            response: { url: confirmUrl, mimeType: "application/json" },
          },
        });
        stub.emit({
          method: "Network.loadingFinished",
          sessionId: "page-1",
          params: { requestId: "confirm", encodedDataLength: 500 },
        });
        await waitFor(
          () =>
            stub.commands.some((c) => c.method === "Network.getResponseBody"),
          "original response observed",
        );
        if (scenario === "capture") {
          const body =
            "creq=" +
            Buffer.from(
              JSON.stringify({
                acsTransID: "11111111-1111-4111-8111-111111111111",
                threeDSServerTransID: "22222222-2222-4222-8222-222222222222",
                messageType: "CReq",
                messageVersion: "2.2.0",
                challengeWindowSize: "05",
              }),
            ).toString("base64url");
          pause("challenge", "https://bank.example/challenge", body, "acs");
          await waitFor(
            () =>
              stub.commands.some(
                (c) =>
                  c.method === "Fetch.fulfillRequest" &&
                  c.params.requestId === "challenge",
              ),
            "challenge captured",
          );
          expect(reports).toContainEqual(
            expect.objectContaining({
              kind: "challenge_observed",
              capture: {
                url: "https://bank.example/challenge",
                body,
                nativeReturn: "stripe_3ds2",
              },
            }),
          );
          pause("duplicate", confirmUrl, "payment_method=pm_demo");
          await waitFor(
            () =>
              stub.commands.some(
                (c) =>
                  c.method === "Fetch.failRequest" &&
                  c.params.requestId === "duplicate",
              ),
            "duplicate Confirm fenced",
          );
        } else {
          expect((await handle.verification!.wait()).observation).toEqual({
            outcome: "failed",
            source: "runner",
          });
          expect(reports).toContainEqual(
            expect.objectContaining({
              kind: "checkout_observed",
              observation: {
                outcome: "failed",
                cardSession: "pm_demo",
                amount: "11.00",
                currency: "USD",
              },
            }),
          );
        }
        expect(relay).toHaveBeenCalledTimes(1);
        expect(
          stub.commands.some((c) => c.method === "Runtime.callFunctionOn"),
        ).toBe(false);
      } finally {
        await handle.detach();
        await stub.close();
      }
    },
  );

  it("closes the CDP connection when start fails", async () => {
    const stub = await startStub({ failAutoAttach: true });
    try {
      const caught = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(CdpCommandError);
      expect(caught).toMatchObject({
        method: "Target.setAutoAttach",
        message: "CDP command failed: Target.setAutoAttach",
      });
      expect(
        JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)),
      ).not.toContain("auto-attach refused");
      await waitFor(() => stub.sawClose(), "websocket close");
    } finally {
      await stub.close();
    }
  });

  it("logs a nested setAutoAttach failure and still arms Fetch", async () => {
    const stub = await startStub({ failChildAutoAttach: true });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      expect(events).toEqual([]);
      expect(stub.commands.map((command) => command.method)).not.toContain(
        "Target.closeTarget",
      );
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Target.setAutoAttach",
            code: -32000,
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      expect(JSON.stringify(warnings)).not.toContain(REMOTE_STEP);
      expect(JSON.stringify(warnings)).not.toContain("checkout");
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("a throwing logger leaves a nested setAutoAttach failure unchanged", async () => {
    const options: StubOptions = {
      failChildAutoAttach: true,
      targets: [
        {
          targetId: "target-card",
          type: "iframe",
          url: "https://checkout.pci.shopifyinc.com/sessions",
        },
      ],
      attachedSessionId: "iframe-card",
    };
    const run = async (logger?: {
      warn(message: string): void;
    }): Promise<{ events: InterceptorEvent[]; commands: Command[] }> => {
      const stub = await startStub(options);
      const events: InterceptorEvent[] = [];
      try {
        const handle = await attachInterceptor(stub.url, {
          relay: stubPaymentRelay(async () => success()),
          placeholder: HELD,
          profileId: "shopify-card-vault",
          ...(logger ? { logger } : {}),
        });
        handle.on((event) => events.push(event));
        await handle.detach();
        return { events: [...events], commands: [...stub.commands] };
      } finally {
        await stub.close();
      }
    };
    const silent = await run();
    let warned = 0;
    const throwing = await run({
      warn() {
        warned += 1;
        throw new Error("logger boom");
      },
    });
    expect(warned).toBeGreaterThan(0);
    expect(silent.commands.map((command) => command.method)).toContain(
      "Fetch.enable",
    );
    expect(throwing.events).toEqual(silent.events);
    expect(throwing.commands).toEqual(silent.commands);
  });

  it("logs a resume failure and still leaves the target armed", async () => {
    const stub = await startStub({ failResume: true });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(() => warnings.length === 1, "resume warning");
      expect(events).toEqual([]);
      expect(stub.commands.map((command) => command.method)).toContain(
        "Fetch.enable",
      );
      expect(stub.commands.map((command) => command.method)).not.toContain(
        "Target.closeTarget",
      );
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Runtime.runIfWaitingForDebugger",
            code: -32000,
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      expect(JSON.stringify(warnings)).not.toContain(REMOTE_STEP);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("logs an attachToTarget failure and leaves that iframe unarmed", async () => {
    const stub = await startStub({
      failAttachToTarget: true,
      targets: [
        {
          targetId: "target-card",
          type: "iframe",
          url: "https://checkout.pci.shopifyinc.com/sessions?card=1",
        },
      ],
    });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      expect(events).toEqual([]);
      expect(stub.commands.map((command) => command.method)).not.toContain(
        "Fetch.enable",
      );
      expect(stub.commands.map((command) => command.method)).not.toContain(
        "Target.closeTarget",
      );
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Target.attachToTarget",
            code: -32000,
            timedOut: false,
            targetType: "iframe",
            origin: "https://checkout.pci.shopifyinc.com",
          },
        },
      ]);
      expect(JSON.stringify(warnings)).not.toContain(REMOTE_STEP);
      expect(JSON.stringify(warnings)).not.toContain("sessions");
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("logs a closeTarget failure and still emits intercept_unavailable", async () => {
    const stub = await startStub({ failFetch: true, failCloseTarget: true });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(() => warnings.length === 2, "close warning");
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://shop.example",
          reason: "intercept_unavailable",
        },
      ]);
      expect(stub.commands).toContainEqual(
        expect.objectContaining({
          method: "Target.closeTarget",
          params: { targetId: "target-page" },
        }),
      );
      expect(stub.commands.map((command) => command.method)).not.toContain(
        "Runtime.runIfWaitingForDebugger",
      );
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Fetch.enable",
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
        {
          message: "browser step failed",
          fields: {
            method: "Target.closeTarget",
            code: -32000,
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      expect(JSON.stringify(warnings)).not.toContain(REMOTE_STEP);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not resume a target whose Fetch.enable failed", async () => {
    const stub = await startStub({ failFetch: true });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Target.closeTarget",
          ),
        "closeTarget",
      );
      expect(stub.commands.map((command) => command.method)).not.toContain(
        "Runtime.runIfWaitingForDebugger",
      );
      expect(stub.commands).toContainEqual(
        expect.objectContaining({
          method: "Target.closeTarget",
          params: { targetId: "target-page" },
        }),
      );
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://shop.example",
          reason: "intercept_unavailable",
        },
      ]);
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Fetch.enable",
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("reports the CDP code when Fetch.enable fails and still closes the target", async () => {
    const remote = "REMOTE_CDP_TEXT_SHOULD_NOT_LEAK";
    const stub = await startStub({
      failFetch: true,
      fetchErrorCode: -32000,
      fetchErrorMessage: remote,
    });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-1",
          waitingForDebugger: true,
          targetInfo: {
            targetId: "target-page",
            type: "page",
            url: "https://shop.example/checkout?q=1#frag",
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Target.closeTarget",
          ),
        "closeTarget",
      );
      expect(stub.commands).toContainEqual(
        expect.objectContaining({
          method: "Target.closeTarget",
          params: { targetId: "target-page" },
        }),
      );
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://shop.example",
          reason: "intercept_unavailable",
        },
      ]);
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Fetch.enable",
            code: -32000,
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(remote);
      expect(JSON.stringify(warnings)).not.toContain(remote);
      expect(JSON.stringify(warnings)).not.toContain("checkout");
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("omits code when Fetch.enable returns a non-integer CDP code", async () => {
    const stub = await startStub({ failFetch: true, fetchErrorCode: 1.5 });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "non-integer code",
      );
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://shop.example",
          reason: "intercept_unavailable",
        },
      ]);
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Fetch.enable",
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("logs about: for an about:blank target that cannot arm Fetch", async () => {
    const stub = await startStub({ failFetch: true });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "blank-1",
          waitingForDebugger: true,
          targetInfo: {
            targetId: "target-blank",
            type: "iframe",
            url: "about:blank",
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "about blank",
      );
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "about:",
          reason: "intercept_unavailable",
        },
      ]);
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Fetch.enable",
            timedOut: false,
            targetType: "iframe",
            origin: "about:",
          },
        },
      ]);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("a throwing logger does not change a Fetch.enable failure", async () => {
    const run = async (logger?: {
      warn(message: string): void;
    }): Promise<{ events: InterceptorEvent[]; commands: Command[] }> => {
      const stub = await startStub({ failFetch: true });
      const events: InterceptorEvent[] = [];
      try {
        const handle = await attachInterceptor(stub.url, {
          relay: stubPaymentRelay(async () => success()),
          placeholder: HELD,
          profileId: "shopify-card-vault",
          ...(logger ? { logger } : {}),
        });
        handle.on((event) => events.push(event));
        attachPage(stub.emit);
        await waitFor(
          () =>
            stub.commands.some(
              (command) => command.method === "Target.closeTarget",
            ),
          "closeTarget",
        );
        await handle.detach();
        return { events: [...events], commands: [...stub.commands] };
      } finally {
        await stub.close();
      }
    };
    const silent = await run();
    let warned = 0;
    const throwing = await run({
      warn() {
        warned += 1;
        throw new Error("logger boom");
      },
    });
    expect(warned).toBeGreaterThan(0);
    expect(silent.events).toStrictEqual([
      {
        type: "failed",
        url: "https://shop.example",
        reason: "intercept_unavailable",
      },
    ]);
    expect(throwing.events).toStrictEqual(silent.events);
    expect(throwing.commands).toEqual(silent.commands);
    expect(throwing.commands).toContainEqual(
      expect.objectContaining({
        method: "Target.closeTarget",
        params: { targetId: "target-page" },
      }),
    );
  });

  it("swallows a rejected async logger and still closes the target", async () => {
    const stub = await startStub({ failFetch: true });
    const events: InterceptorEvent[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: {
          async warn() {
            throw new Error("ASYNC_LOGGER_REJECTION");
          },
        },
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Target.closeTarget",
          ),
        "closeTarget",
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://shop.example",
          reason: "intercept_unavailable",
        },
      ]);
      expect(stub.commands).toContainEqual(
        expect.objectContaining({
          method: "Target.closeTarget",
          params: { targetId: "target-page" },
        }),
      );
      await handle.detach();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await stub.close();
    }
  });

  it("logs Fetch.enable before a failed handler detaches", async () => {
    const stub = await startStub({ failFetch: true });
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger: stepLogger(warnings),
      });
      handle.on((event) => {
        events.push(event);
        if (event.type === "failed") void handle.detach();
      });
      attachPage(stub.emit);
      await waitFor(() => warnings.length === 1, "Fetch.enable warning");
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://shop.example",
          reason: "intercept_unavailable",
        },
      ]);
      expect(warnings).toStrictEqual([
        {
          message: "browser step failed",
          fields: {
            method: "Fetch.enable",
            timedOut: false,
            targetType: "page",
            origin: "https://shop.example",
          },
        },
      ]);
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Target.closeTarget",
          ),
        "closeTarget",
      );
    } finally {
      await stub.close();
    }
  });

  it("relays to any checkout without a profile, forwarding cookies but excluding connection headers and fetch hints", async () => {
    const stub = await startStub({ postData: CARD });
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    const warnings: StepWarning[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: httpPaymentRelay({
          baseUrl: "https://api.sapiom.ai",
          apiKey: "test-key",
          transactionId: "tx_cookie_fixture",
          fetchImpl: async (url, init) => {
            expect(url).toBe(
              "https://api.sapiom.ai/v1/transactions/tx_cookie_fixture/payment/relay",
            );
            expect(init?.method).toBe("POST");
            expect(new Headers(init?.headers).has("cookie")).toBe(false);
            calls.push(JSON.parse(String(init?.body)) as RelayRequest);
            return new Response(JSON.stringify(success()), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        }),
        placeholder: HELD,
        logger: stepLogger(warnings),
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      const many = Object.fromEntries(
        Array.from({ length: 27 }, (_, i) => [`x-extra-${i}`, "1"]),
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-1",
          networkId: "net-1",
          request: {
            url: "https://api.pay.example/v1/tokens",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer pk_test_example",
              Cookie: "session=secret",
              Host: "api.pay.example",
              "Sec-Fetch-Site": "cross-site",
              "sec-ch-ua": '"Chromium"',
              ...many,
              // Names an object inherits: kept, and counted like any other.
              ["__proto__"]: "proto-example",
              constructor: "constructor-example",
            },
            hasPostData: true,
            postDataEntries: [{}],
          },
          resourceType: "Fetch",
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "relayed",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toHaveProperty("profileId");
      expect(calls[0].request.url).toBe("https://api.pay.example/v1/tokens");
      const headers = calls[0].request.headers;
      expect(header(headers, "content-type")).toBe("application/json");
      expect(header(headers, "authorization")).toBe("Bearer pk_test_example");
      expect(header(headers, "cookie")).toBe("session=secret");
      for (const dropped of ["host", "sec-fetch-site", "sec-ch-ua"]) {
        expect(headers).not.toHaveProperty(dropped);
      }
      expect(Object.keys(headers)).toContain("__proto__");
      expect(header(headers, "__proto__")).toBe("proto-example");
      expect(header(headers, "constructor")).toBe("constructor-example");
      expect(Object.keys(headers)).toHaveLength(32);
      await handle.detach();
      expect(
        JSON.stringify({ events, warnings, commands: stub.commands }),
      ).not.toContain("session=secret");
    } finally {
      await stub.close();
    }
  });

  it.each([
    {
      name: "keeps an empty cookie unchanged",
      cookie: "",
      expected: "",
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "keeps a fitting cookie unchanged",
      cookie: "_ga=analytics;  session_id=abc; _fbp=tracking",
      expected: "_ga=analytics;  session_id=abc; _fbp=tracking",
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "keeps a cookie exactly at the value limit",
      cookie: `session_id=${"x".repeat(8181)}`,
      expected: `session_id=${"x".repeat(8181)}`,
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "drops only explicit analytics names and prefixes from an oversized cookie",
      cookie: [
        "_ga",
        "_gid",
        "_gat",
        "_ga_ABC123",
        "_gat_UA-1",
        "_gcl_fixture",
        "_fbp",
        "_fbc",
        "_hjfixture",
        "_clck",
        "_clsk",
        "_uetfixture",
        "ajs_fixture",
        "amplitudefixture",
        "amp_fixture",
        "mp_fixture",
        "_tt_fixture",
        "_ttp",
        "_pin_fixture",
      ]
        .map((name) => `${name}=${"x".repeat(600)}`)
        .concat(
          "session_id=abc",
          "custom=_ga",
          "ga_session=keep",
          "_gateway_session=keep",
          "_gid_session=keep",
          "_fbp_session=keep",
        )
        .join("; "),
      expected:
        "session_id=abc; custom=_ga; ga_session=keep; _gateway_session=keep; _gid_session=keep; _fbp_session=keep",
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "drops empty pairs while trimming an oversized cookie",
      cookie: ` ; _ga=${"x".repeat(8192)}; ; session_id=abc; ; `,
      expected: "session_id=abc",
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "omits a trimmed cookie containing only empty pairs",
      cookie: ` ; _ga=${"x".repeat(8192)}; ; `,
      expected: undefined,
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "omits a cookie still oversized after analytics removal",
      cookie: `_ga=analytics; session_id=${"x".repeat(8192)}`,
      expected: undefined,
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "omits an oversized cookie without analytics",
      cookie: `session_id=${"x".repeat(8192)}`,
      expected: undefined,
      extraCount: 0,
      cookieFirst: false,
    },
    {
      name: "omits a cookie when only analytics remain",
      cookie: `_ga=${"x".repeat(8192)}`,
      expected: undefined,
      extraCount: 0,
      cookieFirst: false,
    },
    ...[true, false].map((cookieFirst) => ({
      name: `omits a cookie past the header cap (cookieFirst=${cookieFirst})`,
      cookie: "session_id=abc",
      expected: undefined,
      extraCount: 30,
      cookieFirst,
    })),
  ])(
    "$name and still relays",
    async ({ cookie, expected, extraCount, cookieFirst }) => {
      const stub = await startStub({ postData: CARD });
      const calls: RelayRequest[] = [];
      const events: InterceptorEvent[] = [];
      const warnings: StepWarning[] = [];
      try {
        const handle = await attachInterceptor(stub.url, {
          relay: stubPaymentRelay(async (request) => {
            calls.push(request);
            return success();
          }),
          placeholder: HELD,
          logger: stepLogger(warnings),
        });
        handle.on((event) => events.push(event));
        attachPage(stub.emit);
        await waitFor(
          () =>
            stub.commands.some((command) => command.method === "Fetch.enable"),
          "Fetch.enable",
        );
        stub.emit({
          method: "Fetch.requestPaused",
          sessionId: "page-1",
          params: {
            requestId: "req-1",
            networkId: "net-1",
            request: {
              url: "https://api.pay.example/v1/tokens",
              method: "POST",
              headers: {
                ...(cookieFirst ? { Cookie: cookie } : {}),
                "Content-Type": "application/json",
                ...Object.fromEntries(
                  Array.from({ length: extraCount }, (_, i) => [
                    `x-extra-${i}`,
                    "1",
                  ]),
                ),
                "X-CSRF-Token": "csrf-example",
                ...(!cookieFirst ? { Cookie: cookie } : {}),
              },
              hasPostData: true,
              postDataEntries: [{}],
            },
            resourceType: "Fetch",
          },
        });
        await waitFor(
          () =>
            events.some(
              (event) => event.type === "relayed" || event.type === "failed",
            ),
          "terminal event",
        );
        expect(calls).toHaveLength(1);
        const headers = calls[0].request.headers;
        if (expected === undefined)
          expect(headers).not.toHaveProperty("cookie");
        else expect(headers.cookie).toBe(expected);
        expect(headers["x-csrf-token"]).toBe("csrf-example");
        expect(Object.keys(headers)).toHaveLength(
          2 + extraCount + (expected === undefined ? 0 : 1),
        );
        expect(events.some((event) => event.type === "failed")).toBe(false);
        expect(stub.commands).toContainEqual(
          expect.objectContaining({ method: "Fetch.fulfillRequest" }),
        );
        await handle.detach();
        expect(
          JSON.stringify({ events, warnings, commands: stub.commands }),
        ).not.toMatch(/session_id|_ga|_fbp|fixture/);
      } finally {
        await stub.close();
      }
    },
  );

  it.each([
    [
      "more headers than the relay takes",
      Object.fromEntries(
        Array.from({ length: 31 }, (_, i) => [`x-extra-${i}`, "1"]),
      ),
      {},
    ],
    [
      "a header longer than the relay takes",
      { "x-long": "a".repeat(8193) },
      {},
    ],
    [
      "a 33rd header named like an object's own property",
      Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`x-extra-${i}`, "1"]),
      ),
      { constructor: "1" },
    ],
  ])(
    "fails the paused request rather than relay it without a header, for %s",
    async (_name, extra, after) => {
      const stub = await startStub({ postData: CARD });
      const calls: RelayRequest[] = [];
      const events: InterceptorEvent[] = [];
      try {
        const handle = await attachInterceptor(stub.url, {
          relay: stubPaymentRelay(async (request) => {
            calls.push(request);
            return success();
          }),
          placeholder: HELD,
        });
        handle.on((event) => events.push(event));
        attachPage(stub.emit);
        await waitFor(
          () =>
            stub.commands.some((command) => command.method === "Fetch.enable"),
          "Fetch.enable",
        );
        stub.emit({
          method: "Fetch.requestPaused",
          sessionId: "page-1",
          params: {
            requestId: "req-1",
            networkId: "net-1",
            request: {
              url: "https://api.pay.example/v1/tokens",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...extra,
                // After the extras, where a cap that kept the first headers would drop it.
                "X-CSRF-Token": "csrf-example",
                ...after,
              },
              hasPostData: true,
              postDataEntries: [{}],
            },
            resourceType: "Fetch",
          },
        });
        await waitFor(
          () => events.some((event) => event.type === "failed"),
          "failed",
        );
        expect(calls).toHaveLength(0);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "failed",
            reason: "headers_unrelayable",
          }),
        );
        expect(
          stub.commands.some(
            (command) => command.method === "Fetch.continueRequest",
          ),
        ).toBe(false);
        await handle.detach();
      } finally {
        await stub.close();
      }
    },
  );

  it("refuses an empty profileId", async () => {
    await expect(
      attachInterceptor("ws://127.0.0.1:1", {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "",
      }),
    ).rejects.toThrow("profileId must not be empty");
  });

  const playwrightBrowser = { contexts: () => [], newPage: async () => ({}) };
  it.each([
    ["browser", playwrightBrowser],
    ["page", { context: () => ({ browser: () => playwrightBrowser }) }],
  ])(
    "refuses a Playwright %s, which has no wsEndpoint()",
    async (_kind, target) => {
      await expect(
        attachInterceptor(target as unknown as InterceptorTarget, {
          relay: stubPaymentRelay(async () => success()),
          placeholder: HELD,
        }),
      ).rejects.toThrow(
        "Playwright browsers and pages do not expose wsEndpoint()",
      );
    },
  );

  it("reads a body with missing entry bytes via getRequestPostData and relays it", async () => {
    const stub = await startStub({ postData: CARD });
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-1",
          networkId: "net-1",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            headers: { "content-type": "application/json" },
            hasPostData: true,
            postDataEntries: [{}],
          },
          resourceType: "Fetch",
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "relayed",
      );
      expect(stub.commands).toContainEqual(
        expect.objectContaining({
          method: "Network.getRequestPostData",
          params: { requestId: "net-1" },
        }),
      );
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.getRequestPostData",
        ),
      ).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].request.body).toBe(CARD);
      expect(calls[0].idempotencyKey).toBe(
        crypto
          .createHash("sha256")
          .update(`POST\0${calls[0].request.url}\0${CARD}`)
          .digest("hex"),
      );
      expect(calls[0].profileId).toBe("shopify-card-vault");
      expect(header(calls[0].request.headers, "content-type")).toBe(
        "application/json",
      );
      expect(calls[0].request.headers).not.toHaveProperty("cookie");
      expect(calls[0].request.headers).not.toHaveProperty("sec-fetch-site");
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("continues a text-only multipart form read from the network", async () => {
    const body =
      '--b\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--b--';
    const stub = await startStub({ postData: body });
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit(multipartPause("req-text", "net-text"));
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Fetch.continueRequest",
          ),
        "continue",
      );
      expect(calls).toHaveLength(0);
      expect(events.some((event) => event.type === "failed")).toBe(false);
      expect(
        stub.commands.some(
          (command) => command.method === "Network.getRequestPostData",
        ),
      ).toBe(true);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("relays a text-only multipart form that holds the placeholder", async () => {
    const body =
      '--b\r\nContent-Disposition: form-data; name="number"\r\n\r\n4242 4242 4242 4242\r\n--b--';
    const stub = await startStub({ postData: body });
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit(multipartPause("req-text-held", "net-text-held"));
      await waitFor(() => calls.length === 1, "relay");
      expect(calls[0].request.body).toBe(body);
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.continueRequest",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fails closed when a multipart body would omit file bytes", async () => {
    const body = [
      '--b\r\nContent-Disposition: form-data; name="number"\r\n\r\n4242 4242 4242 4242',
      'Content-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n',
      "--b--",
    ].join("\r\n--b\r\n");
    const stub = await startStub({ postData: body });
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit(multipartPause("req-file", "net-file"));
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "failed",
      );
      expect(calls).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failed", reason: "unreadable_body" }),
      );
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.continueRequest",
        ),
      ).toBe(false);
      expect(
        stub.commands.some(
          (command) => command.method === "Network.getRequestPostData",
        ),
      ).toBe(true);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fails a paused request when the body cannot be read", async () => {
    const stub = await startStub({ postDataError: true });
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-2",
          networkId: "net-2",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            hasPostData: true,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "failed",
      );
      expect(calls).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failed", reason: "unreadable_body" }),
      );
      expect(
        stub.commands.some((command) => command.method === "Fetch.failRequest"),
      ).toBe(true);
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.continueRequest",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("relays a request whose URL holds the placeholder even when the body does not", async () => {
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-url",
          request: {
            url: "https://checkout.example/pay?number=4242%204242%204242%204242",
            method: "POST",
            postData: '{"event":"ping"}',
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "relayed",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].request.url).toContain("4242%204242%204242%204242");
      expect(calls[0].request.body).toBe('{"event":"ping"}');
      expect(events.map((event) => event.type)).toEqual(["paused", "relayed"]);
      expect(JSON.stringify(events)).not.toContain(HELD.number);
      expect(JSON.stringify(events)).not.toContain("4242");
      expect(JSON.stringify(events)).not.toContain("%20");
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.continueRequest",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("relays a multipart body whose boundary digits follow the placeholder", async () => {
    const boundary = "----WebKitFormBoundary123";
    const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="number"\r\n\r\n4242 4242 4242 4242\r\n--${boundary}--`;
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-multi",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: multipart,
          },
        },
      });
      await waitFor(() => calls.length === 1, "relay");
      expect(calls[0].request.body).toBe(multipart);
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.continueRequest",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("relays a placeholder split by repeated spaces and dashes", async () => {
    const body = "4242  4242 - 4242  4242";
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-spaced",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: body,
          },
        },
      });
      await waitFor(() => calls.length === 1, "relay");
      expect(calls[0].request.body).toBe(body);
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.continueRequest",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fails an in-flight relay on detach before Fetch is disabled", async () => {
    const stub = await startStub();
    let signal: AbortSignal | undefined;
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(
          (_request, options?: RelayCallOptions) =>
            new Promise((_resolve, reject) => {
              signal = options?.signal;
              const abort = () => reject(new Error("Payment relay timed out"));
              if (options?.signal?.aborted) abort();
              else
                options?.signal?.addEventListener("abort", abort, {
                  once: true,
                });
            }),
        ),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        timeoutMs: 30_000,
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-detach",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "paused"),
        "paused",
      );
      await handle.detach();
      const methods = stub.commands.map((command) => command.method);
      expect(methods.indexOf("Fetch.failRequest")).toBeGreaterThan(-1);
      expect(methods.indexOf("Fetch.failRequest")).toBeLessThan(
        methods.indexOf("Fetch.disable"),
      );
      expect(signal?.aborted).toBe(true);
      expect(events.map((event) => event.type)).toEqual(["paused", "failed"]);
      expect(events[1]).toMatchObject({ type: "failed", reason: "detached" });
    } finally {
      await stub.close();
    }
  });

  it("reports relayed_unfulfilled when fulfill fails after a successful relay", async () => {
    const stub = await startStub({ failFulfill: true });
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-fulfill",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed_unfulfilled"),
        "relayed_unfulfilled",
      );
      expect(events.map((event) => event.type)).toEqual([
        "paused",
        "relayed_unfulfilled",
      ]);
      expect(events[1]).toMatchObject({
        type: "relayed_unfulfilled",
        status: 201,
      });
      expect(
        stub.commands.some((command) => command.method === "Fetch.failRequest"),
      ).toBe(true);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fulfills a response that contains a different card number or a timestamp", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => ({
          outcome: "relayed",
          response: {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: '{"id":"sess","created_at":1760650000123,"pan":"4111111111111111"}',
          },
        })),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-leak",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "relayed",
      );
      expect(events.map((event) => event.type)).toEqual(["paused", "relayed"]);
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.fulfillRequest",
        ),
      ).toBe(true);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("continues an unrelated GET without reading a body, and keeps one session per target", async () => {
    const stub = await startStub();
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit, "page-1");
      await waitFor(
        () =>
          stub.commands.filter((command) => command.method === "Fetch.enable")
            .length === 1,
        "first Fetch.enable",
      );
      stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-2",
          waitingForDebugger: true,
          targetInfo: {
            targetId: "target-page",
            type: "page",
            url: "https://shop.example/checkout",
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Target.detachFromTarget",
          ),
        "detach duplicate",
      );
      expect(
        stub.commands.filter((command) => command.method === "Fetch.enable"),
      ).toHaveLength(1);
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-get",
          request: {
            url: "https://cdn.example/app.js",
            method: "GET",
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Fetch.continueRequest",
          ),
        "continue",
      );
      expect(
        stub.commands.some(
          (command) =>
            command.method === "Network.getRequestPostData" ||
            command.method === "Fetch.getRequestPostData",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("enables Fetch on an iframe already on the payment host before attach returns", async () => {
    const stub = await startStub({
      targets: [
        {
          targetId: "target-card",
          type: "iframe",
          url: "https://checkout.pci.shopifyinc.com/sessions",
        },
      ],
      attachedSessionId: "iframe-card",
    });
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      const enable = stub.commands.findIndex(
        (command) =>
          command.method === "Fetch.enable" &&
          command.sessionId === "iframe-card",
      );
      const autoAttach = stub.commands.findIndex(
        (command) =>
          command.method === "Target.setAutoAttach" &&
          command.sessionId === "iframe-card" &&
          command.params.waitForDebuggerOnStart === true,
      );
      expect(enable).toBeGreaterThan(-1);
      expect(autoAttach).toBeGreaterThan(-1);
      expect(autoAttach).toBeLessThan(enable);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fails a paused request whose CDP session was never attached", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "missing-session",
        params: {
          requestId: "req-unknown",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "failed" && event.reason === "unknown_session",
          ),
        "unknown session",
      );
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Fetch.failRequest" &&
              command.sessionId === "missing-session" &&
              command.params.requestId === "req-unknown",
          ),
        "unknown-session failure command",
      );
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("sends one relay for identical in-flight retries and logs the refusal once", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warnings: string[] = [];
    const logger = {
      warn(message: string) {
        warnings.push(message);
      },
    };
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => {
          calls += 1;
          if (calls === 1) await gate;
          return { outcome: "refused", reason: "already_relayed" };
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        logger,
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      const paused = {
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-a",
          resourceType: "Fetch",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      };
      stub.emit(paused);
      await waitFor(() => calls === 1, "first relay");
      stub.emit({
        ...paused,
        params: { ...paused.params, requestId: "req-b" },
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toBe(1);
      release();
      // `refused` is emitted once the failRequest reply comes back, after the stub records the command.
      await waitFor(
        () =>
          stub.commands.filter(
            (command) => command.method === "Fetch.failRequest",
          ).length >= 2 &&
          events.filter((event) => event.type === "refused").length >= 2,
        "both failed",
      );
      expect(calls).toBe(1);
      expect(warnings).toEqual(["payment relay refused the paused request"]);
      expect(events.filter((event) => event.type === "refused")).toHaveLength(
        2,
      );
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it.each([
    ["with a profile", "shopify-card-vault"],
    ["without a profile", undefined],
  ])(
    "fulfills %s with one Set-Cookie header per relayed setCookies entry, never logging them",
    async (_label, profileId) => {
      const sentinel = "sid=SET_COOKIE_SENTINEL";
      const setCookies = [`${sentinel}; Path=/; HttpOnly`, "b=2; Path=/"];
      const outcomes: RelayResponse[] = [
        success(),
        {
          outcome: "relayed",
          response: {
            status: 201,
            headers: { "content-type": "application/json" },
            setCookies,
            body: '{"id":"sess"}',
          },
        },
      ];
      const stub = await startStub();
      const events: InterceptorEvent[] = [];
      const warnings: StepWarning[] = [];
      try {
        const handle = await attachInterceptor(stub.url, {
          relay: stubPaymentRelay(async () => outcomes.shift()!),
          placeholder: HELD,
          profileId,
          logger: stepLogger(warnings),
        });
        handle.on((event) => events.push(event));
        attachPage(stub.emit);
        await waitFor(
          () =>
            stub.commands.some((command) => command.method === "Fetch.enable"),
          "Fetch.enable",
        );
        for (const [requestId, month] of [
          ["req-plain", 11],
          ["req-cookies", 12],
        ] as const) {
          stub.emit({
            method: "Fetch.requestPaused",
            sessionId: "page-1",
            params: {
              requestId,
              request: {
                url: "https://checkout.example/sessions",
                method: "POST",
                postData: JSON.stringify({
                  credit_card: { number: HELD.number, month },
                }),
              },
            },
          });
          await waitFor(
            () =>
              stub.commands.some(
                (command) =>
                  command.method === "Fetch.fulfillRequest" &&
                  command.params.requestId === requestId,
              ),
            requestId,
          );
        }
        const fulfilled = stub.commands
          .filter((command) => command.method === "Fetch.fulfillRequest")
          .map((command) => command.params);
        const body = Buffer.from('{"id":"sess"}').toString("base64");
        expect(fulfilled).toStrictEqual([
          {
            requestId: "req-plain",
            responseCode: 201,
            responseHeaders: [
              { name: "content-type", value: "application/json" },
            ],
            body,
          },
          {
            requestId: "req-cookies",
            responseCode: 201,
            responseHeaders: [
              { name: "content-type", value: "application/json" },
              { name: "Set-Cookie", value: setCookies[0] },
              { name: "Set-Cookie", value: setCookies[1] },
            ],
            body,
          },
        ]);
        await handle.detach();
        expect(JSON.stringify({ events, warnings })).not.toContain(
          "SET_COOKIE_SENTINEL",
        );
      } finally {
        await stub.close();
      }
    },
  );

  it("forwards only Shopify profile headers, excluding cookies", async () => {
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-cookie",
          resourceType: "XHR",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: "cart=1",
              Accept: "application/json",
              "Shopify-Identification-Signature": "sig",
              "X-Unforwarded": "nope",
            },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "relayed",
      );
      expect(calls[0].request.headers).not.toHaveProperty("cookie");
      expect(calls[0].request.headers).toEqual({
        accept: "application/json",
        "content-type": "application/json",
        "shopify-identification-signature": "sig",
      });
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fails a relayed response that still contains the held placeholder", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => ({
          outcome: "relayed",
          response: {
            status: 200,
            headers: { "content-type": "text/plain" },
            body: `session ${HELD.number}`,
          },
        })),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-held-back",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "failed",
      );
      expect(events[1]).toMatchObject({ reason: "response_credential" });
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.fulfillRequest",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("relays a held number that fails the Luhn check", async () => {
    const number = "4242424242424243";
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: { ...HELD, number },
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-luhn",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: JSON.stringify({ number }),
          },
        },
      });
      await waitFor(() => calls.length === 1, "relay");
      expect(calls[0].request.body).toContain(number);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("fails the paused request when the relay ignores the abort signal", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: { relay: () => new Promise(() => {}) },
        placeholder: HELD,
        profileId: "shopify-card-vault",
        timeoutMs: 40,
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-hang",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "timeout",
      );
      expect(events[1]).toMatchObject({ type: "failed", reason: "timeout" });
      expect(
        stub.commands.some((command) => command.method === "Fetch.failRequest"),
      ).toBe(true);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not let an earlier timeout abort a later retry of the same body", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    let calls = 0;
    let aborted = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(
          (_request, options) =>
            new Promise((resolve, reject) => {
              calls += 1;
              const finish = () => resolve(success());
              options?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
              void gate.then(finish);
            }),
        ),
        placeholder: HELD,
        profileId: "shopify-card-vault",
        timeoutMs: 400,
        attemptTimeoutMs: 1_000,
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      const paused = {
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-early",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      };
      stub.emit(paused);
      await waitFor(() => calls === 1, "first relay");
      await new Promise((resolve) => setTimeout(resolve, 250));
      stub.emit({
        ...paused,
        params: { ...paused.params, requestId: "req-later" },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(aborted).toBe(false);
      expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
      release();
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "later relay",
      );
      expect(calls).toBe(1);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("decodes postDataEntries that split a multibyte character", async () => {
    const text = `{"number":"${HELD.number}","name":"é"}`;
    const bytes = Buffer.from(text, "utf8");
    const splitAt =
      Buffer.from(text.slice(0, text.indexOf("é")), "utf8").length + 1;
    const first = bytes.subarray(0, splitAt);
    const second = bytes.subarray(splitAt);
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-bytes",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postDataEntries: [
              { bytes: first.toString("base64") },
              { bytes: second.toString("base64") },
            ],
          },
        },
      });
      await waitFor(() => calls.length === 1, "relay");
      expect(calls[0].request.body).toBe(text);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not send a second relay after outcome unknown", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    let calls = 0;
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => {
          calls += 1;
          return { outcome: "unknown" };
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      handle.on((event) => events.push(event));
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      const paused = {
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-unknown-1",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      };
      stub.emit(paused);
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "unknown",
      );
      stub.emit({
        ...paused,
        params: { ...paused.params, requestId: "req-unknown-2" },
      });
      await waitFor(
        () => events.filter((event) => event.type === "failed").length === 2,
        "second unknown",
      );
      expect(calls).toBe(1);
      expect(events[1]).toMatchObject({ reason: "unknown" });
      expect(events[3]).toMatchObject({ reason: "unknown" });
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not enable Fetch on a captcha iframe", async () => {
    const stub = await startStub();
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "captcha-1",
          waitingForDebugger: true,
          targetInfo: {
            targetId: "target-captcha",
            type: "iframe",
            url: "https://hcaptcha.com/captcha/v1/abc/static/hcaptcha.html",
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Runtime.runIfWaitingForDebugger" &&
              command.sessionId === "captcha-1",
          ),
        "resume captcha",
      );
      expect(
        stub.commands.some(
          (command) =>
            command.method === "Fetch.enable" &&
            command.sessionId === "captcha-1",
        ),
      ).toBe(false);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("delivers an arm failure that happened before the handle was returned", async () => {
    const stub = await startStub({
      failFetch: true,
      targets: [
        {
          targetId: "iframe-existing",
          type: "iframe",
          url: "https://checkout.example/card",
        },
      ],
    });
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      expect(
        stub.commands.some(
          (command) => command.method === "Target.closeTarget",
        ),
      ).toBe(true);
      handle.on((event) => events.push(event));
      expect(events).toStrictEqual([
        {
          type: "failed",
          url: "https://checkout.example",
          reason: "intercept_unavailable",
        },
      ]);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not relay a duplicate pause while fulfill is in flight", async () => {
    const stub = await startStub({ holdFulfill: true });
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      const pause = {
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-dup",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      };
      stub.emit(pause);
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Fetch.fulfillRequest",
          ),
        "fulfill",
      );
      stub.emit(pause);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toHaveLength(1);
      expect(
        stub.commands.filter(
          (command) => command.method === "Fetch.fulfillRequest",
        ),
      ).toHaveLength(1);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not keep events that fire after start when nobody subscribed", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-early",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Fetch.fulfillRequest" &&
              command.params.requestId === "req-early",
          ),
        "early fulfill",
      );
      handle.on((event) => events.push(event));
      expect(events).toEqual([]);
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-late",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "late relay",
      );
      expect(events.map((event) => event.type)).toEqual(["paused", "relayed"]);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("drops startup events on detach when nothing subscribed", async () => {
    const stub = await startStub({
      failFetch: true,
      targets: [
        {
          targetId: "iframe-existing",
          type: "iframe",
          url: "https://checkout.example/card",
        },
      ],
    });
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      await handle.detach();
      handle.on((event) => events.push(event));
      expect(events).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("does not fail a request that detach observes during fulfill", async () => {
    const stub = await startStub({ holdFulfill: true });
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-fulfill-race",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) => command.method === "Fetch.fulfillRequest",
          ),
        "fulfill",
      );
      await handle.detach();
      expect(
        stub.commands.filter(
          (command) => command.method === "Fetch.fulfillRequest",
        ),
      ).toHaveLength(1);
      expect(
        stub.commands.some((command) => command.method === "Fetch.failRequest"),
      ).toBe(false);
    } finally {
      await stub.close();
    }
  });

  it("keeps Fetch armed on a blank iframe across target info changes", async () => {
    const stub = await startStub();
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        profileId: "shopify-card-vault",
      });
      attachPage(stub.emit);
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Fetch.enable" &&
              command.sessionId === "page-1",
          ),
        "arm page",
      );
      stub.emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "iframe-blank",
          waitingForDebugger: true,
          targetInfo: {
            targetId: "target-blank",
            type: "iframe",
            url: "about:blank",
          },
        },
      });
      await waitFor(
        () =>
          stub.commands.some(
            (command) =>
              command.method === "Fetch.enable" &&
              command.sessionId === "iframe-blank",
          ),
        "arm blank iframe",
      );
      stub.emit({
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: { targetId: "target-blank", url: "about:blank" },
        },
      });
      stub.emit({
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: {
            targetId: "target-blank",
            url: "https://checkout.example/card",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        stub.commands.some(
          (command) =>
            command.method === "Fetch.disable" &&
            command.sessionId === "iframe-blank",
        ),
      ).toBe(false);
      stub.emit({
        method: "Fetch.requestPaused",
        sessionId: "iframe-blank",
        params: {
          requestId: "req-blank-nav",
          request: {
            url: "https://checkout.example/sessions",
            method: "POST",
            postData: CARD,
          },
        },
      });
      await waitFor(() => calls.length === 1, "relay after blank navigation");
      expect(
        stub.commands.filter(
          (command) =>
            command.method === "Fetch.enable" &&
            command.sessionId === "iframe-blank",
        ),
      ).toHaveLength(1);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });
});

describe("experimental verification hook", () => {
  const initial = (): VerificationState => ({
    id: "verification-1",
    version: 0,
    status: "preparing",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    merchantOrigin: "https://shop.example",
    total: { amount: "10.00", currency: "USD" },
    challengeCaptured: false,
    launchClaimed: false,
    continuationClaimed: false,
    checkRequested: false,
  });
  const adapter = (): VerificationAdapter => ({
    inspect: jest.fn(async () => "continue" as const),
    relayed: jest.fn(),
    reconcile: jest.fn(async () => null),
    dispose: jest.fn(),
  });
  const pause = (
    stub: Awaited<ReturnType<typeof startStub>>,
    id: string,
    body?: string,
  ) =>
    stub.emit({
      method: "Fetch.requestPaused",
      sessionId: "page-1",
      params: {
        requestId: id,
        frameId: "frame-1",
        networkId: "network-1",
        request: {
          url: "https://bank.example/challenge",
          method: body === undefined ? "GET" : "POST",
          postData: body,
        },
      },
    });
  const settled = (stub: Awaited<ReturnType<typeof startStub>>, id: string) =>
    stub.commands.filter(
      (c) =>
        [
          "Fetch.continueRequest",
          "Fetch.fulfillRequest",
          "Fetch.failRequest",
        ].includes(c.method) && c.params.requestId === id,
    );

  it("preserves main behavior without an adapter, even with prebound runner options", async () => {
    const stub = await startStub();
    const runner = { sync: jest.fn(), report: jest.fn() };
    const relay = jest.fn(async () => success());
    try {
      const handle = await attachInterceptor(stub.url, {
        placeholder: HELD,
        relay: stubPaymentRelay(relay),
        verification: { initial: initial(), runner },
      });
      expect(handle.verification).toBeUndefined();
      attachPage(stub.emit);
      await waitFor(
        () => stub.commands.some((c) => c.method === "Fetch.enable"),
        "arm",
      );
      pause(stub, "ordinary-get");
      pause(stub, "ordinary-acs", "creq=ordinary");
      pause(stub, "held", CARD);
      await waitFor(
        () =>
          ["ordinary-get", "ordinary-acs", "held"].every(
            (id) => settled(stub, id).length === 1,
          ),
        "settled",
      );
      expect(settled(stub, "ordinary-get")[0].method).toBe(
        "Fetch.continueRequest",
      );
      expect(settled(stub, "ordinary-acs")[0].method).toBe(
        "Fetch.continueRequest",
      );
      expect(settled(stub, "held")[0].method).toBe("Fetch.fulfillRequest");
      expect(relay).toHaveBeenCalledTimes(1);
      expect(runner.sync).not.toHaveBeenCalled();
      expect(runner.report).not.toHaveBeenCalled();
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it.each(["continue", "block", "capture", "fallback"] as const)(
    "settles hook %s exactly once and preserves frame correlation",
    async (action) => {
      const stub = await startStub();
      const a = adapter();
      a.inspect = jest.fn(async (r) =>
        action === "capture"
          ? { capture: { url: r.url, body: r.body } }
          : action,
      );
      let state = initial();
      const report = jest.fn(async (_id, input) => {
        state = {
          ...state,
          version: state.version + 1,
          challengeCaptured:
            input.kind === "challenge_observed" || state.challengeCaptured,
        };
        return state;
      });
      try {
        const handle = await attachInterceptor(stub.url, {
          placeholder: HELD,
          relay: stubPaymentRelay(async () => success()),
          verification: {
            initial: state,
            runner: { sync: async () => state, report },
          },
          verificationAdapter: () => a,
        });
        attachPage(stub.emit);
        await waitFor(
          () => stub.commands.some((c) => c.method === "Fetch.enable"),
          "arm",
        );
        pause(stub, "hook", "creq=challenge");
        await waitFor(
          () => settled(stub, "hook").length === 1,
          "hook settlement",
        );
        expect(a.inspect).toHaveBeenCalledWith(
          expect.objectContaining({
            frameId: "frame-1",
            networkId: "network-1",
            sessionId: "page-1",
            body: "creq=challenge",
          }),
        );
        const command = settled(stub, "hook")[0];
        expect(command.method).toBe(
          action === "capture"
            ? "Fetch.fulfillRequest"
            : action === "block"
              ? "Fetch.failRequest"
              : "Fetch.continueRequest",
        );
        if (action === "capture") {
          expect(
            Buffer.from(command.params.body as string, "base64").toString(),
          ).toContain("Continue verification on purchase page.");
          pause(stub, "duplicate", "creq=challenge");
          pause(stub, "new-card", CARD);
          await waitFor(
            () =>
              settled(stub, "duplicate").length === 1 &&
              settled(stub, "new-card").length === 1,
            "fence",
          );
          expect(settled(stub, "duplicate")[0].method).toBe(
            "Fetch.failRequest",
          );
          expect(settled(stub, "new-card")[0].method).toBe("Fetch.failRequest");
          expect(
            report.mock.calls.filter(
              ([, input]) => input.kind === "challenge_observed",
            ),
          ).toHaveLength(1);
        }
        const terminal = handle.verification!.wait();
        await handle.detach();
        await expect(terminal).resolves.toMatchObject({ status: "error" });
        expect(a.dispose).toHaveBeenCalledTimes(1);
      } finally {
        await stub.close();
      }
    },
  );

  it("fails a hung hook once within the interceptor deadline", async () => {
    const stub = await startStub();
    const a = adapter();
    a.inspect = jest.fn(() => new Promise(() => {}));
    const state = initial();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        placeholder: HELD,
        relay: stubPaymentRelay(async () => success()),
        timeoutMs: 20,
        verification: {
          initial: state,
          runner: { sync: async () => state, report: async () => state },
        },
        verificationAdapter: () => a,
      });
      handle.on((e) => events.push(e));
      attachPage(stub.emit);
      await waitFor(
        () => stub.commands.some((c) => c.method === "Fetch.enable"),
        "arm",
      );
      pause(stub, "hung", "creq=challenge");
      await waitFor(
        () => settled(stub, "hung").length === 1,
        "hung settlement",
      );
      expect(settled(stub, "hung")[0].method).toBe("Fetch.failRequest");
      expect(events).toContainEqual({
        type: "failed",
        url: "https://bank.example",
        reason: "network",
      });
      await handle.detach();
      expect(settled(stub, "hung")).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it("inspects GET and binds relayed response before browser fulfillment", async () => {
    const stub = await startStub();
    const a = adapter();
    const state = initial();
    a.relayed = jest.fn(() => {
      expect(
        stub.commands.some((c) => c.method === "Fetch.fulfillRequest"),
      ).toBe(false);
    });
    try {
      const handle = await attachInterceptor(stub.url, {
        placeholder: HELD,
        relay: stubPaymentRelay(async () => success()),
        verification: {
          initial: state,
          runner: { sync: async () => state, report: async () => state },
        },
        verificationAdapter: () => a,
      });
      attachPage(stub.emit);
      await waitFor(
        () => stub.commands.some((c) => c.method === "Fetch.enable"),
        "arm",
      );
      pause(stub, "get");
      await waitFor(() => settled(stub, "get").length === 1, "get");
      expect(a.inspect).toHaveBeenCalledWith(
        expect.objectContaining({ method: "GET", body: "" }),
      );
      pause(stub, "card", CARD);
      await waitFor(() => settled(stub, "card").length === 1, "card");
      expect(a.inspect).toHaveBeenCalledTimes(1);
      expect(a.relayed).toHaveBeenCalledWith(
        expect.objectContaining({ body: '{"id":"sess"}' }),
        "page-1",
        {
          frameId: "frame-1",
          url: "https://bank.example/challenge",
        },
      );
      await handle.detach();
    } finally {
      await stub.close();
    }
  });
});

it("fails unreadable hook bodies without inspection or fabricated empty bytes", async () => {
  const stub = await startStub({ postDataError: true });
  const inspect = jest.fn(async () => "continue" as const);
  const initial: VerificationState = {
    id: "v",
    version: 0,
    status: "preparing",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    merchantOrigin: "https://shop.example",
    total: { amount: "10.00", currency: "USD" },
    challengeCaptured: false,
    launchClaimed: false,
    checkRequested: false,
    continuationClaimed: false,
  };
  try {
    const events: InterceptorEvent[] = [];
    const handle = await attachInterceptor(stub.url, {
      placeholder: HELD,
      relay: stubPaymentRelay(async () => success()),
      verification: {
        initial,
        runner: { sync: async () => initial, report: async () => initial },
      },
      verificationAdapter: () => ({
        inspect,
        relayed: () => {},
        reconcile: async () => null,
      }),
    });
    handle.on((e) => events.push(e));
    attachPage(stub.emit);
    await waitFor(
      () => stub.commands.some((c) => c.method === "Fetch.enable"),
      "arm",
    );
    stub.emit(multipartPause("unreadable-hook", "network-unreadable"));
    await waitFor(
      () => events.some((e) => e.type === "failed"),
      "failed unreadable hook",
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "failed", reason: "unreadable_body" }),
    );
    expect(inspect).not.toHaveBeenCalled();
    await handle.detach();
  } finally {
    await stub.close();
  }
});

it("resolves verification waiters on unexpected idle CDP loss", async () => {
  const stub = await startStub();
  const dispose = jest.fn();
  const initial: VerificationState = {
    id: "v",
    version: 0,
    status: "preparing",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    merchantOrigin: "https://shop.example",
    total: { amount: "10.00", currency: "USD" },
    challengeCaptured: false,
    launchClaimed: false,
    checkRequested: false,
    continuationClaimed: false,
  };
  const report = jest.fn(async () => initial);
  const handle = await attachInterceptor(stub.url, {
    placeholder: HELD,
    relay: stubPaymentRelay(async () => success()),
    verification: { initial, runner: { sync: async () => initial, report } },
    verificationAdapter: () => ({
      inspect: async () => "continue",
      relayed: () => {},
      reconcile: async () => null,
      dispose,
    }),
  });
  const terminal = handle.verification!.wait();
  await stub.close();
  await expect(terminal).resolves.toMatchObject({ status: "error" });
  expect(dispose).toHaveBeenCalledTimes(1);
  await waitFor(() => report.mock.calls.length === 1, "browser_lost receipt");
  expect(report).toHaveBeenCalledWith(
    "v",
    expect.objectContaining({ kind: "browser_lost" }),
  );
  await handle.detach();
});
