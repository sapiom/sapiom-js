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

describe("OpenCode stream tail recovery through public exports", () => {
  it.each(["text", "reasoning"])(
    "keeps %s visible across a missing middle delta until a full update repairs it",
    async (type) => {
      const f = fixture(type);
      await f.ready();
      f.emit("stream.disconnected");
      f.snapshot([message("", false, type)]);
      f.emit("stream.reconnected");
      await f.controller.load();
      await flush();
      expect(f.text()).toBe("Hello ");
      expect(f.controller.getState().loadState.type).toBe("loading");
      f.delta("world");
      await flush();
      expect(f.text()).toBe("Hello ");
      f.snapshot([message("Hello big world", true, type)]);
      f.part("Hello big world", true);
      f.emit("session.idle");
      await flush();
      expect(f.text()).toBe("Hello big world");
      expect(f.controller.getState().loadState.type).toBe("ready");
      expect(f.client.session.promptAsync).not.toHaveBeenCalled();
    },
  );

  it("does not replay a buffered delta on text already present in a snapshot", async () => {
    const f = fixture();
    await f.ready();
    f.snapshot([message("Hello world", true)]);
    await f.controller.refresh();
    f.delta("world");
    expect(f.text()).toBe("Hello world");
  });

  it("repairs a missed final part through an authoritative idle read", async () => {
    const f = fixture();
    await f.ready();
    f.emit("stream.disconnected");
    f.snapshot([message("", false)]);
    f.emit("stream.reconnected");
    await f.controller.load();
    f.delta("world");
    f.snapshot([message("Hello big world", true)]);
    f.emit("session.status", { status: { type: "idle" } });
    await flush();
    expect(f.text()).toBe("Hello big world");
    expect(f.controller.getState().loadState.type).toBe("ready");
  });

  it("keeps an event baseline separate from a partial overlapping snapshot", async () => {
    const f = fixture();
    await f.ready();
    f.snapshot([message("Hello world", false)]);
    await f.controller.refresh();
    f.delta("world");
    expect(f.text()).toBe("Hello world");
    f.delta("!");
    expect(f.text()).toBe("Hello world!");
  });

  it("invalidates the text baseline when the cached controller is disposed and reattached", async () => {
    const f = fixture();
    await f.ready();
    f.controller.dispose();
    f.controller.subscribe(() => {});
    f.snapshot([message("", false)]);
    f.emit("stream.reconnected");
    await f.controller.load();
    f.delta("world");
    expect(f.text()).toBe("Hello ");
    expect(f.controller.getState().loadState.type).toBe("loading");
  });

  it("does not resurrect a part after a removal and a later unrelated read", async () => {
    const f = fixture();
    await f.ready();
    f.emit("message.part.removed", { messageID: "msg-a", partID: "part-a" });
    const empty = message("", true);
    empty.parts = [];
    f.snapshot([empty]);
    await f.controller.refresh();
    expect(f.text()).toBeUndefined();
  });

  it("ignores a delta after its stream baseline has already completed", async () => {
    const f = fixture();
    await f.ready();
    f.part("Complete", true);
    f.delta("Complete");
    expect(f.text()).toBe("Complete");
  });
});
