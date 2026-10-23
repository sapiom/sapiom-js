import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { CdpConnection } from "./cdp.js";
import { textHoldsPlaceholderNumber } from "./detect";
import type { KnownRefusalReason } from "./index";
import type { PayLogger } from "./logger";
import {
  attachInterceptor,
  KNOWN_REFUSAL_REASONS,
  type InterceptorEvent,
  type InterceptorHandle,
} from "./interceptor";
import {
  paymentIdempotencyKey,
  type RelayRequest,
  type RelayResponse,
} from "./contract";
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
  noReplyOnMethod?: string;
  attachOnAutoAttach?: { targetId: string; url: string };
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

type CdpStub = Awaited<ReturnType<typeof startCdp>>;

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
    if (options.noReplyOnMethod === message.method) return;
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

type Warning = {
  message: string;
  fields?: Parameters<PayLogger["warn"]>[1];
};

function loggerFor(warnings: Warning[]): PayLogger {
  return {
    warn(message, fields) {
      warnings.push({ message, fields });
    },
  };
}

function assertCleanText(text: string): void {
  for (const marker of MARKERS) expect(text).not.toContain(marker);
  expect(textHoldsPlaceholderNumber(text, HELD.number)).toBe(false);
}

function assertNoMarkers(value: unknown): void {
  assertCleanText(JSON.stringify(value));
}

function emitPage(stub: CdpStub) {
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
  stub: CdpStub,
  requestId: string,
  url: string,
  body: string = BODY,
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

async function captureRefusals(
  responses: RelayResponse[],
  heldNumber: string = HELD.number,
): Promise<{
  events: InterceptorEvent[];
  warnings: Warning[];
}> {
  const stub = await startCdp();
  const warnings: Warning[] = [];
  const queue = [...responses];
  try {
    const { handle, events } = await attachArmed(
      stub,
      stubPaymentRelay(async () => {
        const next = queue.shift();
        if (!next) throw new Error("unexpected relay call");
        return next;
      }),
      loggerFor(warnings),
      heldNumber,
    );
    for (let index = 0; index < responses.length; index++) {
      emitPause(
        stub,
        `refusal-${index}`,
        checkoutUrl(PLACEHOLDER_FORMS[index % PLACEHOLDER_FORMS.length]),
        `{"note":"case-${index}","held":"${heldNumber}"}`,
      );
    }
    await waitFor(
      () =>
        events.filter((event) => event.type === "refused").length ===
        responses.length,
      "refusals",
    );
    await handle.detach();
    return { events, warnings };
  } finally {
    await stub.close();
  }
}

function refusedEvents(events: InterceptorEvent[]): InterceptorEvent[] {
  return events.filter((event) => event.type === "refused");
}

function knownReasonBullets(readme: string): string[] {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim() === "### Known refusal reasons",
  );
  if (start < 0) return [];
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    const match = /^-\s+`([^`]+)`\s*$/.exec(line);
    if (match?.[1]) bullets.push(match[1]);
  }
  return bullets;
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
  heldNumber: string = HELD.number,
) {
  return {
    relay,
    placeholder: { number: heldNumber, injectionRef: HELD.injectionRef },
    profileId: "synthetic-profile",
    ...(logger ? { logger } : {}),
  };
}

/** Attaches, records events, and waits until the page session is armed. */
async function attachArmed(
  stub: CdpStub,
  relay: ReturnType<typeof stubPaymentRelay>,
  logger?: PayLogger,
  heldNumber: string = HELD.number,
): Promise<{ handle: InterceptorHandle; events: InterceptorEvent[] }> {
  const events: InterceptorEvent[] = [];
  const handle = await attachInterceptor(
    stub.url,
    attachOptions(relay, logger, heldNumber),
  );
  handle.on((event) => events.push(event));
  emitPage(stub);
  await waitFor(
    () => stub.commands.some((command) => command.method === "Fetch.enable"),
    "Fetch.enable",
  );
  return { handle, events };
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
  for (const value of values) assertCleanText(value);
}

describe("interceptor event redaction", () => {
  it("emits only origins for every held URL form and relays the raw request unchanged", async () => {
    const stub = await startCdp();
    const calls: RelayRequest[] = [];
    const warnings: Warning[] = [];
    try {
      const { handle, events } = await attachArmed(
        stub,
        stubPaymentRelay(async (request) => {
          calls.push(request);
          return success();
        }),
        loggerFor(warnings),
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
          paymentIdempotencyKey("POST", rawUrl, BODY),
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
    const warnings: Warning[] = [];
    let calls = 0;
    try {
      const { handle, events } = await attachArmed(
        stub,
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

  it("passes a code-shaped reason through and replaces any other shape", async () => {
    const cases: Array<[string, string]> = [
      ["future_reason", "future_reason"],
      ["a".repeat(48), "a".repeat(48)],
      ["a".repeat(49), "unrecognized"],
      ["reason2", "unrecognized"],
      ["a:b", "unrecognized"],
      ["a/b", "unrecognized"],
      ["a.b", "unrecognized"],
      ["a b", "unrecognized"],
      ["Total_changed", "unrecognized"],
    ];
    const { events, warnings } = await captureRefusals(
      cases.map(([reason]) => ({ outcome: "refused", reason })),
    );
    expect(refusedEvents(events)).toStrictEqual(
      cases.map(([, reason]) => ({
        type: "refused",
        url: ORIGIN,
        reason,
      })),
    );
    expect(warnings).toStrictEqual(
      cases.map(([, reason]) => ({
        message: "payment relay refused the paused request",
        fields: { reason },
      })),
    );
    assertNoMarkers(events);
    assertNoMarkers(warnings);
  });

  it("copies retryable true and false, and omits it when the relay did not send it", async () => {
    const { events, warnings } = await captureRefusals([
      { outcome: "refused", reason: "total_changed", retryable: true },
      { outcome: "refused", reason: "total_changed", retryable: false },
      { outcome: "refused", reason: "total_changed" },
    ]);
    const refused = refusedEvents(events);
    expect(refused).toStrictEqual([
      {
        type: "refused",
        url: ORIGIN,
        reason: "total_changed",
        retryable: true,
      },
      {
        type: "refused",
        url: ORIGIN,
        reason: "total_changed",
        retryable: false,
      },
      { type: "refused", url: ORIGIN, reason: "total_changed" },
    ]);
    expect("retryable" in refused[2]).toBe(false);
    expect(warnings.map((warning) => warning.fields)).toStrictEqual([
      { reason: "total_changed" },
      { reason: "total_changed" },
      { reason: "total_changed" },
    ]);
    assertNoMarkers(events);
    assertNoMarkers(warnings);
  });

  it("keeps a safe requestId and omits a missing or unsafe one", async () => {
    const kept = "req_123456789012";
    const { events, warnings } = await captureRefusals([
      {
        outcome: "refused",
        reason: "sapiom_error",
        requestId: "req_future",
      },
      { outcome: "refused", reason: "sapiom_error" },
      {
        outcome: "refused",
        reason: "sapiom_error",
        requestId: kept,
      },
      {
        outcome: "refused",
        reason: "sapiom_error",
        requestId: "4000_0000_0000_0002",
      },
      {
        outcome: "refused",
        reason: "sapiom_error",
        requestId: "1234567890123",
      },
    ]);
    const refused = refusedEvents(events);
    expect(refused).toStrictEqual([
      {
        type: "refused",
        url: ORIGIN,
        reason: "sapiom_error",
        requestId: "req_future",
      },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      {
        type: "refused",
        url: ORIGIN,
        reason: "sapiom_error",
        requestId: kept,
      },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
    ]);
    expect("requestId" in refused[1]).toBe(false);
    expect("requestId" in refused[3]).toBe(false);
    expect("requestId" in refused[4]).toBe(false);
    expect(warnings.map((warning) => warning.fields)).toStrictEqual([
      { reason: "sapiom_error" },
      { reason: "sapiom_error" },
      { reason: "sapiom_error" },
      { reason: "sapiom_error" },
      { reason: "sapiom_error" },
    ]);
    assertNoMarkers(events);
    assertNoMarkers(warnings);
  });

  it("passes every listed reason except relay_in_progress through unchanged", async () => {
    const reasons = KNOWN_REFUSAL_REASONS.filter(
      (reason) => reason !== "relay_in_progress",
    );
    const { events } = await captureRefusals(
      reasons.map((reason) => ({ outcome: "refused", reason })),
    );
    expect(
      refusedEvents(events).map((event) =>
        event.type === "refused" ? event.reason : "",
      ),
    ).toEqual([...reasons]);
  });

  it("omits a requestId that contains the held placeholder", async () => {
    const number = "tok4242";
    const { events, warnings } = await captureRefusals(
      [
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "id_tok4242",
        },
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "tok-4242",
        },
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "id_tok_4242",
        },
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "550e8400-e29b-41d4-a716-446655440000",
        },
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "a".repeat(64),
        },
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "a".repeat(65),
        },
        {
          outcome: "refused",
          reason: "sapiom_error",
          requestId: "4242_4242_4242_4242",
        },
      ],
      number,
    );
    expect(refusedEvents(events)).toStrictEqual([
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      {
        type: "refused",
        url: ORIGIN,
        reason: "sapiom_error",
        requestId: "550e8400-e29b-41d4-a716-446655440000",
      },
      {
        type: "refused",
        url: ORIGIN,
        reason: "sapiom_error",
        requestId: "a".repeat(64),
      },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
    ]);
    expect(JSON.stringify(events)).not.toContain(number);
    expect(warnings).toStrictEqual(
      Array.from({ length: 7 }, () => ({
        message: "payment relay refused the paused request",
        fields: { reason: "sapiom_error" },
      })),
    );
  });

  it("omits a requestId that hides held digits behind other separators", async () => {
    const number = "4242.4242.4242.4242";
    const leaked = "req_4242_4242_4242_4242";
    const { events } = await captureRefusals(
      [{ outcome: "refused", reason: "sapiom_error", requestId: leaked }],
      number,
    );
    expect(refusedEvents(events)).toStrictEqual([
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
    ]);
    expect(JSON.stringify(events)).not.toContain("4242424242424242");
    expect(JSON.stringify(events)).not.toContain(leaked);
  });

  it("drops a 13 to 19 digit collapse and keeps a longer one", async () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    const nineteen = "1234_5678_9012_3456_789";
    const twenty = "1234_5678_9012_3456_7890";
    const { events } = await captureRefusals([
      { outcome: "refused", reason: "sapiom_error", requestId: nineteen },
      { outcome: "refused", reason: "sapiom_error", requestId: twenty },
      { outcome: "refused", reason: "sapiom_error", requestId: nil },
    ]);
    expect(refusedEvents(events)).toStrictEqual([
      { type: "refused", url: ORIGIN, reason: "sapiom_error" },
      {
        type: "refused",
        url: ORIGIN,
        reason: "sapiom_error",
        requestId: twenty,
      },
      { type: "refused", url: ORIGIN, reason: "sapiom_error", requestId: nil },
    ]);
  });

  it("drops a hostile custom relay body, request id, and retryable before the listener", async () => {
    const hostile = {
      outcome: "refused",
      reason: "future_reason",
      retryable: "true",
      requestId: "https://x/?session=synthqueryvalue",
      body: HELD.number,
    } as unknown as RelayResponse;
    const { events, warnings } = await captureRefusals([hostile]);
    const refused = refusedEvents(events);
    expect(refused).toStrictEqual([
      { type: "refused", url: ORIGIN, reason: "future_reason" },
    ]);
    expect("body" in refused[0]).toBe(false);
    expect("requestId" in refused[0]).toBe(false);
    expect("retryable" in refused[0]).toBe(false);
    expect(warnings).toStrictEqual([
      {
        message: "payment relay refused the paused request",
        fields: { reason: "future_reason" },
      },
    ]);
    assertNoMarkers(events);
    assertNoMarkers(warnings);
  });

  it("lists known refusal reasons in the README in array order", () => {
    const readme = readFileSync(
      path.join(__dirname, "..", "README.md"),
      "utf8",
    );
    const listed: readonly KnownRefusalReason[] = KNOWN_REFUSAL_REASONS;
    expect(knownReasonBullets(readme)).toEqual([...listed]);
  });

  it("uses origin-only URLs for network and unknown failures", async () => {
    const stub = await startCdp();
    let calls = 0;
    try {
      const { handle, events } = await attachArmed(
        stub,
        stubPaymentRelay(async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error(
              `boom synthtoken ${checkoutUrl(PLACEHOLDER_FORMS[0])}`,
            );
          }
          return { outcome: "unknown" };
        }),
      );

      emitPause(stub, "network-failure", checkoutUrl(PLACEHOLDER_FORMS[3]));
      await waitFor(
        () => events.some((event) => event.type === "failed"),
        "network failure",
      );
      expect(events).toContainEqual({
        type: "failed",
        url: ORIGIN,
        reason: "network",
      });

      emitPause(stub, "unknown", checkoutUrl(PLACEHOLDER_FORMS[4]));
      await waitFor(
        () =>
          events.some(
            (event) => event.type === "failed" && event.reason === "unknown",
          ),
        "unknown outcome",
      );
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
    try {
      const { handle, events } = await attachArmed(
        stub,
        stubPaymentRelay(async () => success()),
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

  it("does not expose an invalid CDP websocket URL", async () => {
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
  });

  it("does not expose transport details when the connect fails", async () => {
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
  });

  it("does not expose CDP error text", async () => {
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
      expect(protocolError.message).toBe("CDP command failed");
      assertSafeError(protocolError);
    } finally {
      await stub.close();
    }
  });

  it("uses generic errors for secret-bearing CDP methods", async () => {
    const method = "Synthetic.method?token=SYNTHETIC_METHOD_SECRET_1";
    const errorStub = await startCdp({
      errorOnMethod: {
        method,
        message: "SYNTHETIC_METHOD_SECRET_1 peer rejected command",
      },
    });
    const errorConnection = await CdpConnection.connect(errorStub.url);
    try {
      const error = await captureError(
        errorConnection.send(method, {}, undefined, 1_000),
      );
      expect(error.message).toBe("CDP command failed");
      expect(error.message).not.toContain("SYNTHETIC_METHOD_SECRET");
    } finally {
      errorConnection.close();
      await errorStub.close();
    }

    const timeoutStub = await startCdp({ noReplyOnMethod: method });
    const timeoutConnection = await CdpConnection.connect(timeoutStub.url);
    try {
      const error = await captureError(
        timeoutConnection.send(method, {}, undefined, 10),
      );
      expect(error.message).toBe("CDP command timed out");
      expect(error.message).not.toContain("SYNTHETIC_METHOD_SECRET");
    } finally {
      timeoutConnection.close();
      await timeoutStub.close();
    }
  });
});
