import type { AgentMapVersion } from "./agent-map.js";
import {
  AGENT_MAP_UUID_V7_PATTERN,
  isAgentMapBoundedText,
  parseAgentMapGraph,
  parseProjectAgentActorRef,
  parseProjectMutationOrigin,
} from "./agent-map-codec.js";
import {
  computeAgentMapVersionRecordDigest,
  computeGraphContentDigest,
} from "./agent-map-canonical.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const isGeneratedId = (value: unknown, prefix: string): value is string =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_${AGENT_MAP_UUID_V7_PATTERN}$`, "u").test(value);

const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

/** Strict server-side decoder with full semantic and record integrity checks. */
export function parseAgentMapVersion(
  value: unknown,
  expectedProjectId?: string,
): AgentMapVersion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "projectId",
      "versionId",
      "version",
      "parentVersionId",
      "changeKind",
      "restoredFromVersionId",
      "graph",
      "contentDigest",
      "authoredBy",
      "createdAt",
      "origin",
      "recordDigest",
    ]) ||
    value.schemaVersion !== 1 ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    (expectedProjectId !== undefined && value.projectId !== expectedProjectId) ||
    !isGeneratedId(value.versionId, "mapv") ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    (value.parentVersionId !== null && !isGeneratedId(value.parentVersionId, "mapv")) ||
    !["created", "edited", "rebased", "restored", "migrated"].includes(String(value.changeKind)) ||
    (value.restoredFromVersionId !== null && !isGeneratedId(value.restoredFromVersionId, "mapv")) ||
    (value.changeKind === "restored") !== (value.restoredFromVersionId !== null) ||
    typeof value.contentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contentDigest) ||
    !isTimestamp(value.createdAt) ||
    typeof value.recordDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.recordDigest)
  )
    throw new Error("invalid Agent Map version");
  const parsed = {
    ...structuredClone(value),
    graph: parseAgentMapGraph(value.graph),
    authoredBy: parseProjectAgentActorRef(value.authoredBy),
    origin: parseProjectMutationOrigin(value.origin),
  } as unknown as AgentMapVersion;
  if (
    computeGraphContentDigest(parsed.graph) !== parsed.contentDigest ||
    computeAgentMapVersionRecordDigest(parsed) !== parsed.recordDigest
  )
    throw new Error("Agent Map version digest mismatch");
  return parsed;
}
