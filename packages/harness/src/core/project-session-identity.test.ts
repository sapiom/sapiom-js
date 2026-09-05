import { describe, expect, it } from "vitest";

import type { PlanningSessionIdentity } from "../shared/agent-map.js";
import { resolveProjectSessionIdentity } from "./project-session-identity.js";

const projectId = "project_00000000-0000-4000-8000-000000000001";
const base = {
  sessionId: "session-1",
  projectId,
  userId: "user-1",
} as const;

const planned = {
  projectId,
  sessionId: "session-1",
  userId: "user-1",
  role: "agent-builder",
  assignment: { kind: "planned", agentId: "agent_1" },
} as PlanningSessionIdentity;

describe("resolveProjectSessionIdentity", () => {
  it("issues an unplanned builder identity when nothing is persisted", () => {
    expect(resolveProjectSessionIdentity(base)).toEqual({
      projectId,
      sessionId: "session-1",
      userId: "user-1",
      role: "agent-builder",
      assignment: { kind: "unplanned" },
    });
  });

  it("does NOT honor a persisted map-planner identity from 0.14.0 (SAP-3143)", () => {
    // The exact row 0.14.0 wrote for a planner session, matching on every
    // other field. It must come back as an ordinary builder, not resurrected.
    const persisted = {
      projectId,
      sessionId: "session-1",
      userId: "user-1",
      role: "map-planner",
    } as PlanningSessionIdentity;

    const resolved = resolveProjectSessionIdentity({ ...base, persisted });

    expect(resolved.role).toBe("agent-builder");
    expect(resolved).toMatchObject({ assignment: { kind: "unplanned" } });
  });

  it("honors a persisted PLANNED builder assignment, which is server-authored", () => {
    const resolved = resolveProjectSessionIdentity({ ...base, persisted: planned });

    expect(resolved).toEqual(planned);
    expect(resolved).not.toBe(planned);
  });

  it("re-issues rather than trusting a persisted row from another session, project, or principal", () => {
    for (const persisted of [
      { ...planned, sessionId: "other-session" },
      { ...planned, projectId: "project_00000000-0000-4000-8000-000000000002" },
      { ...planned, userId: "user-2" },
      { ...planned, assignment: { kind: "unplanned" } },
    ] as PlanningSessionIdentity[]) {
      const resolved = resolveProjectSessionIdentity({ ...base, persisted });
      expect(resolved).toMatchObject({
        projectId,
        sessionId: "session-1",
        userId: "user-1",
        role: "agent-builder",
        assignment: { kind: "unplanned" },
      });
    }
  });
});
