import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createEventsWebSocketHandler } from "./events-ws.js";
import { EventBus } from "../core/event-bus.js";

const BOOT_TOKEN = "boot-token-123";

function createFakeWs() {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb),
  };
  return { ws: ws as unknown as WebSocket, emitter, sent };
}

describe("createEventsWebSocketHandler", () => {
  it("rejects a connection with the wrong token", () => {
    const bus = new EventBus();
    const getter = vi.fn();
    const handler = createEventsWebSocketHandler(bus, BOOT_TOKEN, getter);
    const { ws } = createFakeWs();

    handler(ws, {} as IncomingMessage, new URLSearchParams({ token: "wrong" }));

    expect(ws.close).toHaveBeenCalledWith(4001, "unauthorized");
    expect(getter).not.toHaveBeenCalled();
  });

  it("forwards a message published on the bus after a valid connection", () => {
    const bus = new EventBus();
    const handler = createEventsWebSocketHandler(bus, BOOT_TOKEN);
    const { ws, sent } = createFakeWs();

    handler(ws, {} as IncomingMessage, new URLSearchParams({ token: BOOT_TOKEN }));
    bus.publish({ type: "canvas.reload", harnessSessionId: "sess-1" });

    expect(sent).toEqual([JSON.stringify({ type: "canvas.reload", harnessSessionId: "sess-1" })]);
  });

  it("unsubscribes from the bus once the socket closes", () => {
    const bus = new EventBus();
    const handler = createEventsWebSocketHandler(bus, BOOT_TOKEN);
    const { ws, emitter, sent } = createFakeWs();

    handler(ws, {} as IncomingMessage, new URLSearchParams({ token: BOOT_TOKEN }));
    emitter.emit("close");
    bus.publish({ type: "workflows.changed" });

    expect(sent).toEqual([]);
  });

  it("does not forward to a socket that isn't OPEN", () => {
    const bus = new EventBus();
    const handler = createEventsWebSocketHandler(bus, BOOT_TOKEN);
    const { ws, sent } = createFakeWs();
    (ws as unknown as { readyState: number }).readyState = 3; // CLOSED

    handler(ws, {} as IncomingMessage, new URLSearchParams({ token: BOOT_TOKEN }));
    bus.publish({ type: "workflows.changed" });

    expect(sent).toEqual([]);
  });
});

// Access getters may synchronously revoke a grant and publish the reset.
it("subscribes before the full snapshot and unsubscribes on socket error", () => {
  const bus = new EventBus();
  const snapshot = { hostInstanceId: "host", authorityRevision: "auth", revision: 2, enabled: false, sessions: [] };
  const frame = { type: "assistant.state" as const, snapshot };
  const getter = vi.fn(() => { bus.publish(frame); return snapshot; });
  const { ws, emitter, sent } = createFakeWs();
  createEventsWebSocketHandler(bus, BOOT_TOKEN, getter)(ws, {} as IncomingMessage, new URLSearchParams({ token: BOOT_TOKEN }));
  expect(sent.map(data => JSON.parse(data))).toEqual([frame, frame]);
  expect(getter).toHaveBeenCalledOnce();
  emitter.emit("error", new Error("closed"));
  bus.publish(frame);
  expect(sent).toHaveLength(2);
});

it.each([true, false])("confirms current Assistant access after auth.changed with enabled=%s", enabled => {
  const bus = new EventBus();
  const state = { hostInstanceId: "host", authorityRevision: "auth", revision: 1, enabled, sessions: [] };
  const { ws, sent } = createFakeWs();
  createEventsWebSocketHandler(bus, BOOT_TOKEN, () => state)(ws, {} as IncomingMessage, new URLSearchParams({ token: BOOT_TOKEN }));
  const auth = { type: "auth.changed" as const, authenticated: false, organizationName: null };
  bus.publish(auth);
  expect(sent.slice(1).map(data => JSON.parse(data))).toEqual([auth, { type: "assistant.state", snapshot: state }]);
});
