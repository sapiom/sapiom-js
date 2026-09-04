import type {
  AgentMapVersionRef,
  ProjectAgentActorRef,
  ProjectMutationOrigin,
} from "./agent-map.js";
import {
  AGENT_MAP_UUID_V7_PATTERN,
  isAgentMapBoundedText,
  parseProjectAgentActorRef,
  parseProjectMutationOrigin,
} from "./agent-map-codec.js";
import {
  BUILD_PLAN_SCHEMA_VERSION,
  type AgentBriefFocusScope,
  type AgentBriefHistoryPointer,
  type AgentBriefVersion,
  type AgentBriefVersionRef,
  type BuildPlanCurrentPointers,
  type ProjectBuildPlanContent,
  type ProjectBuildPlanVersion,
  type ProjectBuildPlanVersionRef,
} from "./build-plan.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "../core/build-plan-canonicalization.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};
const id = (value: unknown, prefix: string): value is string =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_${AGENT_MAP_UUID_V7_PATTERN}$`, "u").test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const boundedStrings = (value: unknown, limit = 512): value is string[] =>
  Array.isArray(value) &&
  value.length <= 4_096 &&
  value.every((entry) => isAgentMapBoundedText(entry, limit)) &&
  new Set(value).size === value.length;

export function parseAgentMapVersionRef(
  value: unknown,
  expectedProjectId?: string,
): AgentMapVersionRef {
  if (
    !isRecord(value) || !exact(value, ["projectId", "versionId", "contentDigest"]) ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    (expectedProjectId !== undefined && value.projectId !== expectedProjectId) ||
    !id(value.versionId, "mapv") || !digest(value.contentDigest)
  ) throw new Error("invalid Agent Map version reference");
  return structuredClone(value) as unknown as AgentMapVersionRef;
}

export function parseProjectBuildPlanVersionRef(
  value: unknown,
  expectedProjectId?: string,
): ProjectBuildPlanVersionRef {
  if (
    !isRecord(value) ||
    !exact(value, ["projectId", "planId", "versionId", "semanticDigest"]) ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    (expectedProjectId !== undefined && value.projectId !== expectedProjectId) ||
    !id(value.planId, "plan") || !id(value.versionId, "planv") ||
    !digest(value.semanticDigest)
  ) throw new Error("invalid build plan version reference");
  return structuredClone(value) as unknown as ProjectBuildPlanVersionRef;
}

export function parseAgentBriefVersionRef(
  value: unknown,
  expectedProjectId?: string,
): AgentBriefVersionRef {
  if (
    !isRecord(value) ||
    !exact(value, ["projectId", "briefId", "versionId", "semanticDigest"]) ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    (expectedProjectId !== undefined && value.projectId !== expectedProjectId) ||
    !id(value.briefId, "brief") || !id(value.versionId, "briefv") ||
    !digest(value.semanticDigest)
  ) throw new Error("invalid brief version reference");
  return structuredClone(value) as unknown as AgentBriefVersionRef;
}

function parseMilestone(value: unknown) {
  if (!isRecord(value) || !exact(value, ["id", "ordinal", "title", "outcome", "dependsOn"]) ||
    !id(value.id, "milestone") || !positive(value.ordinal) ||
    !isAgentMapBoundedText(value.title, 512) || !isAgentMapBoundedText(value.outcome, 4_096) ||
    !Array.isArray(value.dependsOn) || !value.dependsOn.every((entry) => id(entry, "milestone")) ||
    new Set(value.dependsOn).size !== value.dependsOn.length)
    throw new Error("invalid build plan milestone");
  return structuredClone(value);
}

function parseSequenceGate(value: unknown) {
  if (!isRecord(value) || !exact(value, ["id", "ordinal", "description", "milestoneIds"]) ||
    !id(value.id, "gate") || !positive(value.ordinal) ||
    !isAgentMapBoundedText(value.description, 4_096) || !Array.isArray(value.milestoneIds) ||
    !value.milestoneIds.every((entry) => id(entry, "milestone")) ||
    new Set(value.milestoneIds).size !== value.milestoneIds.length)
    throw new Error("invalid build plan sequence gate");
  return structuredClone(value);
}

function parseRepositoryIntent(value: unknown) {
  if (!isRecord(value) || !exact(value, ["id", "plannedAgentId", "repository", "packages", "ownershipBoundaries"]) ||
    !isAgentMapBoundedText(value.id, 128) || !id(value.plannedAgentId, "node") ||
    !isAgentMapBoundedText(value.repository, 512) || !boundedStrings(value.packages) ||
    !boundedStrings(value.ownershipBoundaries, 2_000))
    throw new Error("invalid repository intent");
  return structuredClone(value);
}

function parseDecision(value: unknown) {
  if (!isRecord(value) || !exact(value, ["id", "question", "resolution", "status"]) ||
    !id(value.id, "decision") || !isAgentMapBoundedText(value.question, 4_096) ||
    !isAgentMapBoundedText(value.resolution, 4_096, true) || !["open", "resolved"].includes(String(value.status)))
    throw new Error("invalid plan decision");
  return structuredClone(value);
}

function parseRisk(value: unknown) {
  if (!isRecord(value) || !exact(value, ["id", "description", "mitigation"]) ||
    !id(value.id, "risk") || !isAgentMapBoundedText(value.description, 4_096) ||
    !isAgentMapBoundedText(value.mitigation, 4_096, true))
    throw new Error("invalid plan risk");
  return structuredClone(value);
}

function parseAssignment(value: unknown) {
  if (!isRecord(value) || !exact(value, ["id", "plannedAgentId", "briefId", "mission", "scope", "nonGoals", "dependencies"]) ||
    !id(value.id, "work") || !id(value.plannedAgentId, "node") ||
    (value.briefId !== null && !id(value.briefId, "brief")) ||
    !isAgentMapBoundedText(value.mission, 4_096) || !boundedStrings(value.scope, 2_000) ||
    !boundedStrings(value.nonGoals, 2_000) || !Array.isArray(value.dependencies) ||
    value.dependencies.length > 4_096 || !value.dependencies.every((dependency) =>
      isRecord(dependency) && exact(dependency, ["id", "kind", "nodeId", "relationshipIds", "contractRef"]) &&
      id(dependency.id, "dependency") && ["input", "output", "shared-resource", "depends-on"].includes(String(dependency.kind)) &&
      id(dependency.nodeId, "node") && Array.isArray(dependency.relationshipIds) &&
      dependency.relationshipIds.every((relationshipId) => id(relationshipId, "rel")) &&
      new Set(dependency.relationshipIds).size === dependency.relationshipIds.length &&
      (dependency.contractRef === null || isAgentMapBoundedText(dependency.contractRef, 256))))
    throw new Error("invalid plan assignment");
  if (new Set(value.dependencies.map((dependency) => (dependency as { id: string }).id)).size !== value.dependencies.length)
    throw new Error("duplicate plan dependency");
  return structuredClone(value);
}

export function parseProjectBuildPlanContent(value: unknown): ProjectBuildPlanContent {
  if (!isRecord(value) || !exact(value, [
    "outcome", "nonGoals", "milestones", "sequenceGates", "sharedConstraints",
    "repositoryIntents", "integrationCriteria", "acceptanceCriteria", "decisions",
    "assignments", "unresolvedDecisions", "risks",
  ]) || !isAgentMapBoundedText(value.outcome, 8_192, true) ||
    !boundedStrings(value.nonGoals, 2_000) || !Array.isArray(value.milestones) ||
    !Array.isArray(value.sequenceGates) || !boundedStrings(value.sharedConstraints, 2_000) ||
    !Array.isArray(value.repositoryIntents) || !boundedStrings(value.integrationCriteria, 2_000) ||
    !boundedStrings(value.acceptanceCriteria, 2_000) || !Array.isArray(value.decisions) ||
    !Array.isArray(value.assignments) || !Array.isArray(value.unresolvedDecisions) ||
    !Array.isArray(value.risks)) throw new Error("invalid build plan content");
  const parsed = {
    outcome: value.outcome,
    nonGoals: structuredClone(value.nonGoals),
    milestones: value.milestones.map(parseMilestone),
    sequenceGates: value.sequenceGates.map(parseSequenceGate),
    sharedConstraints: structuredClone(value.sharedConstraints),
    repositoryIntents: value.repositoryIntents.map(parseRepositoryIntent),
    integrationCriteria: structuredClone(value.integrationCriteria),
    acceptanceCriteria: structuredClone(value.acceptanceCriteria),
    decisions: value.decisions.map(parseDecision),
    assignments: value.assignments.map(parseAssignment),
    unresolvedDecisions: value.unresolvedDecisions.map(parseDecision),
    risks: value.risks.map(parseRisk),
  } as unknown as ProjectBuildPlanContent;
  const identifiers = [parsed.milestones, parsed.sequenceGates, parsed.repositoryIntents,
    parsed.decisions, parsed.assignments, parsed.unresolvedDecisions, parsed.risks]
    .flatMap((entries) => entries.map(({ id: entryId }) => entryId));
  if (new Set(identifiers).size !== identifiers.length)
    throw new Error("duplicate build plan identity");
  return parsed;
}

function parseVersionBase(value: Record<string, unknown>, prefix: "planv" | "briefv") {
  if (value.schemaVersion !== BUILD_PLAN_SCHEMA_VERSION || !isAgentMapBoundedText(value.projectId, 128) ||
    !id(value.versionId, prefix) || !positive(value.version) ||
    (value.parentVersionId !== null && !id(value.parentVersionId, prefix)) ||
    !["created", "edited", "rebased", "restored", "migrated"].includes(String(value.changeKind)) ||
    (value.restoredFromVersionId !== null && !id(value.restoredFromVersionId, prefix)) ||
    (value.changeKind === "restored") !== (value.restoredFromVersionId !== null) ||
    !timestamp(value.createdAt) || !digest(value.recordDigest))
    throw new Error("invalid immutable planning version");
}

export function parseProjectBuildPlanVersion(value: unknown, expectedProjectId?: string): ProjectBuildPlanVersion {
  if (!isRecord(value) || !exact(value, ["schemaVersion", "projectId", "planId", "versionId", "version",
    "parentVersionId", "changeKind", "restoredFromVersionId", "map", "content", "semanticDigest",
    "authoredBy", "createdAt", "origin", "recordDigest"]) || !id(value.planId, "plan") ||
    !digest(value.semanticDigest)) throw new Error("invalid build plan version");
  parseVersionBase(value, "planv");
  if (expectedProjectId !== undefined && value.projectId !== expectedProjectId)
    throw new Error("cross-project build plan");
  const parsed = { ...structuredClone(value), map: parseAgentMapVersionRef(value.map, value.projectId as string),
    content: parseProjectBuildPlanContent(value.content), authoredBy: parseProjectAgentActorRef(value.authoredBy),
    origin: parseProjectMutationOrigin(value.origin) } as unknown as ProjectBuildPlanVersion;
  if (computeBuildPlanSemanticDigest(parsed) !== parsed.semanticDigest ||
    computeBuildPlanRecordDigest(parsed) !== parsed.recordDigest) throw new Error("build plan digest mismatch");
  return parsed;
}

export function parseAgentBriefFocusScope(value: unknown): AgentBriefFocusScope {
  if (!isRecord(value)) throw new Error("invalid brief focus scope");
  if (value.family === "canonical-workstream" && exact(value, ["family", "plannedAgentId"]) && id(value.plannedAgentId, "node"))
    return structuredClone(value) as unknown as AgentBriefFocusScope;
  if (value.family === "ad-hoc-delegation" && exact(value, ["family", "delegationKey", "parentScopeKey"]) &&
    isAgentMapBoundedText(value.delegationKey, 256) &&
    (value.parentScopeKey === null || isAgentMapBoundedText(value.parentScopeKey, 256)))
    return structuredClone(value) as unknown as AgentBriefFocusScope;
  throw new Error("invalid brief focus scope");
}

function parseBriefContent(value: unknown): AgentBriefVersion["content"] {
  const keys = ["mission", "scope", "nonGoals", "ownedNodeIds", "relevantNodeIds", "inputs", "outputs",
    "dependencies", "sharedResourceNodeIds", "sequenceGateIds", "deliverables", "acceptanceCriteria",
    "constraints", "milestoneIds", "unresolvedDecisionIds"];
  if (!isRecord(value) || !exact(value, keys) || !isAgentMapBoundedText(value.mission, 4_096) ||
    !keys.slice(1).every((key) => Array.isArray(value[key])) ||
    !boundedStrings(value.scope, 2_000) || !boundedStrings(value.nonGoals, 2_000) ||
    !boundedStrings(value.inputs, 2_000) || !boundedStrings(value.outputs, 2_000) ||
    !boundedStrings(value.dependencies, 2_000) || !boundedStrings(value.deliverables, 2_000) ||
    !boundedStrings(value.acceptanceCriteria, 2_000) || !boundedStrings(value.constraints, 2_000) ||
    ![...value.ownedNodeIds as unknown[], ...value.relevantNodeIds as unknown[], ...value.sharedResourceNodeIds as unknown[]].every((entry) => id(entry, "node")) ||
    !(value.sequenceGateIds as unknown[]).every((entry) => id(entry, "gate")) ||
    !(value.milestoneIds as unknown[]).every((entry) => id(entry, "milestone")) ||
    !(value.unresolvedDecisionIds as unknown[]).every((entry) => id(entry, "decision")))
    throw new Error("invalid brief content");
  return structuredClone(value) as unknown as AgentBriefVersion["content"];
}

export function parseAgentBriefVersion(value: unknown, expectedProjectId?: string): AgentBriefVersion {
  if (!isRecord(value) || !exact(value, ["schemaVersion", "projectId", "briefId", "scopeKey", "focusScope",
    "versionId", "version", "parentVersionId", "changeKind", "restoredFromVersionId", "assignmentId",
    "plannedAgentId", "map", "plan", "content", "compilerVersion", "compilerInputFingerprint",
    "semanticDigest", "authoredBy", "createdAt", "origin", "recordDigest"]) || !id(value.briefId, "brief") ||
    !isAgentMapBoundedText(value.scopeKey, 256) || !id(value.assignmentId, "work") ||
    !id(value.plannedAgentId, "node") || !isAgentMapBoundedText(value.compilerVersion, 128) ||
    !digest(value.compilerInputFingerprint) || !digest(value.semanticDigest)) throw new Error("invalid brief version");
  parseVersionBase(value, "briefv");
  if (expectedProjectId !== undefined && value.projectId !== expectedProjectId) throw new Error("cross-project brief");
  const parsed = { ...structuredClone(value), focusScope: parseAgentBriefFocusScope(value.focusScope),
    map: parseAgentMapVersionRef(value.map, value.projectId as string),
    plan: parseProjectBuildPlanVersionRef(value.plan, value.projectId as string), content: parseBriefContent(value.content),
    authoredBy: parseProjectAgentActorRef(value.authoredBy), origin: parseProjectMutationOrigin(value.origin) } as unknown as AgentBriefVersion;
  if (computeAgentBriefSemanticDigest(parsed) !== parsed.semanticDigest ||
    computeAgentBriefRecordDigest(parsed) !== parsed.recordDigest) throw new Error("brief digest mismatch");
  return parsed;
}

export function parseBuildPlanCurrentPointers(value: unknown, expectedProjectId: string): BuildPlanCurrentPointers {
  if (!isRecord(value) || !exact(value, ["map", "buildPlan", "briefsByScope"]) || !isRecord(value.briefsByScope))
    throw new Error("invalid planning pointers");
  const briefsByScope: Record<string, AgentBriefHistoryPointer> = {};
  for (const [scopeKey, pointer] of Object.entries(value.briefsByScope)) {
    if (!isRecord(pointer) || !exact(pointer, ["scopeKey", "focusScope", "briefId", "status", "version"]) ||
      pointer.scopeKey !== scopeKey || !isAgentMapBoundedText(scopeKey, 256) || !id(pointer.briefId, "brief") ||
      !["active", "retired"].includes(String(pointer.status))) throw new Error("invalid brief pointer");
    briefsByScope[scopeKey] = { ...structuredClone(pointer), focusScope: parseAgentBriefFocusScope(pointer.focusScope),
      version: parseAgentBriefVersionRef(pointer.version, expectedProjectId) } as AgentBriefHistoryPointer;
  }
  return { map: value.map === null ? null : parseAgentMapVersionRef(value.map, expectedProjectId),
    buildPlan: value.buildPlan === null ? null : parseProjectBuildPlanVersionRef(value.buildPlan, expectedProjectId),
    briefsByScope };
}

export { parseProjectAgentActorRef, parseProjectMutationOrigin };
export type { ProjectAgentActorRef, ProjectMutationOrigin };
