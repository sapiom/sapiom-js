import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenCodeThreadController,
  type OpenCodeServerEvent,
} from "@assistant-ui/react-opencode";

type Kind = "permission" | "question";
const kinds: Kind[] = ["permission", "question"];
const request = (kind: Kind, id = "request-a", sessionID = "session-a") => ({
  id,
  sessionID,
  ...(kind === "permission"
    ? { permission: "read", patterns: ["file.txt"], always: [], metadata: {} }
    : {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue the task" }],
          },
        ],
      }),
});
const disposers: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

function fixture(kind: Kind) {
  let receive!: (event: OpenCodeServerEvent) => void;
  const list = vi.fn(async (): Promise<{ data: unknown }> => ({ data: [] }));
  const client = {
    session: {
      get: vi.fn(async () => ({ data: { id: "session-a" } })),
      messages: vi.fn(async () => ({ data: [] })),
      status: vi.fn(async () => ({ data: {} })),
    },
    permission: {
      list: kind === "permission" ? list : vi.fn(async () => ({ data: [] })),
      reply: vi.fn(async () => ({})),
    },
    question: {
      list: kind === "question" ? list : vi.fn(async () => ({ data: [] })),
      reply: vi.fn(async () => ({})),
      reject: vi.fn(async () => ({})),
    },
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
  const emit = (type: string, properties: Record<string, unknown> = {}) =>
    receive({
      type,
      properties,
      raw: undefined,
      sessionId: type.startsWith("stream.") ? undefined : "session-a",
    });
  const interactions = () =>
    controller.getState().interactions[
      kind === "permission" ? "permissions" : "questions"
    ];
  return {
    list,
    controller,
    emit,
    interactions,
    pending: () => interactions().pending,
    current: () =>
      controller.getState().sync[
        kind === "permission" ? "permissionsCurrent" : "questionsCurrent"
      ],
    ask: (id = "request-a") => emit(`${kind}.asked`, request(kind, id)),
    settle: (id = "request-a") =>
      emit(`${kind}.replied`, {
        requestID: id,
        reply: "once",
        answers: [["Yes"]],
      }),
    localReply: () =>
      kind === "permission"
        ? controller.replyToPermission("request-a", "once")
        : controller.replyToQuestion("request-a", [["Yes"]]),
    async ready() {
      emit("stream.reconnected");
      await flush();
    },
    holdRead() {
      let finish!: (value: { data: unknown }) => void;
      list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      return (data: unknown) => finish({ data });
    },
  };
}

describe.each(kinds)("authoritative %s snapshots", (kind) => {
  it("clears stale requests with an empty list and filters other conversations", async () => {
    const f = fixture(kind);
    await f.ready();
    f.ask();
    f.list.mockResolvedValueOnce({
      data: [request(kind, "other", "session-b")],
    });
    f.emit("stream.reconnected");
    await flush();
    expect(f.pending()).toEqual({});
    expect(f.current()).toBe(true);
  });

  it("overlays asks received after the list read starts", async () => {
    const f = fixture(kind);
    await f.ready();
    const finish = f.holdRead();
    f.emit("stream.reconnected");
    f.ask("new-request");
    finish([]);
    await flush();
    expect(Object.keys(f.pending())).toEqual(["new-request"]);
    expect(f.current()).toBe(true);
  });

  it.each(["native", "local"])(
    "does not resurrect an acknowledged %s reply",
    async (source) => {
      const f = fixture(kind);
      await f.ready();
      f.ask();
      const finish = f.holdRead();
      f.emit("stream.reconnected");
      if (source === "native") f.settle();
      else await f.localReply();
      f.ask(); // A queued earlier ask cannot undo a successful acknowledgement.
      finish([request(kind)]);
      await flush();
      expect(f.pending()).toEqual({});
      const state = f.controller.getState().interactions;
      const settled =
        kind === "permission"
          ? state.permissions.resolved
          : state.questions.answered;
      expect(settled["request-a"]?.request.id).toBe("request-a");
    },
  );

  it("keeps a reply tombstone even before the request has been displayed", async () => {
    const f = fixture(kind);
    const finish = f.holdRead();
    f.emit("stream.reconnected");
    f.settle();
    f.ask();
    finish([request(kind)]);
    await flush();
    expect(f.pending()).toEqual({});
  });

  it.each([
    undefined,
    null,
    {},
    [null],
    [{ id: "broken", sessionID: "session-a" }],
  ])(
    "retains last-known requests as uncertain for malformed data %j",
    async (data) => {
      const f = fixture(kind);
      await f.ready();
      f.ask();
      f.list.mockResolvedValueOnce({ data });
      f.emit("stream.reconnected");
      await flush();
      expect(Object.keys(f.pending())).toEqual(["request-a"]);
      expect(f.current()).toBe(false);
      const other =
        kind === "permission" ? "questionsCurrent" : "permissionsCurrent";
      expect(f.controller.getState().sync[other]).toBe(true);
    },
  );

  it("rejects malformed nested request fields without replacing pending state", async () => {
    const f = fixture(kind);
    await f.ready();
    f.ask();
    const malformed = {
      ...request(kind, "broken"),
      ...(kind === "permission"
        ? { patterns: [null] }
        : {
            questions: [
              { question: "Continue?", header: "Continue", options: [null] },
            ],
          }),
    };
    f.list.mockResolvedValueOnce({ data: [malformed] });
    f.emit("stream.reconnected");
    await flush();
    expect(Object.keys(f.pending())).toEqual(["request-a"]);
    expect(f.current()).toBe(false);
  });

  it("recovers a failed read while the existing stream remains connected", async () => {
    const f = fixture(kind);
    await f.ready();
    f.ask();
    f.list.mockRejectedValueOnce(new Error("offline"));
    f.emit("stream.reconnected");
    await flush();
    expect(f.current()).toBe(false);
    expect(Object.keys(f.pending())).toEqual(["request-a"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.pending()).toEqual({});
    expect(f.current()).toBe(true);
  });

  it("bounds failed-read retries and cancels them when disposed", async () => {
    const f = fixture(kind);
    f.list.mockRejectedValue(new Error("offline"));
    f.emit("stream.reconnected");
    await vi.advanceTimersByTimeAsync(30_000);
    const calls = f.list.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(15);
    f.controller.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.list).toHaveBeenCalledTimes(calls);
  });

  it("ignores a delayed response from a disposed and reattached controller", async () => {
    const f = fixture(kind);
    const old = f.holdRead();
    f.emit("stream.reconnected");
    f.controller.dispose();
    f.controller.subscribe(() => {});
    f.list.mockResolvedValueOnce({ data: [request(kind, "current")] });
    f.emit("stream.reconnected");
    await flush();
    old([request(kind, "obsolete")]);
    await flush();
    expect(Object.keys(f.pending())).toEqual(["current"]);
    expect(f.current()).toBe(true);
    f.emit("stream.disconnected");
    expect(f.current()).toBe(false);
  });
});

it("keeps an acknowledged question rejection settled across a snapshot", async () => {
  const f = fixture("question");
  await f.ready();
  f.ask();
  const finish = f.holdRead();
  f.emit("stream.reconnected");
  await f.controller.rejectQuestion("request-a");
  finish([request("question")]);
  await flush();
  expect(f.pending()).toEqual({});
  expect(
    f.controller.getState().interactions.questions.rejected["request-a"]
      ?.request.id,
  ).toBe("request-a");
});
