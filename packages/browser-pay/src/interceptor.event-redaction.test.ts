import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { textHoldsPlaceholderNumber } from "./detect";
import type { PayLogger } from "./logger";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import type { RelayRequest, RelayResponse } from "./contract";
import { stubPaymentRelay } from "../test/stub-relay";

const HELD = {
  number: "4242424242424242",
  injectionRef: "inj_event_redaction",
};

const PLACEHOLDER_FORMS = [
  "4242424242424242",
  "4242 4242 4242 4242",
  "4242-4242-4242-4242",
  "4242%204242%204242%204242",
  "4242+4242+4242+4242",
  String.raw`4242\u00204242\u00204242\u00204242`,
];

const MARKERS = [
  "synthuser",
  "synthpass",
  "synthopaquesession",
  "synthqueryvalue",
  "synthtoken",
  "synthfragment",
  ...PLACEHOLDER_FORMS,
];

const ORIGIN = "https://checkout.example.test:8443";
const BODY = '{"note":"synthbody"}';

interface Command {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface StubOptions {
  failFetch?: boolean;
  failFulfill?: boolean;
  errorOnMethod?: { method: string; message: string };
  attachOnAutoAttach?: { targetId: string; url: string };
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

async function startCdp(options: StubOptions = {}): Promise<{
  url: string;
  commands: Command[];
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}> {
  const commands: Command[] = [];
  let socket: Duplex | undefined;
  const chunks: Buffer[] = [];
  let buffered = 0;
  let emittedAttachedTarget = false;

  const reply = (id: number, result: unknown, error?: { message: string }) => {
    socket?.write(
      serverFrame(JSON.stringify(error ? { id, error } : { id, result })),
    );
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
    if (chunks[0] && chunks[0].length >= length) {
      return chunks[0].subarray(0, length);
    }
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

  const emit = (event: Record<string, unknown>) => {
    socket?.write(serverFrame(JSON.stringify(event)));
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

    if (options.errorOnMethod?.method === message.method) {
      reply(message.id, undefined, { message: options.errorOnMethod.message });
      return;
    }
    if (
      message.method === "Target.setAutoAttach" &&
      !message.sessionId &&
      options.attachOnAutoAttach &&
      !emittedAttachedTarget
    ) {
      emittedAttachedTarget = true;
      emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "page-1",
          waitingForDebugger: true,
          targetInfo: {
            targetId: options.attachOnAutoAttach.targetId,
            type: "page",
            url: options.attachOnAutoAttach.url,
          },
        },
      });
    }
    if (message.method === "Fetch.enable" && options.failFetch) {
      reply(message.id, undefined, { message: "Fetch is unsupported" });
      return;
    }
    if (message.method === "Fetch.fulfillRequest" && options.failFulfill) {
      reply(message.id, undefined, { message: "request is gone" });
      return;
    }
    if (message.method === "Target.getTargets") {
      reply(message.id, { targetInfos: [] });
      return;
    }
    if (message.method === "Runtime.evaluate") {
      reply(message.id, {});
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
      } else if (length === 127) {
        const extended = peek(10);
        if (!extended) return;
        length = Number(extended.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      const frame = consume(offset + length);
      if (!frame) return;
      let payload = frame.subarray(offset, offset + length);
      if (masked) {
        const mask = frame.subarray(maskOffset, maskOffset + 4);
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index++) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }
      if ((header[0] & 0x0f) === 0x8) return;
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

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    commands,
    emit,
    close() {
      socket?.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function checkoutUrl(placeholderForm: string): string {
  return `https://synthuser:synthpass@checkout.example.test:8443/s/synthopaquesession/pay/${placeholderForm}?session=synthqueryvalue&token=synthtoken#synthfragment`;
}

function loggerFor(
  warnings: {
    message: string;
    fields?: Readonly<Record<string, string | number>>;
  }[],
): PayLogger {
  return {
    warn(message, fields) {
      warnings.push({ message, fields });
    },
  };
}

function assertNoMarkers(value: unknown): void {
  const json = JSON.stringify(value);
  for (const marker of MARKERS) expect(json).not.toContain(marker);
  expect(textHoldsPlaceholderNumber(json, HELD.number)).toBe(false);
}

function emitPage(stub: { emit: (event: Record<string, unknown>) => void }) {
  stub.emit({
    method: "Target.attachedToTarget",
    params: {
      sessionId: "page-1",
      waitingForDebugger: true,
      targetInfo: {
        targetId: "target-page",
        type: "page",
        url: "https://shop.example/checkout",
      },
    },
  });
}

function emitPause(
  stub: { emit: (event: Record<string, unknown>) => void },
  requestId: string,
  url: string,
  body = BODY,
): void {
  stub.emit({
    method: "Fetch.requestPaused",
    sessionId: "page-1",
    params: {
      requestId,
      request: {
        url,
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: body,
      },
    },
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function success(): RelayResponse {
  return {
    outcome: "relayed",
    response: {
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    },
  };
}

function attachOptions(
  relay: ReturnType<typeof stubPaymentRelay>,
  logger?: PayLogger,
) {
  return {
    relay,
    placeholder: HELD,
    profileId: "synthetic-profile",
    ...(logger ? { logger } : {}),
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected the promise to reject");
}

function assertSafeError(error: Error): void {
  const values = [
    error.message,
    String(error),
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ];
  for (const value of values) {
    for (const marker of MARKERS) expect(value).not.toContain(marker);
    expect(textHoldsPlaceholderNumber(value, HELD.number)).toBe(false);
  }
}

describe("interceptor event redaction", () => {
  it("emits only origins for every held URL form and relays the raw request unchanged", async () => {
    const stub = await startCdp();
    const events: InterceptorEvent[] = [];
    const calls: RelayRequest[] = [];
    const warnings: {
      message: string;
      fields?: Readonly<Record<string, string | number>>;
    }[] = [];
    try {
      const handle = await attachInterceptor(
        stub.url,
        attachOptions(
          stubPaymentRelay(async (request) => {
            calls.push(request);
            return success();
          }),
          loggerFor(warnings),
        ),
      );
      handle.on((event) => events.push(event));
      emitPage(stub);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );

      for (let index = 0; index < PLACEHOLDER_FORMS.length; index++) {
        const rawUrl = checkoutUrl(PLACEHOLDER_FORMS[index]);
        emitPause(stub, `req-${index}`, rawUrl);
        await waitFor(
          () =>
            events.filter((event) => event.type === "relayed").length ===
            index + 1,
          `relayed ${index + 1}`,
        );
        expect(calls[index].request.url).toBe(rawUrl);
        expect(calls[index].request.body).toBe(BODY);
        expect(calls[index].idempotencyKey).toBe(
          crypto
            .createHash("sha256")
            .update(`POST\0${rawUrl}\0${BODY}`)
            .digest("hex"),
        );
      }

      expect(events).toContainEqual({
        type: "paused",
        url: ORIGIN,
        method: "POST",
        targetType: "page",
      });
      expect(events).toContainEqual({
        type: "relayed",
        url: ORIGIN,
        status: 201,
      });
      expect(calls).toHaveLength(PLACEHOLDER_FORMS.length);
      assertNoMarkers(events);
      assertNoMarkers(warnings);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("preserves known refusal reasons and sanitizes custom reasons in events and logs", async () => {
    const stub = await startCdp();
    const events: InterceptorEvent[] = [];
    const warnings: {
      message: string;
      fields?: Readonly<Record<string, string | number>>;
    }[] = [];
    let calls = 0;
    try {
      const handle = await attachInterceptor(
        stub.url,
        attachOptions(
          stubPaymentRelay(async () => {
            calls += 1;
            return calls === 1
              ? { outcome: "refused", reason: "total_changed" }
              : {
                  outcome: "refused",
                  reason: "bad synthtoken https://x/?session=synthqueryvalue",
                };
          }),
          loggerFor(warnings),
        ),
      );
      handle.on((event) => events.push(event));
      emitPage(stub);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );

      emitPause(stub, "known-refusal", checkoutUrl(PLACEHOLDER_FORMS[1]));
      await waitFor(
        () => events.filter((event) => event.type === "refused").length === 1,
        "known refusal",
      );
      emitPause(stub, "custom-refusal", checkoutUrl(PLACEHOLDER_FORMS[2]));
      await waitFor(
        () => events.filter((event) => event.type === "refused").length === 2,
        "custom refusal",
      );

      expect(events).toContainEqual({
        type: "refused",
        url: ORIGIN,
        reason: "total_changed",
      });
      expect(events).toContainEqual({
        type: "refused",
        url: ORIGIN,
        reason: "unrecognized",
      });
      expect(warnings.map((warning) => warning.fields)).toEqual([
        { reason: "total_changed" },
        { reason: "unrecognized" },
      ]);
      assertNoMarkers(events);
      assertNoMarkers(warnings);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("maps custom relay failures to network and suppresses reposts after unknown", async () => {
    const stub = await startCdp();
    const events: InterceptorEvent[] = [];
    const calls: RelayRequest[] = [];
    try {
      const handle = await attachInterceptor(
        stub.url,
        attachOptions(
          stubPaymentRelay(async (request) => {
            calls.push(request);
            if (calls.length === 1) {
              throw new Error(
                `boom synthtoken ${checkoutUrl(PLACEHOLDER_FORMS[0])}`,
              );
            }
            return { outcome: "unknown" };
          }),
        ),
      );
      handle.on((event) => events.push(event));
      emitPage(stub);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );

      const failureUrl = checkoutUrl(PLACEHOLDER_FORMS[3]);
      emitPause(stub, "network-failure", failureUrl);
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "network failure",
      );
      expect(events).toContainEqual({
        type: "failed",
        url: ORIGIN,
        reason: "network",
      });

      const unknownUrl = checkoutUrl(PLACEHOLDER_FORMS[4]);
      emitPause(stub, "unknown-once", unknownUrl);
      await waitFor(
        () =>
          events.filter(
            (event) => event.type === "failed" && event.reason === "unknown",
          ).length === 1,
        "unknown outcome",
      );
      emitPause(stub, "unknown-twice", unknownUrl);
      await waitFor(
        () =>
          events.filter(
            (event) => event.type === "failed" && event.reason === "unknown",
          ).length === 2,
        "suppressed unknown outcome",
      );
      expect(calls).toHaveLength(2);
      expect(events).toContainEqual({
        type: "failed",
        url: ORIGIN,
        reason: "unknown",
      });
      assertNoMarkers(events);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("uses origin-only URLs for untracked sessions and opaque or invalid inputs", async () => {
    const stub = await startCdp();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(
        stub.url,
        attachOptions(stubPaymentRelay(async () => success())),
      );
      handle.on((event) => events.push(event));

      const urls = [
        checkoutUrl(PLACEHOLDER_FORMS[0]),
        "https://4242424242424242.example.test/x",
        "about:blank",
        "not a URL",
      ];
      for (let index = 0; index < urls.length; index++) {
        stub.emit({
          method: "Fetch.requestPaused",
          sessionId: `untracked-${index}`,
          params: {
            requestId: `req-${index}`,
            request: { url: urls[index], method: "GET" },
          },
        });
      }
      await waitFor(() => events.length === urls.length, "unknown sessions");

      expect(events).toEqual([
        {
          type: "failed",
          url: ORIGIN,
          reason: "unknown_session",
        },
        {
          type: "failed",
          url: "https://••••.example.test",
          reason: "unknown_session",
        },
        { type: "failed", url: "about:", reason: "unknown_session" },
        { type: "failed", url: "", reason: "unknown_session" },
      ]);
      assertNoMarkers(events);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("delivers a buffered intercept_unavailable event with only the target origin", async () => {
    const targetUrl = checkoutUrl(PLACEHOLDER_FORMS[0]);
    const stub = await startCdp({
      failFetch: true,
      attachOnAutoAttach: { targetId: "target-sensitive", url: targetUrl },
    });
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(
        stub.url,
        attachOptions(stubPaymentRelay(async () => success())),
      );
      handle.on((event) => events.push(event));
      expect(events).toEqual([
        {
          type: "failed",
          url: ORIGIN,
          reason: "intercept_unavailable",
        },
      ]);
      assertNoMarkers(events);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("uses origin-only URLs for relayed_unfulfilled events", async () => {
    const stub = await startCdp({ failFulfill: true });
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(
        stub.url,
        attachOptions(stubPaymentRelay(async () => success())),
      );
      handle.on((event) => events.push(event));
      emitPage(stub);
      await waitFor(
        () =>
          stub.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      emitPause(stub, "unfulfilled", checkoutUrl(PLACEHOLDER_FORMS[0]));
      await waitFor(
        () => events.some((event) => event.type === "relayed_unfulfilled"),
        "relayed_unfulfilled",
      );
      expect(events).toContainEqual({
        type: "relayed_unfulfilled",
        url: ORIGIN,
        status: 201,
      });
      assertNoMarkers(events);
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

  it("does not expose invalid URLs, transport errors, or CDP error text", async () => {
    const invalidUrlError = await captureError(
      attachInterceptor(
        "ws://synthuser:synthpass@[bad",
        attachOptions(stubPaymentRelay(async () => success())),
      ),
    );
    expect(invalidUrlError.message).toBe("CDP websocket URL is invalid");
    expect(Object.prototype.hasOwnProperty.call(invalidUrlError, "input")).toBe(
      false,
    );
    assertSafeError(invalidUrlError);

    const closed = http.createServer();
    await new Promise<void>((resolve) => {
      closed.listen(0, "127.0.0.1", resolve);
    });
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const connectError = await captureError(
      attachInterceptor(
        `ws://127.0.0.1:${closedPort}/devtools/browser/synthopaquesession?token=synthtoken`,
        attachOptions(stubPaymentRelay(async () => success())),
      ),
    );
    expect(connectError.message).toBe("CDP websocket connect failed");
    assertSafeError(connectError);

    const stub = await startCdp({
      errorOnMethod: {
        method: "Target.setAutoAttach",
        message: "synthtoken synthfragment synthqueryvalue synthopaquesession",
      },
    });
    try {
      const protocolError = await captureError(
        attachInterceptor(
          stub.url,
          attachOptions(stubPaymentRelay(async () => success())),
        ),
      );
      expect(protocolError.message).toBe("CDP Target.setAutoAttach failed");
      assertSafeError(protocolError);
    } finally {
      await stub.close();
    }
  });
});
