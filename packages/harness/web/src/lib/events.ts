/**
 * /ws/events subscription (see the "Event-bus WebSocket" section of
 * ../../../src/shared/types.ts). No-op in mock mode — there's no server to
 * connect to, and the mock fixtures are static.
 */
import type { BusMessage } from "@shared/types";

import { DEMO_SESSION_ID, getBootToken, isDemoSeedEnabled, isMockMode } from "./api";
import { MOCK_ACTIVITY_SESSION_ID } from "./mock-data";

export type BusListener = (message: BusMessage) => void;

const RECONNECT_DELAY_MS = 2000;
/** Delay before the one-shot simulated `session.activity` fixture fires —
 *  see `subscribeEvents`'s mock branch. Long enough that the tab strip has
 *  already rendered idle before the pulse appears. */
const MOCK_ACTIVITY_DELAY_MS = 1200;
/** Delay before the one-shot demo `execution.started` fires — long enough that
 *  the chat pane has mounted (so its run-receipt logic seeds an empty
 *  baseline and the completed run lands a fresh receipt), and short enough to
 *  read as "on load". Its executionId must NOT contain "local" so the mock
 *  run-state endpoint returns the captured $0.0155 prod cost (see api.ts). */
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
  const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
  win.__HARNESS_TEST__ = {
    ...(win.__HARNESS_TEST__ ?? {}),
    publish: ((message) => mockListeners.forEach((listener) => listener(message))) as BusListener,
  };
}

/** Subscribes and returns an unsubscribe function. */
export function subscribeEvents(onMessage: BusListener): () => void {
  if (isMockMode()) {
    mockListeners.add(onMessage);
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
    // the Steps overlay, the Wallet's observed spend, and the chat run receipt
    // all populate on load from the authored run-state — the run pipeline the
    // real server drives via ExecutionDetector, minus the server. Off under
    // ?seed=0 (mechanics tests) and the fresh-install state (no boot session).
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
