/**
 * /ws/events subscription (see the "Event-bus WebSocket" section of
 * ../../../src/shared/types.ts). No-op in mock mode — there's no server to
 * connect to, and the mock fixtures are static.
 */
import type { BusMessage } from "@shared/types";

import { getBootToken, isMockMode } from "./api";

export type BusListener = (message: BusMessage) => void;

const RECONNECT_DELAY_MS = 2000;

const mockListeners = new Set<BusListener>();

/**
 * Test-only escape hatch, mock mode only: lets Playwright simulate a bus
 * message (e.g. canvas.reload) without a real server. Never exists outside
 * VITE_MOCK=1.
 */
if (isMockMode() && typeof window !== "undefined") {
  (window as unknown as { __HARNESS_TEST__: { publish: BusListener } }).__HARNESS_TEST__ = {
    publish: (message) => mockListeners.forEach((listener) => listener(message)),
  };
}

/** Subscribes and returns an unsubscribe function. */
export function subscribeEvents(onMessage: BusListener): () => void {
  if (isMockMode()) {
    mockListeners.add(onMessage);
    return () => mockListeners.delete(onMessage);
  }

  const url = new URL("/ws/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", getBootToken());

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const connect = (): void => {
    socket = new WebSocket(url);
    socket.addEventListener("message", (event) => {
      try {
        onMessage(JSON.parse(event.data as string) as BusMessage);
      } catch {
        // Ignore malformed frames rather than tearing down the socket.
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  };
  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
