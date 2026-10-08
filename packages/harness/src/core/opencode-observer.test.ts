import { afterEach, expect, it, vi } from "vitest";
import type { HostedOpenCode } from "./opencode-host.js";
import type { AssistantObservation } from "../shared/assistant-state.js";
import { OpenCodeObserver } from "./opencode-observer.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const wait = (check: () => void) =>
  vi.waitFor(check, { interval: 10, timeout: 2500 });
function fixture() {
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const data = new Map<string, unknown>([
    ["/session/ses_a", { id: "ses_a" }],
    ["/session/ses_b", { id: "ses_b" }],
    ["/session/status", { ses_a: { type: "busy" }, ses_b: { type: "idle" } }],
    ["/permission", []],
    ["/question", []],
  ]);
  const streams: Array<{
    send(value: unknown): void;
    end(): void;
    cancelled: boolean;
  }> = [];
  const queued = new Map<string, Array<Promise<Response>>>();
  const fetch = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === "/event") {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = {
        cancelled: false,
        send(value: unknown) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`),
          );
        },
        end() {
          controller.close();
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          stream.cancelled = true;
        },
      });
      streams.push(stream);
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return queued.get(path)?.shift() ?? json(data.get(path));
  });
  let current = true;
  const close = vi.fn();
  const hosted = {
    harnessSessionId: "studio-a",
    cwd: "/same-folder",
    signal: abort.signal,
    isCurrent: () => current,
    server: { fetch, close },
  } as unknown as HostedOpenCode;
  const updates: AssistantObservation[] = [];
  const observer = new OpenCodeObserver(hosted, "ses_a", (state) =>
    updates.push(state),
  );
  cleanups.push(observer.dispose);
  return {
    observer,
    hosted,
    fetch,
    close,
    data,
    streams,
    updates,
    abort,
    retire: () => {
      current = false;
    },
    send(
      type: string,
      properties: Record<string, unknown> = {},
      index = streams.length - 1,
    ) {
      streams[index]!.send({
        type,
        properties: { sessionID: "ses_a", ...properties },
      });
    },
    hold(path: string) {
      let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      queued.set(path, [...(queued.get(path) ?? []), promise]);
      return resolve;
    },
    async start() {
      observer.start();
      await wait(() => expect(observer.getState().freshness).toBe("current"));
    },
  };
}

it("is lazy, observes only native reads, and coalesces duplicate starts and irrelevant events", async () => {
  const f = fixture();
  expect(f.observer.getState()).toEqual({
    activity: "unknown",
    pendingPermissions: null,
    pendingQuestions: null,
    freshness: "connecting",
  });
  expect(f.fetch).not.toHaveBeenCalled();
  await f.start();
  f.observer.start();
  const before = f.updates.length;
  f.send("server.heartbeat");
  f.send("message.part.delta", {
    messageID: "msg_a",
    partID: "part_a",
    delta: "private text",
  });
  f.send("session.status", { status: { type: "busy" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.updates).toHaveLength(before);
  expect(f.fetch.mock.calls.map((call) => call[0]).sort()).toEqual([
    "/event",
    "/permission",
    "/question",
    "/session/ses_a",
    "/session/status",
  ]);
  expect(f.fetch.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  expect(JSON.stringify(f.updates)).not.toContain("private text");
  expect(f.close).not.toHaveBeenCalled();
});

it("lets newer status and request events win over in-flight snapshots", async () => {
  const f = fixture();
  const status = f.hold("/session/status");
  const permission = f.hold("/permission");
  const question = f.hold("/question");
  f.observer.start();
  await wait(() => expect(f.fetch).toHaveBeenCalledTimes(5));
  f.send("session.idle");
  f.send("permission.asked", { id: "new" });
  f.send("permission.replied", { requestID: "old" });
  f.send("question.asked", { id: "new-question" });
  f.send("question.rejected", { requestID: "old-question" });
  await wait(() => expect(f.observer.getState().activity).toBe("idle"));
  status(json({ ses_a: { type: "busy" } }));
  permission(
    json([
      { id: "old", sessionID: "ses_a" },
      { id: "foreign", sessionID: "ses_b" },
    ]),
  );
  question(json([{ id: "old-question", sessionID: "ses_a" }]));
  await wait(() =>
    expect(f.observer.getState()).toMatchObject({
      activity: "idle",
      pendingPermissions: 1,
      pendingQuestions: 1,
      freshness: "current",
    }),
  );
  const before = f.updates.length;
  f.send("permission.asked", { id: "new" });
  f.send("question.asked", { id: "new-question" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.updates).toHaveLength(before);
});

it("keeps a newer native status current when the older status read fails", async () => {
  const f = fixture();
  const status = f.hold("/session/status");
  f.observer.start();
  await wait(() => expect(f.observer.getState().pendingQuestions).toBe(0));
  f.send("session.idle");
  await wait(() => expect(f.observer.getState().freshness).toBe("current"));
  status(json({}, 500));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.observer.getState()).toMatchObject({
    activity: "idle",
    freshness: "current",
  });
});

it("replaces stale pending sets after EOF and ignores late reads from the old connection", async () => {
  const f = fixture();
  f.data.set("/permission", [{ id: "old", sessionID: "ses_a" }]);
  await f.start();
  const oldStatus = f.hold("/session/status");
  const oldPermission = f.hold("/permission");
  f.streams[0]!.end();
  await wait(() => expect(f.streams).toHaveLength(2));
  await wait(() =>
    expect(
      f.fetch.mock.calls.filter((call) => call[0] === "/permission"),
    ).toHaveLength(2),
  );
  expect(f.observer.getState()).toMatchObject({
    pendingPermissions: 1,
    freshness: "reconnecting",
  });
  f.data.set("/permission", []);
  f.data.set("/session/status", {});
  f.streams[1]!.end();
  await wait(() => expect(f.streams).toHaveLength(3));
  await wait(() =>
    expect(f.observer.getState()).toMatchObject({
      pendingPermissions: 0,
      activity: "idle",
      freshness: "current",
    }),
  );
  oldStatus(json({ ses_a: { type: "busy" } }));
  oldPermission(json([{ id: "old", sessionID: "ses_a" }]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(f.observer.getState()).toMatchObject({
    pendingPermissions: 0,
    activity: "idle",
    freshness: "current",
  });
  expect(f.close).not.toHaveBeenCalled();
});

it.each(["status", "permission", "question", "session"])(
  "retries a malformed %s read without restarting a healthy stream",
  async (resource) => {
    const f = fixture();
    const path =
      resource === "session"
        ? "/session/ses_a"
        : resource === "status"
          ? "/session/status"
          : `/${resource}`;
    f.hold(path)(json(null));
    await f.start();
    expect(f.streams).toHaveLength(1);
    expect(f.fetch.mock.calls.filter((call) => call[0] === path)).toHaveLength(
      2,
    );
    expect(f.updates.some((state) => state.freshness === "reconnecting")).toBe(
      true,
    );
  },
);

it.each(["status", "permission"])(
  "does not invent successful empty state after a failed %s read",
  async (resource) => {
    const f = fixture();
    const path = resource === "status" ? "/session/status" : "/permission";
    f.data.set("/permission", [{ id: "pending", sessionID: "ses_a" }]);
    await f.start();
    f.data.set(path, null);
    f.streams[0]!.end();
    await wait(() => expect(f.streams).toHaveLength(2));
    await wait(() =>
      expect(
        f.fetch.mock.calls.filter((call) => call[0] === path).length,
      ).toBeGreaterThanOrEqual(3),
    );
    expect(f.observer.getState()).toMatchObject({
      activity: "busy",
      pendingPermissions: 1,
      freshness: "reconnecting",
    });
    f.observer.dispose();
    const count = f.fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.fetch).toHaveBeenCalledTimes(count);
  },
);

it.each(["event", "missed-event"])(
  "retains terminal missing state after deletion: %s",
  async (source) => {
    const f = fixture();
    await f.start();
    if (source === "event")
      f.send("session.deleted", { info: { id: "ses_a" } });
    else {
      f.hold("/session/ses_a")(json({ private: "diagnostics" }, 404));
      f.streams[0]!.end();
    }
    await wait(() =>
      expect(f.observer.getState()).toMatchObject({
        freshness: "unavailable",
        failure: { code: "native_history_missing" },
      }),
    );
    f.observer.start();
    const count = f.fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.fetch).toHaveBeenCalledTimes(count);
    expect(f.close).not.toHaveBeenCalled();
    expect(JSON.stringify(f.updates)).not.toContain("diagnostics");
  },
);

it("treats a global endpoint 404 as retryable observation loss", async () => {
  const f = fixture();
  f.hold("/permission")(json({}, 404));
  await f.start();
  expect(f.observer.getState().failure).toBeUndefined();
  expect(f.streams).toHaveLength(1);
});

it("isolates two conversations in the same folder and sanitizes terminal authentication errors", async () => {
  const f = fixture();
  await f.start();
  const b = new OpenCodeObserver(f.hosted, "ses_b", () => {});
  cleanups.push(b.dispose);
  b.start();
  await wait(() => expect(b.getState().freshness).toBe("current"));
  for (const stream of f.streams)
    stream.send({
      type: "permission.asked",
      properties: { sessionID: "ses_a", id: "only-a" },
    });
  await wait(() => expect(f.observer.getState().pendingPermissions).toBe(1));
  expect(b.getState()).toMatchObject({
    activity: "idle",
    pendingPermissions: 0,
  });
  f.send(
    "session.error",
    {
      error: {
        name: "ProviderAuthError",
        data: { providerID: "sapiom", message: "secret" },
      },
    },
    0,
  );
  await wait(() =>
    expect(f.observer.getState().failure?.code).toBe("authentication_required"),
  );
  expect(JSON.stringify(f.updates)).not.toContain("secret");
  expect(b.getState().freshness).toBe("current");
});

it.each(["dispose", "abort", "retire"])(
  "fences pending reads and closes the observer connection on %s",
  async (action) => {
    const f = fixture();
    const pending = f.hold("/permission");
    f.observer.start();
    await wait(() => expect(f.fetch).toHaveBeenCalledTimes(5));
    if (action === "dispose") f.observer.dispose();
    if (action === "abort") f.abort.abort();
    if (action === "retire") {
      f.retire();
      f.send("server.heartbeat");
    }
    if (action !== "retire")
      await wait(() => expect(f.streams[0]!.cancelled).toBe(true));
    const before = f.updates.length;
    pending(json([{ id: "late", sessionID: "ses_a" }]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.updates).toHaveLength(before);
    expect(f.close).not.toHaveBeenCalled();
  },
);
