import { describe, expect, it } from "vitest";
import {
  parseAssistantState,
  type AssistantStateSnapshot,
} from "@shared/assistant-state";
import { AssistantStateOrder } from "./assistant-state";

const snapshot = (
  revision = 1,
  changes: Partial<AssistantStateSnapshot> = {},
): AssistantStateSnapshot => ({
  hostInstanceId: "host-a",
  authorityRevision: "authority-a",
  revision,
  enabled: true,
  sessions: [
    {
      harnessSessionId: "studio-a",
      conversationId: "ses_a",
      activity: "busy",
      pendingPermissions: null,
      pendingQuestions: 0,
      freshness: "connecting",
    },
  ],
  ...changes,
});
const open = (order: AssistantStateOrder, generation = 1) =>
  order.transport({ generation, phase: "open" });

describe("Assistant public payload", () => {
  it("copies valid full snapshots and accepts disabled removal", () => {
    const input = snapshot();
    expect(parseAssistantState(input)).toEqual(input);
    expect(parseAssistantState(input)?.sessions[0]).not.toBe(input.sessions[0]);
    expect(
      parseAssistantState(snapshot(2, { enabled: false, sessions: [] })),
    ).not.toBeNull();
  });
  it.each([
    { revision: -1 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { hostInstanceId: "private/path" },
    { authorityRevision: "" },
    { enabled: "true" },
    { sessions: null },
    { enabled: false },
    { credential: "private" },
    { sessions: [snapshot().sessions[0], snapshot().sessions[0]] },
  ])("rejects invalid full snapshot %j", (changes) => {
    expect(parseAssistantState({ ...snapshot(), ...changes })).toBeNull();
  });
  it.each([
    { activity: ["busy"] },
    { freshness: ["current"] },
    { activity: "success" },
    { pendingPermissions: -1 },
    { pendingQuestions: 1.5 },
    { pendingQuestions: Number.MAX_SAFE_INTEGER + 1 },
    { harnessSessionId: "ses_a" },
    { conversationId: "not-native" },
    { harnessSessionId: "x".repeat(257) },
    { prompt: "private" },
    { failure: { code: "runtime_exited", message: "raw native diagnostics" } },
  ])("rejects invalid or private row %j", (changes) => {
    expect(
      parseAssistantState({
        ...snapshot(),
        sessions: [{ ...snapshot().sessions[0], ...changes }],
      }),
    ).toBeNull();
  });
});

describe("Assistant snapshot ordering", () => {
  it("seeds HTTP as uncertain and never lets it overwrite socket authority, even while disconnected", () => {
    const order = new AssistantStateOrder();
    const first = order.beginHttp();
    expect(order.http(first, snapshot(1))).toEqual({
      snapshot: snapshot(1),
      current: false,
    });
    const late = order.beginHttp();
    open(order);
    order.socket(1, snapshot(2));
    order.http(late, snapshot(50));
    expect(order.current()).toEqual({ snapshot: snapshot(2), current: true });
    order.transport({ generation: 1, phase: "closed" });
    order.http(order.beginHttp(), snapshot(51));
    expect(order.current()).toEqual({ snapshot: snapshot(2), current: false });
  });
  it("fences HTTP by request and auth generation", () => {
    const order = new AssistantStateOrder();
    const old = order.beginHttp();
    const latest = order.beginHttp();
    order.http(old, snapshot(2));
    expect(order.current().snapshot).toBeNull();
    order.authChanged();
    order.http(latest, snapshot(3));
    expect(order.current().snapshot).toBeNull();
    order.http(order.beginHttp(), snapshot(4));
    expect(order.current().snapshot?.revision).toBe(4);
  });
  it("requires a validated current-socket handshake; open and stale callbacks cannot restore freshness", () => {
    const order = new AssistantStateOrder();
    open(order);
    order.socket(1, snapshot(5));
    order.transport({ generation: 1, phase: "closed" });
    order.socket(1, snapshot(6));
    open(order, 2);
    order.socket(1, snapshot(7));
    order.transport({ generation: 1, phase: "open" });
    order.socket(2, { ...snapshot(6), sessions: "bad" });
    expect(order.current()).toEqual({ snapshot: snapshot(5), current: false });
    order.socket(2, snapshot(4));
    expect(order.current().current).toBe(false);
    order.socket(2, snapshot(5));
    expect(order.current().current).toBe(true);
  });
  it("adopts a new host with reset revisions only on a fresh socket", () => {
    const order = new AssistantStateOrder();
    open(order);
    order.socket(1, snapshot(20));
    order.socket(1, snapshot(1, { hostInstanceId: "host-b" }));
    expect(order.current().snapshot?.hostInstanceId).toBe("host-a");
    open(order, 2);
    order.socket(2, { ...snapshot(), hostInstanceId: null });
    order.socket(2, snapshot(0, { hostInstanceId: "host-b" }));
    expect(order.current().snapshot?.hostInstanceId).toBe("host-b");
    order.socket(1, snapshot(100));
    order.socket(2, snapshot(100));
    expect(order.current().snapshot?.hostInstanceId).toBe("host-b");
  });
  it("clears immediately on auth change and retains revision fences until the host reconfirms access", () => {
    const order = new AssistantStateOrder();
    open(order);
    order.socket(1, snapshot(5));
    order.authChanged();
    expect(order.current()).toEqual({ snapshot: null, current: false });
    order.socket(1, snapshot(4));
    expect(order.current().snapshot).toBeNull();
    order.socket(1, snapshot(6, { enabled: false, sessions: [] }));
    expect(order.current().snapshot?.sessions).toEqual([]);
    order.socket(1, snapshot(4, { authorityRevision: "authority-b" }));
    expect(order.current().snapshot?.enabled).toBe(false);
    order.socket(
      1,
      snapshot(7, { authorityRevision: "authority-b", sessions: [] }),
    );
    expect(order.current()).toEqual({
      snapshot: snapshot(7, { authorityRevision: "authority-b", sessions: [] }),
      current: true,
    });
  });
  it("accepts unchanged authority after failed sign-in is reconfirmed by the host", () => {
    const order = new AssistantStateOrder();
    open(order);
    order.socket(1, snapshot(5));
    const oldHttp = order.beginHttp();
    order.authChanged();
    expect(order.current().snapshot).toBeNull();
    order.http(oldHttp, snapshot(50));
    expect(order.current().snapshot).toBeNull();
    expect(order.socket(1, snapshot(5))).toEqual({
      snapshot: snapshot(5),
      current: true,
    });
  });
  it("replaces complete sets and clears current presentation on malformed updates", () => {
    const order = new AssistantStateOrder();
    open(order);
    order.socket(1, snapshot());
    order.socket(1, snapshot(2, { sessions: [] }));
    expect(order.current().snapshot?.sessions).toEqual([]);
    order.socket(1, null);
    expect(order.current()).toEqual({
      snapshot: snapshot(2, { sessions: [] }),
      current: false,
    });
  });
});
