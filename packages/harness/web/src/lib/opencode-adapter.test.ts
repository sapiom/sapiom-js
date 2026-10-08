import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpencodeClient,
  OpenCodeEventSource,
  OpenCodeThreadController,
  type OpenCodeServerEvent,
} from "@assistant-ui/react-opencode";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const event = (type: string, properties: Record<string, unknown> = {}) => ({
  type,
  properties,
  sessionId: type.startsWith("stream.") ? undefined : "session-a",
  raw: undefined,
});

function controllerFixture() {
  let receive: (event: OpenCodeServerEvent) => void = () => {};
  const status = deferred<{ data?: Record<string, { type: string }> }>();
  const history = deferred<{ data: [] }>();
  const client = {
    session: {
      status: vi.fn(() => status.promise),
      get: vi.fn(async () => ({ data: null })),
      messages: vi.fn(() => history.promise),
      promptAsync: vi.fn(),
    },
    permission: { list: vi.fn(async () => ({ data: [] })) },
    question: { list: vi.fn(async () => ({ data: [] })) },
  };
  const controller = new OpenCodeThreadController(
    client as never,
    () => ({
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
    }),
    "session-a",
  );
  const unsubscribe = controller.subscribe(() => {});
  return {
    controller,
    client,
    status,
    history,
    unsubscribe,
    emit: (e: OpenCodeServerEvent) => receive(e),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the consumed OpenCode adapter", () => {
  it("waits for an actual frame, catches up on first attachment and seeds late subscribers", async () => {
    const response = deferred<Response>();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        writer = value;
      },
    });
    const fetch = vi.fn(() => response.promise);
    const source = new OpenCodeEventSource(
      createOpencodeClient({ baseUrl: "http://native.invalid", fetch }),
    );
    const received = vi.fn();
    source.subscribe(received);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(received).not.toHaveBeenCalled();
      response.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).not.toHaveBeenCalled();
      writer.enqueue(
        new TextEncoder().encode(
          'data: {"type":"server.connected","properties":{}}\n\n',
        ),
      );
      await vi.waitFor(() =>
        expect(received).toHaveBeenCalledWith(
          expect.objectContaining({ type: "stream.reconnected" }),
        ),
      );
      const late = vi.fn();
      source.subscribe(late);
      expect(late).toHaveBeenCalledWith(
        expect.objectContaining({ type: "stream.reconnected" }),
      );
      expect(fetch).toHaveBeenCalledOnce();
      writer.close();
      await vi.waitFor(() =>
        expect(late).toHaveBeenCalledWith(
          expect.objectContaining({ type: "stream.disconnected" }),
        ),
      );
    } finally {
      source.dispose();
    }
  });

  it("does not announce readiness for a lazy subscription that fails to fetch", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const source = new OpenCodeEventSource(
      createOpencodeClient({ baseUrl: "http://native.invalid", fetch }),
    );
    const receive = vi.fn();
    source.subscribe(receive);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(
        receive.mock.calls.some(([e]) => e.type === "stream.reconnected"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      source.dispose();
    }
  });

  it.each(["session.idle", "session.status"])(
    "keeps newer %s ahead of an old busy snapshot",
    async (type) => {
      const f = controllerFixture();
      try {
        f.emit(event("stream.reconnected"));
        f.emit(event(type, { status: { type: "idle" } }));
        f.status.resolve({ data: { "session-a": { type: "busy" } } });
        f.history.resolve({ data: [] });
        await f.controller.load();
        expect(f.controller.getState().sessionStatus).toEqual({ type: "idle" });
        expect(f.client.session.promptAsync).not.toHaveBeenCalled();
      } finally {
        f.controller.dispose();
      }
    },
  );

  it("keeps newer busy ahead of an old empty status snapshot", async () => {
    const f = controllerFixture();
    try {
      f.emit(event("stream.reconnected"));
      f.emit(event("session.status", { status: { type: "busy" } }));
      f.status.resolve({ data: {} });
      f.history.resolve({ data: [] });
      await f.controller.load();
      expect(f.controller.getState().sessionStatus).toEqual({ type: "busy" });
    } finally {
      f.controller.dispose();
    }
  });

  it("accepts a current empty status snapshot as idle", async () => {
    const f = controllerFixture();
    try {
      f.emit(event("session.status", { status: { type: "busy" } }));
      f.emit(event("stream.reconnected"));
      f.status.resolve({ data: {} });
      f.history.resolve({ data: [] });
      await f.controller.load();
      expect(f.controller.getState().sessionStatus).toEqual({ type: "idle" });
    } finally {
      f.controller.dispose();
    }
  });

  it.each([undefined, [], { "session-a": { type: "invalid" } }])(
    "does not turn a malformed status response into idle",
    async (data) => {
      const f = controllerFixture();
      try {
        f.emit(event("session.status", { status: { type: "busy" } }));
        f.emit(event("stream.reconnected"));
        f.status.resolve({ data: data as never });
        f.history.resolve({ data: [] });
        await f.controller.load();
        expect(f.controller.getState().sessionStatus).toEqual({ type: "busy" });
      } finally {
        f.controller.dispose();
      }
    },
  );

  it.each(["unsubscribe", "dispose", "disconnect"])(
    "fences old status and history after %s, then permits reattachment",
    async (action) => {
      const f = controllerFixture();
      try {
        f.emit(event("session.status", { status: { type: "busy" } }));
        f.emit(event("stream.reconnected"));
        const loading = f.controller.load();
        if (action === "unsubscribe") f.unsubscribe();
        if (action === "dispose") f.controller.dispose();
        if (action === "disconnect") f.emit(event("stream.disconnected"));
        const detached = f.controller.getState();
        f.status.resolve({ data: {} });
        f.history.resolve({ data: [] });
        await loading;
        expect(f.controller.getState()).toBe(detached);
        f.controller.subscribe(() => {});
        f.emit(event("stream.reconnected"));
        await f.controller.load();
        expect(f.controller.getState().loadState.type).toBe("ready");
        expect(f.controller.getState().sessionStatus).toEqual({ type: "idle" });
      } finally {
        f.controller.dispose();
      }
    },
  );

  it("ignores a rejected history read after disposal", async () => {
    const f = controllerFixture();
    f.emit(event("stream.reconnected"));
    const loading = f.controller.load();
    f.controller.dispose();
    const detached = f.controller.getState();
    f.history.reject(new Error("old connection"));
    f.status.resolve({ data: {} });
    await loading.catch(() => {});
    expect(f.controller.getState()).toBe(detached);
  });
});
