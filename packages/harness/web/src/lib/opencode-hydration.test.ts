import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenCodeThreadController,
  type MessageWithParts,
  type OpenCodeServerEvent,
} from "@assistant-ui/react-opencode";

function message(
  text: string,
  complete = false,
  type = "text",
): MessageWithParts {
  return {
    info: {
      id: "msg-a",
      sessionID: "session-a",
      role: "assistant",
      time: { created: 1, ...(complete ? { completed: 2 } : {}) },
    },
    parts: [
      {
        id: "part-a",
        messageID: "msg-a",
        sessionID: "session-a",
        type,
        text,
        time: { start: 1, ...(complete ? { end: 2 } : {}) },
      },
    ],
  } as MessageWithParts;
}

const disposers: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

function fixture(type = "text") {
  let receive!: (event: OpenCodeServerEvent) => void;
  let snapshot: unknown = [message("Hello ", false, type)];
  const client = {
    session: {
      get: vi.fn(async () => ({ data: { id: "session-a" } })),
      messages: vi.fn(async () => ({ data: structuredClone(snapshot) })),
      status: vi.fn(async () => ({ data: { "session-a": { type: "busy" } } })),
      promptAsync: vi.fn(),
      abort: vi.fn(async () => ({})),
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
  controller.subscribe(() => {});
  disposers.push(() => controller.dispose());
  const emit = (eventType: string, properties: Record<string, unknown> = {}) =>
    receive({
      type: eventType,
      properties,
      raw: undefined,
      sessionId: eventType.startsWith("stream.") ? undefined : "session-a",
    });
  const part = (text: string, complete = false) =>
    emit("message.part.updated", {
      part: message(text, complete, type).parts[0],
    });
  const delta = (text: string, partID = "part-a") =>
    emit("message.part.delta", {
      messageID: "msg-a",
      partID,
      field: "text",
      delta: text,
    });
  const text = () =>
    (
      controller.getState().messagesById["msg-a"]?.parts[0] as
        | { text?: string }
        | undefined
    )?.text;
  return {
    controller,
    client,
    emit,
    part,
    delta,
    text,
    snapshot: (next: unknown) => {
      snapshot = next;
    },
    async ready() {
      emit("stream.reconnected");
      await controller.load();
      await flush();
      part("Hello ");
      await flush();
    },
    holdRead() {
      let resolve!: (result: { data: unknown }) => void;
      client.session.messages.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      return (data: unknown) => resolve({ data });
    },
  };
}

describe("OpenCode absolute history merging through public exports", () => {
  it("does not roll a completed tool back to its queued running update", async () => {
    const f = fixture();
    const completed = message("Complete", true);
    completed.parts = [
      {
        id: "tool-a",
        messageID: "msg-a",
        sessionID: "session-a",
        type: "tool",
        tool: "read",
        callID: "call-a",
        state: {
          status: "completed",
          input: {},
          output: "file contents",
          title: "Read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ];
    f.snapshot([completed]);
    await f.controller.load();
    f.emit("session.idle");
    f.emit("message.part.updated", {
      part: {
        ...completed.parts[0],
        state: { status: "running", input: {}, time: { start: 1 } },
      },
    });
    expect(f.controller.getState().messagesById["msg-a"]?.parts).toEqual(
      completed.parts,
    );
    expect(f.controller.getState().runState.type).toBe("idle");
  });

  it("keeps the final removal after several updates to the same message", async () => {
    const f = fixture();
    await f.ready();
    const resolve = f.holdRead();
    const loading = f.controller.refresh();
    f.emit("message.updated", { info: message("first").info });
    f.part("first");
    f.part("second");
    f.emit("message.removed", { messageID: "msg-a" });
    resolve([message("old")]);
    await loading;
    expect(f.controller.getState().messageOrder).toEqual([]);
    expect(f.text()).toBeUndefined();
  });

  it("keeps a new full part ahead of an older history response", async () => {
    const f = fixture();
    await f.ready();
    const resolve = f.holdRead();
    const loading = f.controller.refresh();
    f.part("new complete answer", true);
    resolve([message("old answer", true)]);
    await loading;
    expect(f.text()).toBe("new complete answer");
  });

  it.each(["message.removed", "message.part.removed"])(
    "keeps %s received before metadata arrives",
    async (type) => {
      const f = fixture();
      const resolve = f.holdRead();
      const loading = f.controller.load();
      f.emit(type, { messageID: "msg-a", partID: "part-a" });
      resolve([message("removed answer", true)]);
      await loading;
      expect(f.text()).toBeUndefined();
    },
  );

  it("keeps session metadata, new messages and their latest parts", async () => {
    const f = fixture();
    await f.ready();
    const resolve = f.holdRead();
    const loading = f.controller.refresh();
    f.emit("session.updated", {
      info: { id: "session-a", title: "new title" },
    });
    const next = message("second", true);
    next.info.id = "msg-b";
    next.parts[0]!.id = "part-b";
    next.parts[0]!.messageID = "msg-b";
    f.emit("message.updated", { info: { ...next.info, time: { created: 1 } } });
    f.emit("message.part.updated", { part: next.parts[0] });
    f.emit("message.updated", { info: next.info });
    resolve([message("first", true)]);
    await loading;
    expect(f.controller.getState().session?.title).toBe("new title");
    expect(f.controller.getState().messagesById["msg-b"]?.parts).toEqual(
      next.parts,
    );
    expect(f.controller.getState().messagesById["msg-b"]?.info).toEqual(
      next.info,
    );
  });

  it("retains a full part received while its metadata is still loading", async () => {
    const f = fixture();
    const resolve = f.holdRead();
    const loading = f.controller.load();
    f.part("current", true);
    // Keep the scheduled follow-up pending so this asserts the first merge.
    f.holdRead();
    resolve([message("old", true)]);
    await loading;
    expect(f.text()).toBe("current");
  });

  it.each(["during", "after"])(
    "preserves completion when queued start metadata arrives %s hydration",
    async (timing) => {
      const f = fixture();
      await f.ready();
      const resolve = f.holdRead();
      const loading = f.controller.refresh();
      const older = () => f.emit("message.updated", { info: message("").info });
      if (timing === "during") older();
      resolve([message("Complete", true)]);
      await loading;
      if (timing === "after") older();
      expect(
        f.controller.getState().messagesById["msg-a"]?.info?.time,
      ).toMatchObject({ completed: 2 });
    },
  );

  it.each(["idle", "error", "cancelling"])(
    "does not overwrite newer %s activity while merging parts",
    async (activity) => {
      const f = fixture();
      await f.ready();
      const resolve = f.holdRead();
      const loading = f.controller.refresh();
      f.part("live answer");
      if (activity === "idle") f.emit("session.idle");
      else if (activity === "error")
        f.emit("session.error", { error: "failed" });
      else await f.controller.cancel();
      const current = f.controller.getState();
      // The idle-triggered follow-up is separate from this in-flight merge.
      f.holdRead();
      await vi.advanceTimersByTimeAsync(20);
      resolve([message("old answer")]);
      await loading;
      expect(f.text()).toBe("live answer");
      expect(f.controller.getState()).toMatchObject({
        runState: current.runState,
        sessionStatus: current.sessionStatus,
        sync: { lastEventAt: current.sync.lastEventAt },
      });
    },
  );

  it("keeps a completed answer idle when queued start parts and deltas arrive", async () => {
    const f = fixture();
    f.snapshot([message("Complete", true)]);
    await f.controller.load();
    f.emit("session.idle");
    f.part("");
    f.delta("Complete");
    expect(f.text()).toBe("Complete");
    expect(f.controller.getState().runState.type).toBe("idle");
  });

  it.each(["full", "delta"])(
    "fences an old status snapshot after a newer %s part",
    async (kind) => {
      const f = fixture();
      await f.ready();
      let finish!: (value: never) => void;
      f.client.session.status.mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      );
      f.emit("stream.reconnected");
      if (kind === "full") f.part("current");
      else f.delta("current");
      finish({ data: {} } as never);
      await flush();
      expect(f.controller.getState().sessionStatus?.type).toBe("busy");
    },
  );
});
