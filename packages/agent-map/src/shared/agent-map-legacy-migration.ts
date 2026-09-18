import { isAgentMapBoundedText } from "./agent-map-codec.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

export interface LegacyE2ProposalActor {
  userId: string;
  sessionId: string;
  role: "map-planner" | "agent-builder";
  assignment:
    | { kind: "planned"; agentId: string }
    | { kind: "unplanned" }
    | null;
}

/**
 * Frozen decoder reachable only from the one deployed-E2 aggregate migration.
 * Its retired role fields are discarded immediately after validation.
 */
export function parseLegacyE2ProposalActor(
  value: unknown,
): LegacyE2ProposalActor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["userId", "sessionId", "role", "assignment"]) ||
    !isAgentMapBoundedText(value.userId, 256) ||
    !isAgentMapBoundedText(value.sessionId, 256)
  ) {
    throw new Error("invalid legacy Agent Map actor");
  }
  if (value.role === "map-planner" && value.assignment === null) {
    return structuredClone(value) as unknown as LegacyE2ProposalActor;
  }
  if (
    value.role !== "agent-builder" ||
    !isRecord(value.assignment) ||
    (value.assignment.kind === "planned"
      ? !hasExactKeys(value.assignment, ["kind", "agentId"]) ||
        !isAgentMapBoundedText(value.assignment.agentId, 256)
      : value.assignment.kind !== "unplanned" ||
        !hasExactKeys(value.assignment, ["kind"]))
  ) {
    throw new Error("invalid legacy Agent Map actor");
  }
  return structuredClone(value) as unknown as LegacyE2ProposalActor;
}
