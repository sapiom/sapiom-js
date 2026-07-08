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
    const handler = createEventsWebSocketHandler(bus, BOOT_TOKEN);
    const { ws } = createFakeWs();

    handler(ws, {} as IncomingMessage, new URLSearchParams({ token: "wrong" }));

    expect(ws.close).toHaveBeenCalledWith(4001, "unauthorized");
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
