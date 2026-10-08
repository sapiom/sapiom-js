import type { ProjectAgentSession } from "@sapiom/agent-map";
import type { HarnessSession } from "../shared/types.js";

export type PersistedIdentityMigration = {
  identity?: ProjectAgentSession;
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

/**
 * Accepts the final neutral shape plus the frozen pre-cutover session shape.
 * Retired role, assignment, and project-bootstrap fields are discarded and
 * never become authority.
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

  // The retired "Plan Agents" bootstrap stored its own copy of the identity.
  // Only that identity survives; the bootstrap state itself is dropped.
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
    if (!currentIdentity || (identity && !sameProjectAgent(identity, currentIdentity))) {
      return { identity, outcome: "rejected" };
    }
    identity ??= currentIdentity;
  }

  const hadLegacyIdentity =
    isRecord(raw.agentMapIdentity) &&
    ("role" in raw.agentMapIdentity || "assignment" in raw.agentMapIdentity);
  return {
    ...(identity ? { identity } : {}),
    outcome:
      hadLegacyIdentity ||
      raw[LEGACY_METADATA_KEY] !== undefined ||
      !!current
        ? "migrated"
        : "unchanged",
  };
}

export function removeLegacyProjectSessionMetadata(
  session: HarnessSession,
): void {
  const raw = session as unknown as Record<string, unknown>;
  delete raw[LEGACY_METADATA_KEY];
  delete raw.projectBootstrap;
}
