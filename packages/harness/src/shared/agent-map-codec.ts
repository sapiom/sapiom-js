import {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  EXECUTION_MODES,
  PLAN_NODE_KINDS,
  RELATIONSHIP_KINDS,
  type DraftRef,
  type AcceptedProposalDelta,
  type MapChangeProposal,
  type MapOperation,
  type PlanNode,
  type PlanNodeId,
  type PlanRelationship,
  type PlanRelationshipId,
  type ProposalActor,
  type ProposalBatchResult,
  type AgentMapGraph,
  type ProjectAgentActorRef,
  type ProjectMutationOrigin,
} from "./agent-map.js";

export const AGENT_MAP_UUID_V7_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function hasAgentMapControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isAgentMapBoundedText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    value.trim() === value &&
    !hasAgentMapControlCharacter(value)
  );
}

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

const isPlanId = (value: unknown, prefix: string): value is string =>
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

const isContractRefs = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every((entry) => isAgentMapBoundedText(entry, 512)) &&
  new Set(value).size === value.length;

function parseNode(value: unknown): PlanNode {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "kind",
      "name",
      "purpose",
      "ownerAgentId",
      "contractRefs",
    ]) ||
    !isPlanId(value.id, "node") ||
    !PLAN_NODE_KINDS.includes(value.kind as (typeof PLAN_NODE_KINDS)[number]) ||
    !isAgentMapBoundedText(value.name, 160) ||
    !isAgentMapBoundedText(value.purpose, 2_000) ||
    (value.ownerAgentId !== null && !isPlanId(value.ownerAgentId, "node")) ||
    !isContractRefs(value.contractRefs)
  )
    throw new Error("invalid Agent Map node");
  return structuredClone(value) as unknown as PlanNode;
}

function parseRelationship(value: unknown): PlanRelationship {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "fromNodeId",
      "toNodeId",
      "kind",
      "executionMode",
      "contractRef",
      "description",
    ]) ||
    !isPlanId(value.id, "rel") ||
    !isPlanId(value.fromNodeId, "node") ||
    !isPlanId(value.toNodeId, "node") ||
    !RELATIONSHIP_KINDS.includes(
      value.kind as (typeof RELATIONSHIP_KINDS)[number],
    ) ||
    (value.executionMode !== null &&
      !EXECUTION_MODES.includes(
        value.executionMode as (typeof EXECUTION_MODES)[number],
      )) ||
    (value.contractRef !== null &&
      !isAgentMapBoundedText(value.contractRef, 512)) ||
    !isAgentMapBoundedText(value.description, 2_000, true)
  )
    throw new Error("invalid Agent Map relationship");
  return structuredClone(value) as unknown as PlanRelationship;
}

export function parseAgentMapGraph(value: unknown): AgentMapGraph {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["nodes", "relationships"]) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.relationships) ||
    value.nodes.length > 4_096 ||
    value.relationships.length > 16_384
  )
    throw new Error("invalid Agent Map graph");
  const nodes = value.nodes.map(parseNode);
  const relationships = value.relationships.map(parseRelationship);
  const nodeIds = new Set(nodes.map(({ id }) => id));
  if (
    nodeIds.size !== nodes.length ||
    new Set(relationships.map(({ id }) => id)).size !== relationships.length ||
    nodes.some(
      ({ ownerAgentId }) => ownerAgentId !== null && !nodeIds.has(ownerAgentId),
    ) ||
    relationships.some(
      ({ fromNodeId, toNodeId }) =>
        !nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId),
    )
  )
    throw new Error("inconsistent Agent Map graph");
  return { nodes, relationships };
}

export function parseProjectAgentActorRef(
  value: unknown,
): ProjectAgentActorRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["userId", "sessionId"]) ||
    !isAgentMapBoundedText(value.userId, 256) ||
    !isAgentMapBoundedText(value.sessionId, 256)
  )
    throw new Error("invalid project agent actor");
  return { userId: value.userId, sessionId: value.sessionId };
}

export function parseProjectMutationOrigin(
  value: unknown,
): ProjectMutationOrigin {
  const requestKeys = ["kind", "requestDigest", "operationIds", "touchKeys"];
  const migrationKeys = [
    ...requestKeys,
    "legacyProposalId",
    "legacyAcceptedVersion",
  ];
  if (
    !isRecord(value) ||
    !["request", "migration"].includes(String(value.kind)) ||
    !hasExactKeys(value, value.kind === "migration" ? migrationKeys : requestKeys) ||
    typeof value.requestDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.requestDigest) ||
    !Array.isArray(value.operationIds) ||
    value.operationIds.length > 4_096 ||
    !value.operationIds.every((id) => isPlanId(id, "operation")) ||
    new Set(value.operationIds).size !== value.operationIds.length ||
    !Array.isArray(value.touchKeys) ||
    value.touchKeys.length > 16_384 ||
    !value.touchKeys.every((key) => isAgentMapBoundedText(key, 512)) ||
    new Set(value.touchKeys).size !== value.touchKeys.length
  )
    throw new Error("invalid project mutation origin");
  if (
    value.kind === "migration" &&
    ((value.legacyProposalId !== null && !isPlanId(value.legacyProposalId, "proposal")) ||
      (value.legacyAcceptedVersion !== null &&
        (!Number.isSafeInteger(value.legacyAcceptedVersion) ||
          (value.legacyAcceptedVersion as number) < 1)))
  )
    throw new Error("invalid project mutation origin");
  return structuredClone(value) as unknown as ProjectMutationOrigin;
}

function parseNodeChanges(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !Object.keys(value).every((key) =>
      ["name", "purpose", "contractRefs"].includes(key),
    ) ||
    ("name" in value && !isAgentMapBoundedText(value.name, 160)) ||
    ("purpose" in value && !isAgentMapBoundedText(value.purpose, 2_000)) ||
    ("contractRefs" in value && !isContractRefs(value.contractRefs))
  )
    throw new Error("invalid Agent Map node changes");
  return structuredClone(value);
}

function parseRelationshipChanges(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !Object.keys(value).every((key) =>
      ["description", "executionMode", "contractRef"].includes(key),
    ) ||
    ("description" in value &&
      !isAgentMapBoundedText(value.description, 2_000, true)) ||
    ("executionMode" in value &&
      value.executionMode !== null &&
      !EXECUTION_MODES.includes(
        value.executionMode as (typeof EXECUTION_MODES)[number],
      )) ||
    ("contractRef" in value &&
      value.contractRef !== null &&
      !isAgentMapBoundedText(value.contractRef, 512))
  )
    throw new Error("invalid Agent Map relationship changes");
  return structuredClone(value);
}

export function parseMapOperation(value: unknown): MapOperation {
  if (!isRecord(value) || typeof value.kind !== "string")
    throw new Error("invalid Agent Map operation");
  switch (value.kind) {
    case "add-node":
      if (!hasExactKeys(value, ["kind", "node"]))
        throw new Error("invalid Agent Map operation");
      return { kind: value.kind, node: parseNode(value.node) };
    case "update-node":
      if (
        !hasExactKeys(value, ["kind", "nodeId", "changes"]) ||
        !isPlanId(value.nodeId, "node")
      )
        throw new Error("invalid Agent Map operation");
      return {
        kind: value.kind,
        nodeId: value.nodeId as PlanNodeId,
        changes: parseNodeChanges(value.changes),
      } as MapOperation;
    case "remove-node":
      if (
        !hasExactKeys(value, ["kind", "nodeId"]) ||
        !isPlanId(value.nodeId, "node")
      )
        throw new Error("invalid Agent Map operation");
      return { kind: value.kind, nodeId: value.nodeId as PlanNodeId };
    case "add-relationship":
      if (!hasExactKeys(value, ["kind", "relationship"]))
        throw new Error("invalid Agent Map operation");
      return {
        kind: value.kind,
        relationship: parseRelationship(value.relationship),
      };
    case "update-relationship":
      if (
        !hasExactKeys(value, ["kind", "relationshipId", "changes"]) ||
        !isPlanId(value.relationshipId, "rel")
      )
        throw new Error("invalid Agent Map operation");
      return {
        kind: value.kind,
        relationshipId: value.relationshipId as PlanRelationshipId,
        changes: parseRelationshipChanges(value.changes),
      } as MapOperation;
    case "remove-relationship":
      if (
        !hasExactKeys(value, ["kind", "relationshipId"]) ||
        !isPlanId(value.relationshipId, "rel")
      )
        throw new Error("invalid Agent Map operation");
      return {
        kind: value.kind,
        relationshipId: value.relationshipId as PlanRelationshipId,
      };
    default:
      throw new Error("invalid Agent Map operation");
  }
}

/** Strict, path-free parser for post-commit proposal notifications. */
export function parseAcceptedProposalDelta(
  value: unknown,
  expectedProjectId?: string,
): AcceptedProposalDelta {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "projectId",
      "proposalId",
      "fromVersion",
      "version",
      "operationIds",
      "operations",
      "actor",
      "acceptedAt",
    ]) ||
    value.schemaVersion !== AGENT_MAP_PROPOSAL_SCHEMA_VERSION ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    (expectedProjectId !== undefined &&
      value.projectId !== expectedProjectId) ||
    !isPlanId(value.proposalId, "proposal") ||
    !Number.isSafeInteger(value.fromVersion) ||
    (value.fromVersion as number) < 0 ||
    !Number.isSafeInteger(value.version) ||
    value.version !== (value.fromVersion as number) + 1 ||
    !Array.isArray(value.operationIds) ||
    !Array.isArray(value.operations) ||
    value.operationIds.length === 0 ||
    value.operationIds.length !== value.operations.length ||
    !value.operationIds.every((id) => isPlanId(id, "operation")) ||
    new Set(value.operationIds).size !== value.operationIds.length ||
    !isTimestamp(value.acceptedAt)
  ) {
    throw new Error("invalid Agent Map proposal delta");
  }
  return {
    schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
    projectId: value.projectId,
    proposalId: value.proposalId,
    fromVersion: value.fromVersion as number,
    version: value.version as number,
    operationIds: structuredClone(
      value.operationIds,
    ) as AcceptedProposalDelta["operationIds"],
    operations: value.operations.map(parseMapOperation),
    actor: parseProposalActor(value.actor),
    acceptedAt: value.acceptedAt,
  } as AcceptedProposalDelta;
}

export function parseProposalActor(value: unknown): ProposalActor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["userId", "sessionId"]) ||
    !isAgentMapBoundedText(value.userId, 256) ||
    !isAgentMapBoundedText(value.sessionId, 256)
  )
    throw new Error("invalid Agent Map actor");
  return { userId: value.userId, sessionId: value.sessionId };
}

export interface LegacyE2ProposalActor {
  userId: string;
  sessionId: string;
  role: "map-planner" | "agent-builder";
  assignment:
    | { kind: "planned"; agentId: string }
    | { kind: "unplanned" }
    | null;
}

/** Frozen decoder used only by the direct deployed-E2 migration. */
export function parseLegacyE2ProposalActor(value: unknown): LegacyE2ProposalActor {
  if (!isRecord(value) || !hasExactKeys(value, ["userId", "sessionId", "role", "assignment"]) ||
    !isAgentMapBoundedText(value.userId, 256) || !isAgentMapBoundedText(value.sessionId, 256))
    throw new Error("invalid legacy Agent Map actor");
  if (value.role === "map-planner" && value.assignment === null)
    return structuredClone(value) as unknown as LegacyE2ProposalActor;
  if (value.role !== "agent-builder" || !isRecord(value.assignment) ||
    (value.assignment.kind === "planned"
      ? !hasExactKeys(value.assignment, ["kind", "agentId"]) || !isAgentMapBoundedText(value.assignment.agentId, 256)
      : value.assignment.kind !== "unplanned" || !hasExactKeys(value.assignment, ["kind"])))
    throw new Error("invalid legacy Agent Map actor");
  return structuredClone(value) as unknown as LegacyE2ProposalActor;
}

export function parseMapChangeProposal(
  value: unknown,
  projectId?: string,
  activeProposalId?: string,
): MapChangeProposal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "id",
      "projectId",
      "baseRevisionId",
      "version",
      "nodes",
      "relationships",
      "history",
      "createdAt",
      "updatedAt",
    ]) ||
    value.schemaVersion !== AGENT_MAP_PROPOSAL_SCHEMA_VERSION ||
    !isPlanId(value.id, "proposal") ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    (projectId !== undefined && value.projectId !== projectId) ||
    (activeProposalId !== undefined && value.id !== activeProposalId) ||
    (value.baseRevisionId !== null &&
      !isAgentMapBoundedText(value.baseRevisionId, 256)) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.relationships) ||
    !Array.isArray(value.history) ||
    value.history.length === 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  )
    throw new Error("invalid Agent Map proposal");

  const nodes = value.nodes.map(parseNode);
  const relationships = value.relationships.map(parseRelationship);
  const history = value.history.map((record) => {
    if (
      !isRecord(record) ||
      !hasExactKeys(record, [
        "id",
        "requestId",
        "acceptedVersion",
        "operation",
        "actor",
        "acceptedAt",
      ]) ||
      !isPlanId(record.id, "operation") ||
      !isAgentMapBoundedText(record.requestId, 128) ||
      !Number.isSafeInteger(record.acceptedVersion) ||
      (record.acceptedVersion as number) < 1 ||
      !isTimestamp(record.acceptedAt)
    )
      throw new Error("invalid Agent Map history");
    return {
      id: record.id,
      requestId: record.requestId,
      acceptedVersion: record.acceptedVersion as number,
      operation: parseMapOperation(record.operation),
      actor: parseProposalActor(record.actor),
      acceptedAt: record.acceptedAt,
    };
  });
  const versions = history.map(({ acceptedVersion }) => acceptedVersion);
  const uniqueVersions = [...new Set(versions)];
  const nodeIds = new Set(nodes.map(({ id }) => id));
  if (
    new Set(nodes.map(({ id }) => id)).size !== nodes.length ||
    new Set(relationships.map(({ id }) => id)).size !== relationships.length ||
    new Set(history.map(({ id }) => id)).size !== history.length ||
    uniqueVersions.some((version, index) => version !== index + 1) ||
    versions.some(
      (version, index) => index > 0 && version < versions[index - 1]!,
    ) ||
    versions.at(-1) !== value.version ||
    nodes.some(
      ({ ownerAgentId }) => ownerAgentId !== null && !nodeIds.has(ownerAgentId),
    ) ||
    relationships.some(
      ({ fromNodeId, toNodeId }) =>
        !nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId),
    )
  )
    throw new Error("inconsistent Agent Map proposal");
  return {
    schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
    id: value.id,
    projectId: value.projectId,
    baseRevisionId: value.baseRevisionId,
    version: value.version as number,
    nodes,
    relationships,
    history,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  } as MapChangeProposal;
}

export interface PersistedAgentMapProposalReceipt {
  sessionId: string;
  requestId: string;
  requestDigest: string;
  version: number;
  allocatedNodeIds: ProposalBatchResult["allocatedNodeIds"];
  allocatedRelationshipIds: ProposalBatchResult["allocatedRelationshipIds"];
}

const parseAllocationMap = (
  value: unknown,
  prefix: "node" | "rel",
): Record<DraftRef, PlanNodeId | PlanRelationshipId> => {
  if (
    !isRecord(value) ||
    Object.keys(value).length > 256 ||
    !Object.entries(value).every(
      ([draftRef, id]) =>
        isAgentMapBoundedText(draftRef, 128) && isPlanId(id, prefix),
    )
  )
    throw new Error("invalid Agent Map allocation map");
  return structuredClone(value) as Record<
    DraftRef,
    PlanNodeId | PlanRelationshipId
  >;
};

export function parseAgentMapProposalReceipt(
  value: unknown,
): PersistedAgentMapProposalReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "sessionId",
      "requestId",
      "requestDigest",
      "version",
      "allocatedNodeIds",
      "allocatedRelationshipIds",
    ]) ||
    !isAgentMapBoundedText(value.sessionId, 256) ||
    !isAgentMapBoundedText(value.requestId, 128) ||
    typeof value.requestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.requestDigest) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1
  )
    throw new Error("invalid Agent Map receipt");
  return {
    sessionId: value.sessionId,
    requestId: value.requestId,
    requestDigest: value.requestDigest,
    version: value.version as number,
    allocatedNodeIds: parseAllocationMap(
      value.allocatedNodeIds,
      "node",
    ) as ProposalBatchResult["allocatedNodeIds"],
    allocatedRelationshipIds: parseAllocationMap(
      value.allocatedRelationshipIds,
      "rel",
    ) as ProposalBatchResult["allocatedRelationshipIds"],
  };
}
