import { afterEach, expect, it, vi } from "vitest";
import type { BusMessage } from "@shared/types";

vi.mock("./api", () => ({
  isMockMode: () => true,
  isDemoSeedEnabled: () => false,
  getBootToken: () => "test-token",
  DEMO_SESSION_ID: "demo",
}));

import { publishMockBusMessage, subscribeEvents } from "./events";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("delivers supported events, ignores retired frames and removes its exact subscription", () => {
  vi.useFakeTimers();
  const listener = vi.fn();
  const unsubscribe = subscribeEvents(listener);
  const message: BusMessage = {
    type: "canvas.reload",
    harnessSessionId: "session-1",
  };
  try {
    for (const type of ["system-graph.changed", "future.event", "toString"])
      publishMockBusMessage({ type } as unknown as BusMessage);
    expect(listener).not.toHaveBeenCalled();
    publishMockBusMessage(message);
    expect(listener).toHaveBeenCalledExactlyOnceWith(message);
  } finally {
    unsubscribe();
  }
  publishMockBusMessage(message);
  expect(listener).toHaveBeenCalledTimes(1);
});
