import { EventEmitter } from "node:events";
import type { Response as ExpressResponse } from "express";
import { afterEach, expect, it, vi } from "vitest";
import type { HostedOpenCode } from "../core/opencode-host.js";
import { readOpenCodeEvents, streamOpenCodeEvents } from "./opencode-events.js";

const aborts: AbortController[] = [];
afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const event = (type = "session.idle", sessionID = "ses_a") => ({
  type,
  properties: { sessionID },
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function fixture() {
  const abort = new AbortController();
  aborts.push(abort);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  const status = deferred<Record<string, unknown>>();
  const fetch = vi.fn(async () => response);
  const fetchJson = vi.fn(
    (_path: string, _options?: RequestInit) => status.promise,
  );
  const close = vi.fn();
  let current = true;
  const hosted = {
    cwd: "/workspace",
    isCurrent: () => current,
    signal: abort.signal,
    server: { fetch, fetchJson, close },
  } as unknown as HostedOpenCode;
  const raw = (text: string) =>
    controller.enqueue(new TextEncoder().encode(text));
  return {
    abort,
    body,
    response,
    hosted,
    fetch,
    fetchJson,
    close,
    cancel,
    status,
    raw,
    send: (value: unknown) => raw(frame(value)),
    end: () => controller.close(),
    bytes: (value: Uint8Array) => controller.enqueue(value),
    retire: () => {
      current = false;
    },
    read: (onOpen?: () => void) =>
      readOpenCodeEvents(hosted, "ses_a", abort.signal, onOpen),
  };
}
async function collect(iterator: AsyncIterable<Record<string, unknown>>) {
  const values = [];
  for await (const value of iterator) values.push(value);
  return values;
}
function browser() {
  const res = new EventEmitter();
  const write = vi.fn((_chunk: string) => true);
  const end = vi.fn();
  Object.assign(res, {
    write,
    end,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    destroyed: false,
    writableEnded: false,
  });
  return { res: res as unknown as ExpressResponse, write, end };
}

it("opens lazily after successful response validation and never reads snapshots itself", async () => {
  const f = fixture();
  const opening = deferred<Response>();
  f.fetch.mockReturnValueOnce(opening.promise);
  const onOpen = vi.fn();
  const iterator = f.read(onOpen);
  expect(f.fetch).not.toHaveBeenCalled();
  const first = iterator.next();
  expect(onOpen).not.toHaveBeenCalled();
  opening.resolve(f.response);
  f.send({ type: "server.connected" });
  expect(await first).toMatchObject({ value: { type: "server.connected" } });
  expect(onOpen).toHaveBeenCalledOnce();
  expect(f.fetch).toHaveBeenCalledWith(
    "/event",
    expect.objectContaining({ signal: f.abort.signal }),
  );
  expect(f.fetchJson).not.toHaveBeenCalled();
  await iterator.return();
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.body.locked).toBe(false);
  expect(f.close).not.toHaveBeenCalled();
  expect(f.abort.signal.aborted).toBe(false);
});

it.each(["status", "type", "body", "aborted"])(
  "rejects invalid open: %s",
  async (kind) => {
    const f = fixture();
    const onOpen = vi.fn();
    if (kind === "status")
      f.fetch.mockResolvedValueOnce(new Response(f.body, { status: 500 }));
    if (kind === "type") f.fetch.mockResolvedValueOnce(new Response(f.body));
    if (kind === "body") f.fetch.mockResolvedValueOnce(new Response(null));
    if (kind === "aborted") f.abort.abort(new Error("already stopped"));
    await expect(f.read(onOpen).next()).rejects.toThrow();
    expect(onOpen).not.toHaveBeenCalled();
    if (kind === "status" || kind === "type")
      expect(f.cancel).toHaveBeenCalledOnce();
    if (kind === "aborted") expect(f.fetch).not.toHaveBeenCalled();
  },
);

it("decodes split UTF-8 and CRLF, multiline data, comments and ordered buffered frames", async () => {
  const f = fixture();
  const value = {
    ...event(),
    properties: { sessionID: "ses_a", title: "Hello 🌎" },
  };
  const bytes = new TextEncoder().encode(
    `: heartbeat\r\n\r\n${frame(value).replace(/\n/g, "\r\n")}`,
  );
  const split = bytes.indexOf(0xf0) + 2;
  f.bytes(bytes.slice(0, split));
  f.bytes(bytes.slice(split, -1));
  f.bytes(bytes.slice(-1));
  f.raw(
    JSON.stringify(event("session.status"), null, 2)
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n") + "\n\n",
  );
  f.end();
  expect(await collect(f.read())).toEqual([value, event("session.status")]);
  expect(f.body.locked).toBe(false);
});

it.each(["complete", "incomplete", "invalid-json"])(
  "rejects a bounded malformed frame: %s",
  async (kind) => {
    const f = fixture();
    f.raw(
      kind === "invalid-json"
        ? "data: nope\n\n"
        : "data: " +
            "x".repeat(2 * 1024 * 1024) +
            (kind === "complete" ? "\n\n" : ""),
    );
    await expect(f.read().next()).rejects.toThrow(
      kind === "invalid-json" ? undefined : "too large",
    );
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
  },
);

it("discards an unterminated frame at EOF", async () => {
  const f = fixture();
  f.raw(frame(event()).trimEnd());
  f.end();
  expect(await collect(f.read())).toEqual([]);
});

it("scopes every buffered event and rechecks hosted authority after yield", async () => {
  const f = fixture();
  f.raw(
    frame(event("session.idle", "ses_b")) +
      frame(event()) +
      frame(event("session.status")),
  );
  const iterator = f.read();
  expect((await iterator.next()).value).toEqual(event());
  f.retire();
  f.end();
  expect((await iterator.next()).done).toBe(true);
});

it("ends after one sanitized authentication event", async () => {
  const f = fixture();
  f.raw(
    frame({
      type: "session.error",
      properties: {
        sessionID: "ses_a",
        error: {
          name: "ProviderAuthError",
          data: { providerID: "sapiom", message: "private" },
        },
      },
    }) + frame(event()),
  );
  const result = await collect(f.read());
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    type: "studio.error",
    properties: { code: "authentication_required" },
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(f.cancel).toHaveBeenCalledOnce();
});

it.each(["read", "open-callback"])(
  "cleans up a failed consumer lifetime: %s",
  async (kind) => {
    const f = fixture();
    const failure = new Error("consumer stopped");
    const next = f
      .read(
        kind === "open-callback"
          ? () => {
              throw failure;
            }
          : undefined,
      )
      .next();
    const rejected = expect(next).rejects.toBe(failure);
    if (kind === "read") {
      await vi.waitFor(() => expect(f.body.locked).toBe(true));
      f.abort.abort(failure);
    }
    await rejected;
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
    expect(f.close).not.toHaveBeenCalled();
  },
);

it("paces browser writes until drain without consuming the next visible event", async () => {
  const f = fixture();
  const b = browser();
  b.write.mockReturnValueOnce(false);
  f.raw(frame(event()) + frame(event("session.status")));
  f.end();
  const task = streamOpenCodeEvents(f.hosted, "ses_a", b.res, f.abort.signal);
  await vi.waitFor(() => expect(b.write).toHaveBeenCalledOnce());
  b.res.emit("drain");
  await task;
  expect(
    b.write.mock.calls.map((call) => JSON.parse(String(call[0]).slice(6))),
  ).toEqual([event(), event("session.status")]);
  expect(b.end).toHaveBeenCalledOnce();
});

it("aborts an outstanding browser drain and closes its reader", async () => {
  const f = fixture();
  const b = browser();
  b.write.mockReturnValue(false);
  f.send(event());
  const task = streamOpenCodeEvents(f.hosted, "ses_a", b.res, f.abort.signal);
  const rejected = expect(task).rejects.toThrow();
  await vi.waitFor(() => expect(b.write).toHaveBeenCalledOnce());
  f.abort.abort();
  await rejected;
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.body.locked).toBe(false);
});

it.each(["idle", "eof", "auth", "failure"])(
  "fences the browser snapshot after %s",
  async (kind) => {
    const f = fixture();
    const b = browser();
    const task = streamOpenCodeEvents(f.hosted, "ses_a", b.res, f.abort.signal);
    await vi.waitFor(() => expect(f.fetchJson).toHaveBeenCalledOnce());
    if (kind === "idle") f.send(event());
    if (kind === "auth")
      f.send({
        type: "session.error",
        properties: {
          sessionID: "ses_a",
          error: {
            name: "ProviderAuthError",
            data: { providerID: "sapiom" },
          },
        },
      });
    if (kind === "idle" || kind === "auth")
      await vi.waitFor(() => expect(b.write).toHaveBeenCalledOnce());
    if (kind === "eof" || kind === "auth") {
      if (kind === "eof") f.end();
      await task;
      const options = f.fetchJson.mock.calls[0]?.[1] as RequestInit;
      expect(options.signal?.aborted).toBe(true);
    }
    if (kind === "failure") f.status.reject(new Error("read failed"));
    else f.status.resolve({ ses_a: { type: "busy" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (kind === "idle" || kind === "failure") {
      f.end();
      await task;
    }
    expect(b.write).toHaveBeenCalledTimes(
      kind === "idle" || kind === "auth" ? 1 : 0,
    );
  },
);
