import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  paymentIdempotencyKey,
  type RelayRequest,
  type RelayResponse,
} from "./contract";
import { attachInterceptor, type InterceptorEvent } from "./interceptor";
import { httpPaymentRelay } from "./relay";

const HELD = {
  number: "4242424242424242",
  injectionRef: "inj_in_progress",
};

const CHECKOUT_URL = "https://checkout.example/sessions";

const CARD = JSON.stringify({
  credit_card: {
    number: HELD.number,
    month: 12,
    year: 2028,
    verification_value: "123",
  },
});

const TRANSACTION_ID = "tx_in_progress";
const RELAY_PATH = `/v1/transactions/${TRANSACTION_ID}/payment/relay`;

const RELAYED = {
  outcome: "relayed" as const,
  response: {
    status: 201,
    headers: { "content-type": "application/json" },
    body: '{"id":"sess"}',
  },
};

const IN_PROGRESS: RelayResponse = {
  outcome: "refused",
  reason: "relay_in_progress",
};

interface Command {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface SeenPost {
  method: string;
  url: string;
  idempotencyKey: string;
  requestBody: string;
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

async function startCdp(): Promise<{
  url: string;
  commands: Command[];
  emit: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
}> {
  const commands: Command[] = [];
  let socket: Duplex | undefined;
  const chunks: Buffer[] = [];
  let buffered = 0;

  const reply = (id: number, result: unknown) => {
    socket?.write(serverFrame(JSON.stringify({ id, result })));
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
    if (message.method === "Target.getTargets") {
      reply(message.id, { targetInfos: [] });
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

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
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

function startRelay(script: RelayResponse[] = [IN_PROGRESS, RELAYED]): Promise<{
  origin: string;
  posts: SeenPost[];
  close: () => Promise<void>;
}> {
  const posts: SeenPost[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as RelayRequest;
      posts.push({
        method: req.method ?? "",
        url: req.url ?? "",
        idempotencyKey: body.idempotencyKey,
        requestBody: body.request.body,
      });
      const payload = script[Math.min(posts.length, script.length) - 1];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        posts,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
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

function count(commands: Command[], method: string): number {
  return commands.filter((command) => command.method === method).length;
}

describe("relay_in_progress", () => {
  it("holds the pause, posts the same idempotency key again, and fulfills", async () => {
    const idempotencyKey = paymentIdempotencyKey("POST", CHECKOUT_URL, CARD);
    const cdp = await startCdp();
    const relay = await startRelay();
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
    });
    try {
      cdp.emit({
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
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      cdp.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-in-progress",
          request: {
            url: CHECKOUT_URL,
            method: "POST",
            headers: { "content-type": "application/json" },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () =>
          cdp.commands.some(
            (command) =>
              command.method === "Fetch.fulfillRequest" ||
              command.method === "Fetch.failRequest",
          ),
        "Fetch settlement",
      );
      expect({
        relayPosts: relay.posts,
        fetch: {
          failRequest: count(cdp.commands, "Fetch.failRequest"),
          fulfillRequest: count(cdp.commands, "Fetch.fulfillRequest"),
          continueRequest: count(cdp.commands, "Fetch.continueRequest"),
        },
      }).toEqual({
        relayPosts: [
          {
            method: "POST",
            url: RELAY_PATH,
            idempotencyKey,
            requestBody: CARD,
          },
          {
            method: "POST",
            url: RELAY_PATH,
            idempotencyKey,
            requestBody: CARD,
          },
        ],
        fetch: {
          failRequest: 0,
          fulfillRequest: 1,
          continueRequest: 0,
        },
      });
      const fulfilled = cdp.commands.find(
        (command) => command.method === "Fetch.fulfillRequest",
      );
      expect(fulfilled?.params.responseCode).toBe(201);
      expect(fulfilled?.params.body).toBe(
        Buffer.from(RELAYED.response.body, "utf8").toString("base64"),
      );
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });

  it("fails with timeout when relay_in_progress outlasts the deadline", async () => {
    const idempotencyKey = paymentIdempotencyKey("POST", CHECKOUT_URL, CARD);
    const cdp = await startCdp();
    const relay = await startRelay([IN_PROGRESS]);
    const events: InterceptorEvent[] = [];
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
      timeoutMs: 700,
    });
    handle.on((event) => events.push(event));
    try {
      cdp.emit({
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
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      cdp.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-deadline",
          request: {
            url: CHECKOUT_URL,
            method: "POST",
            headers: { "content-type": "application/json" },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "timeout",
      );
      expect(relay.posts.length).toBeGreaterThanOrEqual(2);
      expect(relay.posts.length).toBeLessThanOrEqual(6);
      expect(
        relay.posts.every((post) => post.idempotencyKey === idempotencyKey),
      ).toBe(true);
      expect(count(cdp.commands, "Fetch.failRequest")).toBe(1);
      expect(count(cdp.commands, "Fetch.fulfillRequest")).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failed", reason: "timeout" }),
      );
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });

  it("fails a terminal refusal after relay_in_progress", async () => {
    const idempotencyKey = paymentIdempotencyKey("POST", CHECKOUT_URL, CARD);
    const cdp = await startCdp();
    const relay = await startRelay([
      IN_PROGRESS,
      { outcome: "refused", reason: "total_changed" },
    ]);
    const events: InterceptorEvent[] = [];
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
    });
    handle.on((event) => events.push(event));
    try {
      cdp.emit({
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
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      cdp.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-refused",
          request: {
            url: CHECKOUT_URL,
            method: "POST",
            headers: { "content-type": "application/json" },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "refused"),
        "refused",
      );
      expect(relay.posts).toEqual([
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
      ]);
      expect(count(cdp.commands, "Fetch.failRequest")).toBe(1);
      expect(count(cdp.commands, "Fetch.fulfillRequest")).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "refused", reason: "total_changed" }),
      );
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });

  it("remembers unknown after relay_in_progress and does not post it again", async () => {
    const idempotencyKey = paymentIdempotencyKey("POST", CHECKOUT_URL, CARD);
    const cdp = await startCdp();
    const relay = await startRelay([IN_PROGRESS, { outcome: "unknown" }]);
    const events: InterceptorEvent[] = [];
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
    });
    handle.on((event) => events.push(event));
    try {
      cdp.emit({
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
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      cdp.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-unknown",
          request: {
            url: CHECKOUT_URL,
            method: "POST",
            headers: { "content-type": "application/json" },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "unknown",
      );
      cdp.emit({
        method: "Fetch.requestPaused",
        sessionId: "page-1",
        params: {
          requestId: "req-unknown-again",
          request: {
            url: CHECKOUT_URL,
            method: "POST",
            headers: { "content-type": "application/json" },
            postData: CARD,
          },
        },
      });
      await waitFor(
        () => count(cdp.commands, "Fetch.failRequest") === 2,
        "second fail",
      );
      expect(relay.posts).toEqual([
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
      ]);
      expect(count(cdp.commands, "Fetch.fulfillRequest")).toBe(0);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failed", reason: "unknown" }),
      );
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });

  it("shares one poll when a second pause arrives during backoff", async () => {
    const idempotencyKey = paymentIdempotencyKey("POST", CHECKOUT_URL, CARD);
    const cdp = await startCdp();
    const relay = await startRelay();
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
    });
    try {
      armPage(cdp);
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      emitPaused(cdp, "req-first");
      await waitFor(() => relay.posts.length === 1, "first post");
      emitPaused(cdp, "req-second");
      await waitFor(
        () => count(cdp.commands, "Fetch.fulfillRequest") === 2,
        "both fulfilled",
      );
      expect(relay.posts).toEqual([
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
      ]);
      expect(count(cdp.commands, "Fetch.failRequest")).toBe(0);
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });

  it("does not post a key again after an overlapping pause sees unknown", async () => {
    const idempotencyKey = paymentIdempotencyKey("POST", CHECKOUT_URL, CARD);
    const cdp = await startCdp();
    const relay = await startRelay([IN_PROGRESS, { outcome: "unknown" }]);
    const events: InterceptorEvent[] = [];
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
    });
    handle.on((event) => events.push(event));
    try {
      armPage(cdp);
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      emitPaused(cdp, "req-unknown-a");
      await waitFor(() => relay.posts.length === 1, "first post");
      emitPaused(cdp, "req-unknown-b");
      await waitFor(
        () =>
          events.filter(
            (event) => event.type === "failed" && event.reason === "unknown",
          ).length === 2,
        "both unknown",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.posts).toEqual([
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
        {
          method: "POST",
          url: RELAY_PATH,
          idempotencyKey,
          requestBody: CARD,
        },
      ]);
      expect(count(cdp.commands, "Fetch.failRequest")).toBe(2);
      expect(count(cdp.commands, "Fetch.fulfillRequest")).toBe(0);
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });

  it("stops polling when detach happens during backoff", async () => {
    const cdp = await startCdp();
    const relay = await startRelay([IN_PROGRESS]);
    const events: InterceptorEvent[] = [];
    const handle = await attachInterceptor(cdp.url, {
      relay: httpPaymentRelay({
        baseUrl: relay.origin,
        apiKey: "test-key",
        transactionId: TRANSACTION_ID,
      }),
      placeholder: HELD,
      profileId: "shopify-card-vault",
    });
    handle.on((event) => events.push(event));
    try {
      armPage(cdp);
      await waitFor(
        () => cdp.commands.some((command) => command.method === "Fetch.enable"),
        "Fetch.enable",
      );
      emitPaused(cdp, "req-detach");
      await waitFor(() => relay.posts.length === 1, "first post");
      const started = Date.now();
      await handle.detach();
      await waitFor(
        () =>
          events.some(
            (event) => event.type === "failed" && event.reason === "detached",
          ),
        "detached",
      );
      expect(Date.now() - started).toBeLessThan(150);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.posts).toHaveLength(1);
    } finally {
      await handle.detach();
      await cdp.close();
      await relay.close();
    }
  });
});

function armPage(cdp: {
  emit: (event: Record<string, unknown>) => void;
}): void {
  cdp.emit({
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

function emitPaused(
  cdp: { emit: (event: Record<string, unknown>) => void },
  requestId: string,
): void {
  cdp.emit({
    method: "Fetch.requestPaused",
    sessionId: "page-1",
    params: {
      requestId,
      request: {
        url: CHECKOUT_URL,
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: CARD,
      },
    },
  });
}
