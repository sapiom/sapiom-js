import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenCodeThreadController,
  type OpenCodeServerEvent,
} from "@assistant-ui/react-opencode";

const history = [{ info: { id: "msg-a", role: "assistant" }, parts: [] }];
const disposers: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

function fixture() {
  let receive!: (event: OpenCodeServerEvent) => void;
  const messages = vi.fn(
    async (): Promise<{ data: unknown }> => ({ data: history }),
  );
  const controller = new OpenCodeThreadController(
    {
      session: {
        get: async () => ({ data: { id: "session-a" } }),
        messages,
        status: async () => ({ data: { "session-a": { type: "busy" } } }),
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    } as never,
    () => ({
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
    }),
    "session-a",
  );
  const unsubscribe = controller.subscribe(() => {});
  disposers.push(() => controller.dispose());
  const emit = (type: string, properties: Record<string, unknown> = {}) =>
    receive({ type, properties, raw: undefined, sessionId: "session-a" });
  return {
    controller,
    messages,
    unsubscribe,
    emit,
    delta: () =>
      emit("message.part.delta", {
        messageID: "msg-a",
        partID: "missing-part",
        field: "text",
        delta: "x",
      }),
    async ready() {
      emit("stream.reconnected");
      await controller.load();
      await flush();
    },
    holdRead() {
      let resolve!: (data: { data: unknown }) => void;
      messages.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      return (data: unknown = history) => resolve({ data });
    },
  };
}

describe("bounded native history reads through the consumed adapter", () => {
  it("joins a forced refresh already in flight and schedules one bounded follow-up", async () => {
    const f = fixture();
    await f.ready();
    const resolve = f.holdRead();
    const loading = f.controller.refresh();
    const again = f.controller.refresh();
    for (let i = 0; i < 100; i++) f.delta();
    await flush();
    expect(f.messages).toHaveBeenCalledTimes(2);
    resolve();
    await Promise.all([loading, again]);
    await flush();
    expect(f.controller.getState().messagesById["msg-a"]).toBeDefined();
    expect(f.messages.mock.calls.length).toBeLessThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.messages).toHaveBeenCalledTimes(3);
  });

  it("backs off sustained unknown deltas without overlapping reads", async () => {
    const f = fixture();
    await f.ready();
    for (let i = 0; i < 100; i++) {
      f.delta();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(f.messages.mock.calls.length).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(10_000);
    const calls = f.messages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.messages).toHaveBeenCalledTimes(calls);
  });

  it.each(["dispose", "unsubscribe", "disconnect"])(
    "cancels queued reads after %s and allows reattachment",
    async (action) => {
      const f = fixture();
      await f.ready();
      f.delta();
      if (action === "dispose") f.controller.dispose();
      if (action === "unsubscribe") f.unsubscribe();
      if (action === "disconnect") f.emit("stream.disconnected");
      const detached = f.controller.getState();
      const calls = f.messages.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.messages).toHaveBeenCalledTimes(calls);
      expect(f.controller.getState()).toBe(detached);
      f.controller.subscribe(() => {});
      f.emit("stream.reconnected");
      await f.controller.load();
      expect(f.messages).toHaveBeenCalledTimes(calls + 1);
    },
  );

  it.each([undefined, {}, [null], [{ info: {}, parts: [] }]])(
    "rejects malformed history while preserving visible messages (%j)",
    async (data) => {
      const f = fixture();
      await f.ready();
      f.messages.mockResolvedValueOnce({ data });
      await expect(f.controller.refresh()).rejects.toThrow(
        "Invalid OpenCode history",
      );
      expect(f.controller.getState().messagesById["msg-a"]).toBeDefined();
      expect(f.controller.getState().sessionStatus?.type).toBe("busy");
      await f.controller.refresh();
      expect(f.controller.getState().loadState.type).toBe("ready");
    },
  );

  it("retains a running session on catch-up failure and permits a later read", async () => {
    const f = fixture();
    await f.ready();
    f.messages.mockRejectedValueOnce(new Error("offline"));
    f.delta();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.controller.getState().loadState.type).toBe("error");
    expect(f.controller.getState().runState.type).toBe("streaming");
    expect(f.controller.getState().messagesById["msg-a"]).toBeDefined();
    f.delta();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.controller.getState().loadState.type).toBe("ready");
  });
});
