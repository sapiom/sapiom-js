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

  it("slides expiry on authenticated use but remains bounded by lifecycle revocation", () => {
    let now = 100;
    const registry = new AgentMapCapabilityRegistry({
      ttlMs: 10,
      now: () => now,
      randomToken: () => "long-lived-session-token",
    });
    const issued = registry.issue(identity());
    expect(issued.expiresAt).toBe(110);

    now = 109;
    expect(registry.resolve(issued.token).expiresAt).toBe(119);
    now = 118;
    expect(registry.resolve(issued.token).expiresAt).toBe(128);
    expect(
      registry.isGenerationLive(identity().sessionId, issued.generation),
    ).toBe(true);

    registry.revokeSession(identity().sessionId);
    expect(() => registry.resolve(issued.token)).toThrowError(
      expect.objectContaining({ code: "revoked_capability" }),
    );
  });

  it("expires a capability after a full inactivity window", () => {
    let now = 100;
    const registry = new AgentMapCapabilityRegistry({
      ttlMs: 10,
      now: () => now,
      randomToken: () => "inactive-session-token",
    });
    const issued = registry.issue(identity());

    now = 109;
    registry.resolve(issued.token);
    now = 119;
    expect(() => registry.resolve(issued.token)).toThrowError(
      expect.objectContaining({ code: "expired_capability" }),
    );
  });
});
