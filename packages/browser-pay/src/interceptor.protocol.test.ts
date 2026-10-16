import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { paymentIdempotencyKey } from "./contract";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import type { PayLogger } from "./logger";
import { stubPaymentRelay, type RelayCallOptions } from "./relay";
import type { HeldPlaceholder, RelayRequest, RelayResponse } from "./index";

const HELD: HeldPlaceholder = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2028,
  cvc: "123",
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

interface StubOptions {
  failFetch?: boolean;
  failFulfill?: boolean;
  postData?: string;
  postDataError?: boolean;
  targets?: { targetId: string; type: string; url: string }[];
  attachedSessionId?: string;
  languages?: string[];
  cookies?: { name: string; value: string }[];
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
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}> {
  const commands: Command[] = [];
  let socket: Duplex | undefined;
  const chunks: Buffer[] = [];
  let buffered = 0;

  const reply = (id: number, result: unknown, error?: { message: string }) => {
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
    if (message.method === "Fetch.enable" && options.failFetch) {
      reply(message.id, undefined, { message: "Fetch is unsupported" });
      return;
    }
    if (message.method === "Target.getTargets") {
      reply(message.id, { targetInfos: options.targets ?? [] });
      return;
    }
    if (message.method === "Target.attachToTarget") {
      reply(message.id, {
        sessionId: options.attachedSessionId ?? "iframe-existing",
      });
      return;
    }
    if (message.method === "Runtime.evaluate") {
      const expression = message.params?.expression;
      if (expression === "navigator.languages") {
        reply(message.id, {
          result: { value: options.languages ?? ["en-US", "en"] },
        });
        return;
      }
      reply(message.id, {});
      return;
    }
    if (message.method === "Network.getCookies") {
      reply(message.id, { cookies: options.cookies ?? [] });
      return;
    }
    if (message.method === "Fetch.getRequestPostData") {
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

  await awaitListen(server);
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    commands,
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
  kind: "relayed",
  status: 201,
  headers: [["content-type", "application/json"]],
  body: '{"id":"sess"}',
  bodyEncoding: "utf8",
});

function header(
  headers: RelayRequest["headers"],
  name: string,
): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

describe("interceptor CDP decisions", () => {
  it("does not resume a target whose Fetch.enable failed", async () => {
    const stub = await startStub({ failFetch: true });
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        transactionId: "tx",
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
      expect(events).toContainEqual({
        type: "failed",
        url: "https://shop.example/checkout",
        reason: "intercept_unavailable",
      });
      await handle.detach();
    } finally {
      await stub.close();
    }
  });

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
        transactionId: "tx",
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
      expect(
        stub.commands.some(
          (command) => command.method === "Fetch.getRequestPostData",
        ),
      ).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toBe(CARD);
      expect(calls[0].idempotencyKey).toBe(
        paymentIdempotencyKey("POST", calls[0].url, CARD),
      );
      expect(header(calls[0].headers, "content-type")).toBe("application/json");
      expect(header(calls[0].headers, "sec-fetch-site")).toBe("cross-site");
      expect(header(calls[0].headers, "sec-fetch-dest")).toBe("empty");
      expect(header(calls[0].headers, "accept-language")).toBe(
        "en-US,en;q=0.9",
      );
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
        transactionId: "tx",
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

  it("fails a request whose URL holds the placeholder even when the body does not", async () => {
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
        transactionId: "tx",
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
            url: `https://checkout.example/pay?number=${HELD.number}`,
            method: "POST",
            postData: '{"event":"ping"}',
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "failed",
      );
      expect(calls).toHaveLength(0);
      expect(events[0]).toMatchObject({
        type: "failed",
        reason: "placeholder_mismatch",
      });
      expect(JSON.stringify(events)).not.toContain(HELD.number);
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
        transactionId: "tx",
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
      expect(calls[0].body).toBe(multipart);
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
        transactionId: "tx",
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
        transactionId: "tx",
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

  it("does not fulfill a response that contains a different card number", async () => {
    const stub = await startStub();
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => ({
          kind: "relayed",
          status: 200,
          headers: [["content-type", "text/plain"]],
          body: "4111111111111111",
          bodyEncoding: "utf8",
        })),
        placeholder: HELD,
        transactionId: "tx",
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
        () => events.some((event) => event.type === "failed"),
        "failed",
      );
      expect(events.map((event) => event.type)).toEqual(["paused", "failed"]);
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

  it("continues an unrelated GET without reading a body, and keeps one session per target", async () => {
    const stub = await startStub();
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => success()),
        placeholder: HELD,
        transactionId: "tx",
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
          (command) => command.method === "Fetch.getRequestPostData",
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
        transactionId: "tx",
        pauseOnlyUrls: ["checkout.pci.shopifyinc.com"],
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
        transactionId: "tx",
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
      expect(
        stub.commands.some(
          (command) =>
            command.method === "Fetch.failRequest" &&
            command.sessionId === "missing-session" &&
            command.params.requestId === "req-unknown",
        ),
      ).toBe(true);
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
    const logger: PayLogger = {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    };
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async () => {
          calls += 1;
          if (calls === 1) await gate;
          return { kind: "refused", reason: "already_relayed" };
        }),
        placeholder: HELD,
        transactionId: "tx",
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
      await waitFor(
        () =>
          stub.commands.filter(
            (command) => command.method === "Fetch.failRequest",
          ).length >= 2,
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

  it("copies a missing Cookie the way Chrome would", async () => {
    const stub = await startStub({
      cookies: [{ name: "cart", value: "1" }],
    });
    const calls: RelayRequest[] = [];
    const events: InterceptorEvent[] = [];
    try {
      const handle = await attachInterceptor(stub.url, {
        relay: stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        placeholder: HELD,
        transactionId: "tx",
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
            headers: { "Sec-Fetch-Site": "same-origin" },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "relayed"),
        "relayed",
      );
      expect(header(calls[0].headers, "sec-fetch-site")).toBe("same-origin");
      expect(header(calls[0].headers, "cookie")).toBe("cart=1");
      expect(header(calls[0].headers, "sec-fetch-dest")).toBe("empty");
      await handle.detach();
    } finally {
      await stub.close();
    }
  });
});
