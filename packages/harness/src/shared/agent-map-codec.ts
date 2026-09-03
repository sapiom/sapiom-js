import {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  AGENT_MAP_RELATIONSHIP_ENDPOINT_MATRIX,
  AGENT_MAP_REVISION_SCHEMA_VERSION,
  EXECUTION_MODES,
  PLAN_NODE_KINDS,
  RELATIONSHIP_KINDS,
  type DraftRef,
  type AcceptedProposalDelta,
  type AgentMapGraph,
  type AgentMapGraphDigest,
  type AgentMapRevision,
  type AgentMapRevisionId,
  type AgentMapRevisionRef,
  type ArchitectureApproval,
  type ConfirmArchitectureRequest,
  type ConfirmArchitectureResult,
  type MapChangeProposal,
  type MapOperation,
  type PlanNode,
  type PlanNodeId,
  type PlanRelationship,
  type PlanRelationshipId,
  type ProposalActor,
  type ProposalBatchResult,
  type PlannerUserMessageReceipt,
} from "./agent-map.js";
import { canonicalizeAgentMapGraph } from "./agent-map-canonical.js";

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

const isAgentMapDigest = (value: unknown): value is AgentMapGraphDigest =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);

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

export function parseAgentMapNode(value: unknown): PlanNode {
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

export function parseAgentMapRelationship(value: unknown): PlanRelationship {
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

const relationshipSemanticKey = (relationship: PlanRelationship): string =>
  JSON.stringify([
    relationship.fromNodeId,
    relationship.toNodeId,
    relationship.kind,
    relationship.executionMode,
    relationship.contractRef,
  ]);

/** Strict graph parser shared by immutable revision boundaries. */
export function parseAgentMapGraph(value: unknown): AgentMapGraph {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["nodes", "relationships"]) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.relationships)
  )
    throw new Error("invalid Agent Map graph");

  const nodes = value.nodes.map(parseAgentMapNode);
  const relationships = value.relationships.map(parseAgentMapRelationship);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const semanticRelationships = new Set<string>();
  if (
    nodesById.size !== nodes.length ||
    new Set(relationships.map(({ id }) => id)).size !== relationships.length
  )
    throw new Error("inconsistent Agent Map graph");

  for (const node of nodes) {
    const owner =
      node.ownerAgentId === null ? undefined : nodesById.get(node.ownerAgentId);
    if (
      (node.kind === "subagent" &&
        (node.ownerAgentId === node.id || owner?.kind !== "agent")) ||
      (node.kind !== "subagent" && node.ownerAgentId !== null)
    )
      throw new Error("inconsistent Agent Map graph");
  }

  for (const relationship of relationships) {
    const from = nodesById.get(relationship.fromNodeId);
    const to = nodesById.get(relationship.toNodeId);
    const rule = AGENT_MAP_RELATIONSHIP_ENDPOINT_MATRIX[relationship.kind];
    const semanticKey = relationshipSemanticKey(relationship);
    if (
      !from ||
      !to ||
      from.id === to.id ||
      !rule.from.has(from.kind) ||
      !rule.to.has(to.kind) ||
      semanticRelationships.has(semanticKey)
    )
      throw new Error("inconsistent Agent Map graph");
    semanticRelationships.add(semanticKey);
  }

  return { nodes, relationships };
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
      return { kind: value.kind, node: parseAgentMapNode(value.node) };
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
        relationship: parseAgentMapRelationship(value.relationship),
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
    !hasExactKeys(value, ["userId", "sessionId", "role", "assignment"]) ||
    !isAgentMapBoundedText(value.userId, 256) ||
    !isAgentMapBoundedText(value.sessionId, 256)
  )
    throw new Error("invalid Agent Map actor");
  if (value.role === "map-planner" && value.assignment === null)
    return structuredClone(value) as unknown as ProposalActor;
  if (
    value.role !== "agent-builder" ||
    !isRecord(value.assignment) ||
    (value.assignment.kind === "planned"
      ? !hasExactKeys(value.assignment, ["kind", "agentId"]) ||
        !isAgentMapBoundedText(value.assignment.agentId, 256)
      : value.assignment.kind !== "unplanned" ||
        !hasExactKeys(value.assignment, ["kind"]))
  )
    throw new Error("invalid Agent Map actor");
  return structuredClone(value) as unknown as ProposalActor;
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

  const nodes = value.nodes.map(parseAgentMapNode);
  const relationships = value.relationships.map(parseAgentMapRelationship);
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

export function parseArchitectureApproval(
  value: unknown,
): ArchitectureApproval {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "approvedProposalId",
      "approvedProposalVersion",
      "approvingUserId",
      "approvingSessionId",
      "approvingMessageId",
      "approvedAt",
    ]) ||
    !isPlanId(value.approvedProposalId, "proposal") ||
    !Number.isSafeInteger(value.approvedProposalVersion) ||
    (value.approvedProposalVersion as number) < 1 ||
    !isAgentMapBoundedText(value.approvingUserId, 256) ||
    !isAgentMapBoundedText(value.approvingSessionId, 256) ||
    !isAgentMapBoundedText(value.approvingMessageId, 256) ||
    !isTimestamp(value.approvedAt)
  )
    throw new Error("invalid Agent Map architecture approval");
  return structuredClone(value) as unknown as ArchitectureApproval;
}

export function parsePlannerUserMessageReceipt(
  value: unknown,
  expectedProjectId: string,
): PlannerUserMessageReceipt {
  if (
    !isAgentMapBoundedText(expectedProjectId, 128) ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "messageId",
      "projectId",
      "userId",
      "sessionId",
      "origin",
      "acceptedAt",
    ]) ||
    !isAgentMapBoundedText(value.messageId, 256) ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    value.projectId !== expectedProjectId ||
    !isAgentMapBoundedText(value.userId, 256) ||
    !isAgentMapBoundedText(value.sessionId, 256) ||
    value.origin !== "human" ||
    !isTimestamp(value.acceptedAt)
  )
    throw new Error("invalid Agent Map planner message receipt");
  return structuredClone(value) as unknown as PlannerUserMessageReceipt;
}

export function parseConfirmArchitectureRequest(
  value: unknown,
): ConfirmArchitectureRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "proposalId",
      "expectedVersion",
      "expectedDigest",
      "approvingMessageId",
    ]) ||
    value.schemaVersion !== AGENT_MAP_REVISION_SCHEMA_VERSION ||
    !isAgentMapBoundedText(value.requestId, 128) ||
    !isPlanId(value.proposalId, "proposal") ||
    !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 1 ||
    !isAgentMapDigest(value.expectedDigest) ||
    !isAgentMapBoundedText(value.approvingMessageId, 256)
  )
    throw new Error("invalid Agent Map confirmation request");
  return structuredClone(value) as unknown as ConfirmArchitectureRequest;
}

export function parseAgentMapRevisionRef(value: unknown): AgentMapRevisionRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "revisionNumber",
      "parentRevisionId",
      "digest",
      "createdAt",
    ]) ||
    !isPlanId(value.id, "revision") ||
    !Number.isSafeInteger(value.revisionNumber) ||
    (value.revisionNumber as number) < 1 ||
    (value.parentRevisionId !== null &&
      !isPlanId(value.parentRevisionId, "revision")) ||
    (value.revisionNumber === 1) !== (value.parentRevisionId === null) ||
    !isAgentMapDigest(value.digest) ||
    !isTimestamp(value.createdAt)
  )
    throw new Error("invalid Agent Map revision reference");
  return structuredClone(value) as unknown as AgentMapRevisionRef;
}

export function parseAgentMapRevision(
  value: unknown,
  expectedProjectId: string,
): AgentMapRevision {
  if (
    !isAgentMapBoundedText(expectedProjectId, 128) ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "id",
      "projectId",
      "revisionNumber",
      "parentRevisionId",
      "nodes",
      "relationships",
      "digest",
      "approval",
      "createdAt",
    ]) ||
    value.schemaVersion !== AGENT_MAP_REVISION_SCHEMA_VERSION ||
    value.projectId !== expectedProjectId ||
    !isAgentMapBoundedText(value.projectId, 128) ||
    !isPlanId(value.id, "revision") ||
    !Number.isSafeInteger(value.revisionNumber) ||
    (value.revisionNumber as number) < 1 ||
    (value.parentRevisionId !== null &&
      !isPlanId(value.parentRevisionId, "revision")) ||
    (value.revisionNumber === 1) !== (value.parentRevisionId === null) ||
    !isAgentMapDigest(value.digest) ||
    !isTimestamp(value.createdAt)
  )
    throw new Error("invalid Agent Map revision");

  const graph = canonicalizeAgentMapGraph(
    parseAgentMapGraph({
      nodes: value.nodes,
      relationships: value.relationships,
    }),
  );
  const approval = parseArchitectureApproval(value.approval);
  if (approval.approvedAt > value.createdAt)
    throw new Error("invalid Agent Map revision");
  return {
    schemaVersion: AGENT_MAP_REVISION_SCHEMA_VERSION,
    id: value.id as AgentMapRevisionId,
    projectId: value.projectId,
    revisionNumber: value.revisionNumber as number,
    parentRevisionId: value.parentRevisionId as AgentMapRevisionId | null,
    ...graph,
    digest: value.digest,
    approval,
    createdAt: value.createdAt,
  };
}

export function parseConfirmArchitectureResult(
  value: unknown,
): ConfirmArchitectureResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "outcome",
      "approvedProposal",
      "revision",
      "workspaceRecordVersion",
    ]) ||
    value.schemaVersion !== AGENT_MAP_REVISION_SCHEMA_VERSION ||
    (value.outcome !== "confirmed" && value.outcome !== "replayed") ||
    !isRecord(value.approvedProposal) ||
    !hasExactKeys(value.approvedProposal, ["id", "version", "digest"]) ||
    !isPlanId(value.approvedProposal.id, "proposal") ||
    !Number.isSafeInteger(value.approvedProposal.version) ||
    (value.approvedProposal.version as number) < 1 ||
    !isAgentMapDigest(value.approvedProposal.digest) ||
    !Number.isSafeInteger(value.workspaceRecordVersion) ||
    (value.workspaceRecordVersion as number) < 1
  )
    throw new Error("invalid Agent Map confirmation result");
  const revision = parseAgentMapRevisionRef(value.revision);
  if (value.approvedProposal.digest !== revision.digest)
    throw new Error("invalid Agent Map confirmation result");
  return {
    schemaVersion: AGENT_MAP_REVISION_SCHEMA_VERSION,
    outcome: value.outcome,
    approvedProposal: structuredClone(
      value.approvedProposal,
    ) as ConfirmArchitectureResult["approvedProposal"],
    revision,
    workspaceRecordVersion: value.workspaceRecordVersion as number,
  };
}
