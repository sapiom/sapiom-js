import { describe, expect, it } from "vitest";
import { hasKnownBusMessageType } from "./bus-message-type";

describe("event transport discriminators", () => {
  it("keeps session, Canvas and durable-map events supported", () => {
    for (const type of [
      "session.status",
      "canvas.reload",
      "agent-map.proposal.changed",
    ])
      expect(hasKnownBusMessageType({ type })).toBe(true);
  });

  it.each([
    null,
    [],
    "canvas.reload",
    {},
    { type: "system-graph.changed" },
    { type: "future.event" },
    { type: "toString" },
    { type: 1 },
  ])("ignores retired, unknown or malformed event envelopes: %j", (value) =>
    expect(hasKnownBusMessageType(value)).toBe(false),
  );
});
