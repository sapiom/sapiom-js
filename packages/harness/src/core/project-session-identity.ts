import type { PlanningSessionIdentity } from "../shared/agent-map.js";

/**
 * The Agent Map identity a session launches with.
 *
 * SAP-3143 removed planner sessions, so a project session is always an
 * ordinary `agent-builder`. A persisted identity is honored only when it is
 * still exactly this session's, in this project, for this principal, AND it is
 * a server-authored planned assignment; anything else (notably a persisted
 * `map-planner` row written by 0.14.0) is replaced with a fresh unplanned
 * builder identity rather than resurrected.
 *
 * Extracted from the server so the predicate that runs against a user's real
 * `sessions.json` on first boot after upgrade is directly testable.
 */
export function resolveProjectSessionIdentity(input: {
  sessionId: string;
  projectId: string;
  userId: string;
  persisted?: PlanningSessionIdentity;
}): PlanningSessionIdentity {
  const { sessionId, projectId, userId, persisted } = input;
  if (
    persisted?.sessionId === sessionId &&
    persisted.projectId === projectId &&
    persisted.userId === userId &&
    persisted.role === "agent-builder" &&
    persisted.assignment.kind === "planned"
  ) {
    return structuredClone(persisted);
  }
  return {
    projectId: projectId as PlanningSessionIdentity["projectId"],
    sessionId,
    userId,
    role: "agent-builder",
    assignment: { kind: "unplanned" },
  };
}
