/**
 * /ws/events subscription (see the "Event-bus WebSocket" section of
 * ../../../src/shared/types.ts). No-op in mock mode — there's no server to
 * connect to, and the mock fixtures are static.
 */
import type { EventConnection } from "./assistant-state";
import type { BusMessage } from "@shared/types";

import {
  DEMO_SESSION_ID,
  getBootToken,
  isDemoSeedEnabled,
  isMockMode,
} from "./api";
import { MOCK_ACTIVITY_SESSION_ID } from "./mock-data";
import { hasKnownBusMessageType } from "./bus-message-type";

export type BusListener = (message: BusMessage, generation?: number) => void;
let nextConnectionGeneration = 0;
export type EventReconnectListener = () => void;

const RECONNECT_DELAY_MS = 2000;
/** Delay before the one-shot simulated `session.activity` fixture fires —
 *  see `subscribeEvents`'s mock branch. Long enough that the tab strip has
 *  already rendered idle before the pulse appears. */
const MOCK_ACTIVITY_DELAY_MS = 1200;
/** Delay before the one-shot demo `execution.started` fires — long enough that
 *  the chat pane has mounted (so its run-receipt logic seeds an empty
 *  baseline and the completed run lands a fresh receipt), and short enough to
 *  read as "on load". The executionId marks a prod run (see api.ts). */
const DEMO_RUN_DELAY_MS = 700;
const DEMO_EXECUTION_ID = "exec-leasing-prod-001";

const mockListeners = new Set<BusListener>();
let mockActivitySimulated = false;
let demoRunSimulated = false;

/**
 * Mock mode only: lets other mock modules (api.ts's MockApi) publish a bus
 * message to subscribers — e.g. the deterministic canvas.reload the demo
 * Visualize flow fires. No-op with no listeners; never used in real mode.
 */
export function publishMockBusMessage(message: BusMessage): void {
  mockListeners.forEach((listener) => listener(message));
}

/**
 * Test-only escape hatch, mock mode only: lets Playwright simulate a bus
 * message (e.g. canvas.reload) without a real server. Never exists outside
 * VITE_MOCK=1.
 */
if (isMockMode() && typeof window !== "undefined") {
  // Merge rather than replace — api.ts's mock runMacro attaches its own key
  // (lastMacroRun) to the same test-only object, and module init order isn't
  // guaranteed either way.
  const win = window as unknown as {
    __HARNESS_TEST__?: Record<string, unknown>;
  };
  win.__HARNESS_TEST__ = {
    ...(win.__HARNESS_TEST__ ?? {}),
    publish: ((message) =>
      mockListeners.forEach((listener) => listener(message))) as BusListener,
  };
}

/** Subscribes and returns an unsubscribe function. */
export function subscribeEvents(
  onMessage: BusListener,
  onReconnect?: EventReconnectListener,
  onConnection?: (connection: EventConnection) => void,
): () => void {
  const deliver = (message: unknown, generation: number): void => {
    if (hasKnownBusMessageType(message))
      onMessage(message as BusMessage, generation);
  };
  if (isMockMode()) {
    const generation = ++nextConnectionGeneration;
    const receive = (message: BusMessage) => deliver(message, generation);
    onConnection?.({ generation, phase: "open" });
    mockListeners.add(receive);
    if (!mockActivitySimulated) {
      mockActivitySimulated = true;
      // Fixture nicety, not test infrastructure: shows the tab strip's busy
      // pulse without a real pty, once, shortly after load. Playwright drives
      // its own deterministic activity via `__HARNESS_TEST__.publish` (same
      // pattern as canvas.reload/port.detected in the harness's own specs)
      // rather than depending on this timer's exact fire time.
      setTimeout(() => {
        mockListeners.forEach((listener) =>
          listener({
            type: "session.activity",
            harnessSessionId: MOCK_ACTIVITY_SESSION_ID,
            at: new Date().toISOString(),
          }),
        );
      }, MOCK_ACTIVITY_DELAY_MS);
    }
    // Demo end-state: announce one completed prod run for the boot session, so
    // the Steps overlay and the chat run receipt both populate on load from
    // the authored run-state — the run pipeline the real server drives via
    // ExecutionDetector, minus the server. Off under ?seed=0 (mechanics
    // tests) and the fresh-install state (no boot session).
    if (!demoRunSimulated && isDemoSeedEnabled()) {
      demoRunSimulated = true;
      setTimeout(() => {
        mockListeners.forEach((listener) =>
          listener({
            type: "execution.started",
            harnessSessionId: DEMO_SESSION_ID,
            executionId: DEMO_EXECUTION_ID,
            target: "prod",
          }),
        );
      }, DEMO_RUN_DELAY_MS);
    }
    return () => {
      mockListeners.delete(receive);
      onConnection?.({ generation, phase: "closed" });
    };
  }

  const url = new URL("/ws/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", getBootToken());

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let opened = false;

  let generation = 0;
  const connect = (): void => {
    generation = ++nextConnectionGeneration;
    const currentGeneration = generation;
    onConnection?.({ generation, phase: "connecting" });
    const current = new WebSocket(url);
    socket = current;
    const isCurrent = () => !stopped && socket === current;
    current.addEventListener("open", () => {
      if (!isCurrent()) return;
      onConnection?.({ generation: currentGeneration, phase: "open" });
      if (opened) onReconnect?.();
      opened = true;
    });
    current.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      try {
        deliver(JSON.parse(event.data as string), currentGeneration);
      } catch {
        // Ignore malformed frames rather than tearing down the socket.
      }
    });
    current.addEventListener("close", () => {
      if (!isCurrent()) return;
      socket = null;
      onConnection?.({ generation: currentGeneration, phase: "closed" });
      retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  };
  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
    socket = null;
    onConnection?.({ generation, phase: "closed" });
  };
}
