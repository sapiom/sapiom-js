import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { SessionManager } from "../core/session-manager.js";
import { SessionInputIsolationError } from "../core/session-manager.js";
import { createTerminalWebSocketHandler } from "./terminal-ws.js";

const BOOT_TOKEN = "boot-token-123";

function createFakeWs() {
  const emitter = new EventEmitter();
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) =>
      emitter.on(event, cb),
  };
  return { ws: ws as unknown as WebSocket, emitter };
}

function createSessionManager(
  write: (sessionId: string, text: string) => boolean,
) {
  const detach = vi.fn();
  const manager = {
    get: vi.fn(() => ({ id: "session-1" })),
    attach: vi.fn(() => detach),
    resize: vi.fn(),
    write: vi.fn(write),
  } as unknown as SessionManager;
  return { manager, detach };
}

describe("createTerminalWebSocketHandler", () => {
  it("relays raw input and resize control messages", () => {
    const { manager } = createSessionManager(() => true);
    const { ws, emitter } = createFakeWs();

    createTerminalWebSocketHandler(manager, BOOT_TOKEN)(
      ws,
      {} as IncomingMessage,
      new URLSearchParams({ session: "session-1", token: BOOT_TOKEN }),
    );

    emitter.emit("message", Buffer.from("hello"), true);
    emitter.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })),
      false,
    );

    expect(manager.write).toHaveBeenCalledWith("session-1", "hello");
    expect(manager.resize).toHaveBeenCalledWith("session-1", 120, 40);
  });

  it("closes with a fixed content-free reason when composer isolation blocks input", () => {
    const { manager, detach } = createSessionManager(() => {
      throw new SessionInputIsolationError();
    });
    const { ws, emitter } = createFakeWs();

    createTerminalWebSocketHandler(manager, BOOT_TOKEN)(
      ws,
      {} as IncomingMessage,
      new URLSearchParams({ session: "session-1", token: BOOT_TOKEN }),
    );

    expect(() =>
      emitter.emit("message", Buffer.from("private input"), true),
    ).not.toThrow();
    expect(ws.close).toHaveBeenCalledWith(1011, "terminal input unavailable");
    expect(JSON.stringify(vi.mocked(ws.close).mock.calls)).not.toContain(
      "private input",
    );
    expect(detach).toHaveBeenCalledTimes(1);

    emitter.emit("message", Buffer.from("later input"), true);
    emitter.emit("close");
    emitter.emit("error", new Error("ignored socket error"));

    expect(manager.write).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("does not expose an unexpected PTY error in the close frame", () => {
    const { manager } = createSessionManager(() => {
      throw new Error("provider payload and path must remain private");
    });
    const { ws, emitter } = createFakeWs();

    createTerminalWebSocketHandler(manager, BOOT_TOKEN)(
      ws,
      {} as IncomingMessage,
      new URLSearchParams({ session: "session-1", token: BOOT_TOKEN }),
    );

    expect(() =>
      emitter.emit("message", Buffer.from("private input"), true),
    ).not.toThrow();
    expect(ws.close).toHaveBeenCalledWith(1011, "terminal input unavailable");
    expect(JSON.stringify(vi.mocked(ws.close).mock.calls)).not.toContain(
      "provider payload",
    );
  });
});
