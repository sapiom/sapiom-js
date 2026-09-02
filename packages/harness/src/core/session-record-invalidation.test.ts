import { describe, expect, it } from "vitest";
import type { AnalyticsEvent } from "../shared/types.js";

import { sessionRecordChangedMessage } from "./session-record-invalidation.js";

function event(type: AnalyticsEvent["type"]): AnalyticsEvent {
  return {
    eventId: `event-${type}`,
    type,
    ts: "2026-09-01T00:00:00.000Z",
    agentSessionId: "agent-session-1",
    harnessSessionId: "harness-session-1",
    harness: "claude-code",
    userId: null,
    tenantId: null,
    machineId: "machine-1",
    seq: 1,
    payload: {},
  };
}

describe("sessionRecordChangedMessage", () => {
  it.each(["prompt.submitted", "turn.completed"] as const)(
    "invalidates after %s without projecting content",
    (type) => {
      expect(sessionRecordChangedMessage(event(type))).toEqual({
        type: "session.record.changed",
        harnessSessionId: "harness-session-1",
      });
    },
  );

  it("ignores events that do not change the conversation projection", () => {
    expect(sessionRecordChangedMessage(event("tool.call"))).toBeNull();
    expect(sessionRecordChangedMessage(event("session.end"))).toBeNull();
  });
});
