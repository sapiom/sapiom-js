import { join } from "node:path";

import type {
  ProjectAgentSession,
  ProjectBootstrapErrorCode,
  ProjectBootstrapMetadata,
} from "../shared/agent-map.js";
import type { HarnessSession } from "../shared/types.js";

export type PersistedIdentityMigration = {
  identity?: ProjectAgentSession;
  bootstrap?: ProjectBootstrapMetadata;
  outcome: "unchanged" | "migrated" | "rejected";
};

const LEGACY_METADATA_KEY = "planning";

/**
 * Recognizes the infrastructure marker written into durable prompt events by
 * released pre-unification builds. Keep the retired record key isolated here:
 * it is decoder-only compatibility and never participates in live authority.
 */
export function isPreUnifiedInfrastructureBootstrapPayload(
  payload: Record<string, unknown>,
): boolean {
  return payload["plannerOrigin"] === "infrastructure";
}

/** The sole filesystem location for the retired project-session bootstrap store. */
export function legacyProjectSessionStateRoot(stateRoot: string): string {
  return join(stateRoot, "agent-map", "planner-sessions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProjectAgentSession(
  value: unknown,
  expectedSessionId: string,
): ProjectAgentSession | null {
  if (
    !isRecord(value) ||
    typeof value.projectId !== "string" ||
    value.projectId === "" ||
    typeof value.userId !== "string" ||
    value.userId === "" ||
    value.sessionId !== expectedSessionId
  ) {
    return null;
  }
  return {
    projectId: value.projectId,
    userId: value.userId,
    sessionId: expectedSessionId,
  };
}

function sameProjectAgent(
  left: ProjectAgentSession,
  right: ProjectAgentSession,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.userId === right.userId &&
    left.sessionId === right.sessionId
  );
}

function parseBootstrapState(
  value: unknown,
): ProjectBootstrapMetadata["bootstrap"] | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  switch (value.status) {
    case "pending":
      return { status: "pending" };
    case "generating":
      return typeof value.attemptId === "string" && value.attemptId !== ""
        ? { status: "generating", attemptId: value.attemptId }
        : null;
    case "delivered":
      return typeof value.messageId === "string" && value.messageId !== ""
        ? { status: "delivered", messageId: value.messageId }
        : null;
    case "failed":
      return typeof value.retryable === "boolean" &&
        typeof value.errorCode === "string" &&
        [
          "session_not_ready",
          "session_exited",
          "injection_failed",
          "model_turn_failed",
          "delivery_timeout",
          "persistence_failed",
          "scope_unavailable",
        ].includes(value.errorCode)
        ? {
            status: "failed",
            retryable: value.retryable,
            errorCode: value.errorCode as ProjectBootstrapErrorCode,
          }
        : null;
    case "skipped":
      return value.reason === "user-proceeded" ||
        value.reason === "map-not-empty"
        ? { status: "skipped", reason: value.reason }
        : null;
    default:
      return null;
  }
}

/**
 * Accepts the final neutral shape plus the frozen pre-cutover session shape.
 * Retired role and assignment fields are discarded and never become authority.
 */
export function migratePersistedProjectIdentity(
  session: HarnessSession,
): PersistedIdentityMigration {
  const raw = session as unknown as Record<string, unknown>;
  const direct = parseProjectAgentSession(raw.agentMapIdentity, session.id);
  const legacy = isRecord(raw[LEGACY_METADATA_KEY])
    ? raw[LEGACY_METADATA_KEY]
    : null;
  const priorIdentity =
    legacy && isRecord(legacy.identity)
      ? parseProjectAgentSession(legacy.identity, session.id)
      : null;
  if (raw.agentMapIdentity !== undefined && !direct) {
    return { outcome: "rejected" };
  }
  if (raw[LEGACY_METADATA_KEY] !== undefined && (!legacy || !priorIdentity)) {
    return { identity: direct ?? undefined, outcome: "rejected" };
  }
  if (direct && priorIdentity && !sameProjectAgent(direct, priorIdentity)) {
    return { outcome: "rejected" };
  }
  let identity = direct ?? priorIdentity ?? undefined;

  let bootstrap: ProjectBootstrapMetadata | undefined;
  const current = isRecord(raw.projectBootstrap) ? raw.projectBootstrap : null;
  if (raw.projectBootstrap !== undefined && !current) {
    return { identity, outcome: "rejected" };
  }
  if (current) {
    const currentIdentity = parseProjectAgentSession(
      {
        projectId: current.projectId,
        userId: current.userId,
        sessionId: current.targetSessionId,
      },
      session.id,
    );
    const state = parseBootstrapState(current.bootstrap);
    if (
      !currentIdentity ||
      !state ||
      !Array.isArray(current.queuedInputIds) ||
      !current.queuedInputIds.every((id) => typeof id === "string") ||
      (identity && !sameProjectAgent(identity, currentIdentity))
    ) {
      return { identity, outcome: "rejected" };
    }
    identity ??= currentIdentity;
    bootstrap = {
      projectId: currentIdentity.projectId,
      userId: currentIdentity.userId,
      targetSessionId: currentIdentity.sessionId,
      bootstrap: state,
      queuedInputIds: [...current.queuedInputIds],
    };
  } else if (legacy && priorIdentity) {
    const state = parseBootstrapState(legacy.greeting);
    if (
      !state ||
      !Array.isArray(legacy.queuedInputIds) ||
      !legacy.queuedInputIds.every((id) => typeof id === "string")
    ) {
      return { identity, outcome: "rejected" };
    }
    bootstrap = {
      projectId: priorIdentity.projectId,
      userId: priorIdentity.userId,
      targetSessionId: priorIdentity.sessionId,
      bootstrap: state,
      queuedInputIds: [...legacy.queuedInputIds],
    };
  }

  const hadLegacyIdentity =
    isRecord(raw.agentMapIdentity) &&
    ("role" in raw.agentMapIdentity || "assignment" in raw.agentMapIdentity);
  return {
    ...(identity ? { identity } : {}),
    ...(bootstrap ? { bootstrap } : {}),
    outcome:
      hadLegacyIdentity ||
      raw[LEGACY_METADATA_KEY] !== undefined ||
      (!!current && !direct)
        ? "migrated"
        : "unchanged",
  };
}

export function removeLegacyProjectSessionMetadata(
  session: HarnessSession,
): void {
  delete (session as unknown as Record<string, unknown>)[LEGACY_METADATA_KEY];
}
