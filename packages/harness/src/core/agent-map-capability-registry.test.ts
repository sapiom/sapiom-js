import { describe, expect, it, vi } from "vitest";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import {
  AgentMapCapabilityError,
  AgentMapCapabilityRegistry,
} from "./agent-map-capability-registry.js";

const identity = (sessionId = "session-1"): PlanningSessionIdentity => ({
  projectId: "project-a",
  sessionId,
  userId: "user-a",
  role: "agent-builder",
  assignment: { kind: "unplanned" },
});

describe("AgentMapCapabilityRegistry", () => {
  it("stores only a digest and rotates one generation per session", () => {
    const tokens = ["a".repeat(43), "b".repeat(43)];
    const registry = new AgentMapCapabilityRegistry({ randomToken: () => tokens.shift()! });
    const first = registry.issue(identity());
    expect(registry.resolve(first.token).identity).toEqual(identity());
    const second = registry.rotate(identity());
    expect(second.generation).toBe(first.generation + 1);
    expect(() => registry.resolve(first.token)).toThrowError(
      expect.objectContaining({ code: "revoked_capability" }),
    );
  });

  it("fails closed for expired, revoked and unknown tokens without emitting material", () => {
    let now = 10;
    const onEvent = vi.fn();
    const registry = new AgentMapCapabilityRegistry({
      ttlMs: 5,
      now: () => now,
      randomToken: () => "secret-token",
      onEvent,
    });
    const issued = registry.issue(identity());
    now = 15;
    expect(() => registry.resolve(issued.token)).toThrowError(AgentMapCapabilityError);
    expect(() => registry.resolve("other")).toThrowError(
      expect.objectContaining({ code: "invalid_capability" }),
    );
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("secret-token");
  });
});
