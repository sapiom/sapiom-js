import { v7 as uuidv7 } from "uuid";

import {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  type AcceptedProposalDelta,
  type AgentMapGraph,
  type AgentMapVersionId,
  type MapOperation,
  type MapProposalId,
  type PlanNodeId,
  type PlanRelationshipId,
  type ProjectAgentActorRef,
  type ProjectAgentSession,
  type ProposalBatchRequest,
  type ProposalBatchResult,
  type ProposalConflict,
  type ProposalOperationId,
  type ProposalValidationIssue,
  type StudioProjectId,
} from "../shared/agent-map.js";
import { canonicalDigest, computeGraphContentDigest } from "../shared/agent-map-canonical.js";
import { parseProjectAgentActorRef } from "../shared/agent-map-codec.js";
import {
  BUILD_PLAN_VERSION_HISTORY_LIMIT,
  PROJECT_MUTATION_RECEIPT_LIMIT,
  PROJECT_MUTATION_TOMBSTONE_LIMIT,
  type ProjectMutationReceipt,
} from "../shared/build-plan.js";
import { parseProposalBatchRequest } from "./agent-map-proposal-schema.js";
import {
  derivePersistedMapOperationTouchSet,
  materializeValidatedMapBatch,
  proposalTouchSetsOverlap,
  validateMapOperationBatch,
  type AgentMapIdAllocator,
  type ProposalTouchSet,
} from "./agent-map-proposal-validator.js";
import {
  agentMapVersionRef,
  applyPersistedMapOperations,
  createAgentMapVersion,
} from "./agent-map-version.js";
import {
  AgentMapWorkspaceStore,
  AgentMapWorkspaceStoreError,
  projectCompatibilitySnapshot,
  projectProposalId,
  type AgentMapProjectAggregate,
} from "./agent-map-workspace-store.js";

export const AGENT_MAP_PROPOSAL_RECEIPT_RETENTION_LIMIT = 256;

export class AgentMapProposalValidationError extends Error {
  readonly code = "validation_failed" as const;
  constructor(readonly issues: ProposalValidationIssue[], readonly currentVersion: number) {
    super("Agent Map proposal batch is invalid");
    this.name = "AgentMapProposalValidationError";
  }
}

export class AgentMapProposalConflictError extends Error {
  constructor(readonly conflict: ProposalConflict) {
    super(conflict.code === "request_id_reused" ? "Proposal request ID was reused" :
      conflict.code === "request_id_expired" ? "Proposal request result is no longer retained" : "Agent Map proposal changed");
    this.name = "AgentMapProposalConflictError";
  }
}

export class AgentMapProposalProjectError extends Error {
  readonly code = "cross_project" as const;
  constructor() { super("Proposal identity does not belong to this project"); this.name = "AgentMapProposalProjectError"; }
}

export class AgentMapProposalQuotaError extends Error {
  readonly code = "quota_exceeded" as const;
  constructor(readonly resource: "map_versions" | "request_receipts" | "request_tombstones") {
    super(`${resource.replace(/_/gu, " ")} quota exceeded`);
    this.name = "AgentMapProposalQuotaError";
  }
}

export interface AgentMapPermanentIdAllocator extends AgentMapIdAllocator {
  allocateProposalId(): MapProposalId;
  allocateOperationId(): ProposalOperationId;
  allocateMapVersionId?(): AgentMapVersionId;
}

export class UuidV7AgentMapIdAllocator implements AgentMapPermanentIdAllocator {
  allocateNodeId = (): PlanNodeId => `node_${uuidv7()}` as PlanNodeId;
  allocateRelationshipId = (): PlanRelationshipId => `rel_${uuidv7()}` as PlanRelationshipId;
  allocateProposalId = (): MapProposalId => `proposal_${uuidv7()}` as MapProposalId;
  allocateOperationId = (): ProposalOperationId => `operation_${uuidv7()}` as ProposalOperationId;
  allocateMapVersionId = (): AgentMapVersionId => `mapv_${uuidv7()}` as AgentMapVersionId;
}

export interface AgentMapProposalServiceOptions {
  allocator?: AgentMapPermanentIdAllocator;
  now?: () => Date;
  /** Deprecated final-schema compatibility option; map versions are self-contained. */
  readBaseRevision?: (projectId: StudioProjectId, revisionId: string) => Promise<AgentMapGraph | null>;
  onAccepted?: (delta: AcceptedProposalDelta) => void | Promise<void>;
  onOutcome?: (event: {
    name: "agent_map.proposal.accepted" | "agent_map.proposal.replayed" |
      "agent_map.proposal.validation_failed" | "agent_map.proposal.conflict" |
      "agent_map.proposal.quota_exceeded" | "agent_map.proposal.storage_failed";
    projectId: StudioProjectId;
    sessionId: string;
    operationCount: number;
    latencyMs: number;
  }) => void | Promise<void>;
  receiptRetentionLimit?: number;
  versionHistoryLimit?: number;
}

const actorFor = (identity: ProjectAgentSession): ProjectAgentActorRef => {
  try { return parseProjectAgentActorRef({ userId: identity.userId, sessionId: identity.sessionId }); }
  catch {
    throw new AgentMapProposalValidationError([{ code: "malformed_input", operationIndex: null,
      path: ["identity"], recovery: "retry" }], 0);
  }
};

function canonicalRequest(request: ProposalBatchRequest): unknown {
  return {
    schemaVersion: request.schemaVersion,
    proposalId: request.proposalId,
    expectedVersion: request.expectedVersion,
    operations: request.operations.map((operation) => {
      if (operation.kind === "add-node") return { ...operation, node: { ...operation.node,
        contractRefs: [...operation.node.contractRefs].sort() } };
      if (operation.kind === "update-node") return { ...operation, changes: { ...operation.changes,
        ...(operation.changes.contractRefs ? { contractRefs: [...operation.changes.contractRefs].sort() } : {}) } };
      return operation;
    }),
  };
}

const requestDigest = (request: ProposalBatchRequest): string =>
  canonicalDigest("sapiom.agent-map.request.v1", canonicalRequest(request));

const currentGraph = (aggregate: AgentMapProjectAggregate): AgentMapGraph =>
  structuredClone(aggregate.mapVersions.at(-1)?.graph ?? { nodes: [], relationships: [] });
const currentVersion = (aggregate: AgentMapProjectAggregate): number =>
  aggregate.mapOperationHistory.at(-1)?.acceptedVersion ?? 0;

function graphAt(aggregate: AgentMapProjectAggregate, version: number): AgentMapGraph {
  if (version === 0) return { nodes: [], relationships: [] };
  return applyPersistedMapOperations(
    { nodes: [], relationships: [] },
    aggregate.mapOperationHistory.filter(({ acceptedVersion }) => acceptedVersion <= version).map(({ operation }) => operation),
  );
}

function touchSetAfter(
  aggregate: AgentMapProjectAggregate,
  expectedVersion: number,
): ProposalTouchSet {
  const entities = new Set<string>();
  const semantics = new Set<string>();
  let graph = graphAt(aggregate, expectedVersion);
  const byVersion = new Map<number, MapOperation[]>();
  for (const record of aggregate.mapOperationHistory) {
    if (record.acceptedVersion <= expectedVersion) continue;
    byVersion.set(record.acceptedVersion, [...(byVersion.get(record.acceptedVersion) ?? []), record.operation]);
  }
  for (const operations of byVersion.values()) {
    const next = applyPersistedMapOperations(graph, operations);
    const touch = derivePersistedMapOperationTouchSet(graph, operations, next);
    touch.entityKeys.forEach((key) => entities.add(key));
    touch.semanticRelationshipKeys.forEach((key) => semantics.add(key));
    graph = next;
  }
  return { entityKeys: [...entities].sort(), semanticRelationshipKeys: [...semantics].sort() };
}

function affectedFromTouchSets(left: ProposalTouchSet, right: ProposalTouchSet) {
  const entities = new Set(right.entityKeys);
  return {
    affectedNodeIds: left.entityKeys.filter((key) => key.startsWith("node:") && entities.has(key)).map((key) => key.slice(5) as PlanNodeId),
    affectedRelationshipIds: left.entityKeys.filter((key) => key.startsWith("relationship:") && entities.has(key)).map((key) => key.slice(13) as PlanRelationshipId),
  };
}

function receiptFor(
  aggregate: AgentMapProjectAggregate,
  identity: ProjectAgentSession,
  requestId: string,
): ProjectMutationReceipt | undefined {
  return aggregate.requestReceipts.find((candidate) =>
    candidate.userId === identity.userId && candidate.sessionId === identity.sessionId && candidate.requestId === requestId);
}

/** Transport-neutral authority for the current immutable map stream. */
export class AgentMapProposalService {
  private readonly allocator: AgentMapPermanentIdAllocator;
  private readonly now: () => Date;
  private readonly receiptRetentionLimit: number;
  private readonly versionHistoryLimit: number;

  constructor(private readonly store: AgentMapWorkspaceStore, private readonly options: AgentMapProposalServiceOptions = {}) {
    this.allocator = options.allocator ?? new UuidV7AgentMapIdAllocator();
    this.now = options.now ?? (() => new Date());
    const limit = options.receiptRetentionLimit ?? AGENT_MAP_PROPOSAL_RECEIPT_RETENTION_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("receiptRetentionLimit must be a positive integer");
    this.receiptRetentionLimit = Math.min(limit, AGENT_MAP_PROPOSAL_RECEIPT_RETENTION_LIMIT);
    const historyLimit = options.versionHistoryLimit ?? BUILD_PLAN_VERSION_HISTORY_LIMIT;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > BUILD_PLAN_VERSION_HISTORY_LIMIT)
      throw new RangeError(`versionHistoryLimit must be between 1 and ${BUILD_PLAN_VERSION_HISTORY_LIMIT}`);
    this.versionHistoryLimit = historyLimit;
  }

  read(projectId: StudioProjectId) { return this.store.readSnapshot(projectId); }

  async validate(identity: ProjectAgentSession, input: unknown) {
    actorFor(identity);
    const parsed = parseProposalBatchRequest(input);
    if (!parsed.ok) throw new AgentMapProposalValidationError(parsed.issues, 0);
    const aggregate = await this.store.readAggregate(identity.projectId);
    const version = currentVersion(aggregate);
    this.assertProposalPointer(aggregate, parsed.value, version);
    if (parsed.value.expectedVersion > version) throw this.stale(version);
    const atRead = validateMapOperationBatch(graphAt(aggregate, parsed.value.expectedVersion), parsed.value);
    if (!atRead.ok) throw new AgentMapProposalValidationError(atRead.issues, version);
    if (parsed.value.expectedVersion < version) {
      const prior = touchSetAfter(aggregate, parsed.value.expectedVersion);
      if (proposalTouchSetsOverlap(atRead.value.touchSet, prior))
        throw new AgentMapProposalConflictError({ code: "stale_version", currentVersion: version,
          ...affectedFromTouchSets(atRead.value.touchSet, prior), recovery: "reread" });
    }
    const rebased = validateMapOperationBatch(currentGraph(aggregate), parsed.value);
    if (!rebased.ok) {
      if (parsed.value.expectedVersion < version) throw this.stale(version);
      throw new AgentMapProposalValidationError(rebased.issues, version);
    }
    return { schemaVersion: 1 as const, valid: true as const, currentVersion: version, touchSet: rebased.value.touchSet };
  }

  async propose(identity: ProjectAgentSession, input: unknown): Promise<ProposalBatchResult> {
    const startedAt = Date.now();
    const actor = actorFor(identity);
    const parsed = parseProposalBatchRequest(input);
    if (!parsed.ok) {
      this.emitOutcome(identity, "agent_map.proposal.validation_failed", 0, startedAt);
      throw new AgentMapProposalValidationError(parsed.issues, 0);
    }
    const request = parsed.value;
    let acceptedDelta: AcceptedProposalDelta | null = null;
    let replayed = false;
    let result: ProposalBatchResult;
    try {
      result = await this.store.transact(identity.projectId, async (aggregate) => {
        if (aggregate.projectId !== identity.projectId) throw new AgentMapProposalProjectError();
        const version = currentVersion(aggregate);
        const digest = requestDigest(request);
        const receipt = receiptFor(aggregate, identity, request.requestId);
        if (receipt) {
          if (receipt.operation !== "map" || receipt.requestDigest !== digest) throw new AgentMapProposalConflictError({ code: "request_id_reused",
            currentVersion: version, affectedNodeIds: [], affectedRelationshipIds: [], recovery: "new_request" });
          replayed = true;
          return { value: structuredClone(receipt.result) as ProposalBatchResult };
        }
        if (aggregate.requestTombstones.some((candidate) =>
          candidate.userId === identity.userId && candidate.sessionId === identity.sessionId && candidate.requestId === request.requestId))
          throw new AgentMapProposalConflictError({ code: "request_id_expired", currentVersion: version,
            affectedNodeIds: [], affectedRelationshipIds: [], recovery: "new_request" });
        this.assertProposalPointer(aggregate, request, version);
        if (request.expectedVersion > version) throw this.stale(version);
        const atRead = validateMapOperationBatch(graphAt(aggregate, request.expectedVersion), request);
        if (!atRead.ok) throw new AgentMapProposalValidationError(atRead.issues, version);
        if (request.expectedVersion < version) {
          const prior = touchSetAfter(aggregate, request.expectedVersion);
          if (proposalTouchSetsOverlap(atRead.value.touchSet, prior))
            throw new AgentMapProposalConflictError({ code: "stale_version", currentVersion: version,
              ...affectedFromTouchSets(atRead.value.touchSet, prior), recovery: "reread" });
        }
        const rebased = validateMapOperationBatch(currentGraph(aggregate), request);
        if (!rebased.ok) {
          if (request.expectedVersion < version) throw this.stale(version);
          throw new AgentMapProposalValidationError(rebased.issues, version);
        }
        const materialized = materializeValidatedMapBatch(rebased.value, this.allocator);
        const proposalId = projectProposalId(aggregate);
        const acceptedVersion = version + 1;
        const operationIds = materialized.operations.map(() => this.allocator.allocateOperationId());
        const existingIds = new Set([
          ...aggregate.mapVersions.flatMap(({ graph }) => [...graph.nodes.map(({ id }) => id), ...graph.relationships.map(({ id }) => id)]),
          ...aggregate.mapOperationHistory.map(({ id }) => id),
        ]);
        const allocated = [...operationIds, ...Object.values(materialized.allocatedNodeIds),
          ...Object.values(materialized.allocatedRelationshipIds)];
        if (new Set(allocated).size !== allocated.length || allocated.some((id) => existingIds.has(id)))
          throw new AgentMapProposalValidationError([{ code: "malformed_input", operationIndex: null,
            path: ["allocator"], recovery: "retry" }], version);
        const acceptedAt = this.now().toISOString();
        const delta: AcceptedProposalDelta = { schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
          projectId: identity.projectId, proposalId, fromVersion: version, version: acceptedVersion,
          operationIds, operations: materialized.operations, actor, acceptedAt };
        const batchResult: ProposalBatchResult = { schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
          proposalId, version: acceptedVersion, operationIds,
          allocatedNodeIds: materialized.allocatedNodeIds,
          allocatedRelationshipIds: materialized.allocatedRelationshipIds, delta };
        const next = structuredClone(aggregate);
        next.mapOperationHistory.push(...materialized.operations.map((operation, index) => ({
          id: operationIds[index]!, requestId: request.requestId, acceptedVersion,
          operation, actor, acceptedAt,
        })));
        const previousGraph = currentGraph(aggregate);
        if (computeGraphContentDigest(previousGraph) !== computeGraphContentDigest(materialized.graph)) {
          if (next.mapVersions.length >= this.versionHistoryLimit)
            throw new AgentMapProposalQuotaError("map_versions");
          const mapVersion = createAgentMapVersion({ projectId: identity.projectId,
            versionId: this.allocator.allocateMapVersionId?.() ?? `mapv_${uuidv7()}` as AgentMapVersionId,
            version: next.mapVersions.length + 1, parentVersionId: next.mapVersions.at(-1)?.versionId ?? null,
            graph: materialized.graph, changeKind: next.mapVersions.length === 0 ? "created" : "edited",
            restoredFromVersionId: null, authoredBy: actor, createdAt: acceptedAt,
            origin: { kind: "request", requestDigest: digest, operationIds,
              touchKeys: [...rebased.value.touchSet.entityKeys.map((key) => `entity:${key}`),
                ...rebased.value.touchSet.semanticRelationshipKeys.map((key) => `semantic:${key}`)].sort() },
          });
          next.mapVersions.push(mapVersion);
          next.current.map = agentMapVersionRef(mapVersion);
        }
        next.requestReceipts.push({ projectId: identity.projectId, userId: identity.userId,
          sessionId: identity.sessionId, requestId: request.requestId, requestDigest: digest,
          operation: "map", result: batchResult, createdAt: acceptedAt });
        while (next.requestReceipts.filter(({ operation }) => operation === "map").length > this.receiptRetentionLimit) {
          const expiredIndex = next.requestReceipts.findIndex(({ operation }) => operation === "map");
          const [expired] = next.requestReceipts.splice(expiredIndex, 1);
          if (expired) {
            if (next.requestTombstones.length >= PROJECT_MUTATION_TOMBSTONE_LIMIT)
              throw new AgentMapProposalQuotaError("request_tombstones");
            next.requestTombstones.push({ projectId: expired.projectId, userId: expired.userId,
            sessionId: expired.sessionId, requestId: expired.requestId, operation: "map", createdAt: expired.createdAt });
          }
        }
        if (next.requestReceipts.length > PROJECT_MUTATION_RECEIPT_LIMIT)
          throw new AgentMapProposalQuotaError("request_receipts");
        next.recordVersion += 1;
        next.updatedAt = acceptedAt;
        acceptedDelta = delta;
        return { value: batchResult, next };
      });
    } catch (error) {
      this.emitOutcome(identity, error instanceof AgentMapProposalConflictError ? "agent_map.proposal.conflict" :
        error instanceof AgentMapProposalQuotaError ? "agent_map.proposal.quota_exceeded" :
        error instanceof AgentMapWorkspaceStoreError ? "agent_map.proposal.storage_failed" :
          "agent_map.proposal.validation_failed", request.operations.length, startedAt);
      throw error;
    }
    if (acceptedDelta) {
      try { await this.options.onAccepted?.(acceptedDelta); } catch { /* subscribers recover by reread */ }
    }
    this.emitOutcome(identity, replayed ? "agent_map.proposal.replayed" : "agent_map.proposal.accepted",
      request.operations.length, startedAt);
    return result;
  }

  private emitOutcome(identity: ProjectAgentSession,
    name: Parameters<NonNullable<AgentMapProposalServiceOptions["onOutcome"]>>[0]["name"],
    operationCount: number, startedAt: number): void {
    try { void Promise.resolve(this.options.onOutcome?.({ name, projectId: identity.projectId,
      sessionId: identity.sessionId, operationCount, latencyMs: Math.max(0, Date.now() - startedAt) })).catch(() => {}); }
    catch { /* telemetry cannot change mutation semantics */ }
  }

  private assertProposalPointer(aggregate: AgentMapProjectAggregate, request: ProposalBatchRequest, version: number): void {
    const active = projectCompatibilitySnapshot(aggregate).proposal?.id ?? null;
    if (request.proposalId !== active || (active === null && request.expectedVersion !== 0)) throw this.stale(version);
  }

  private stale(version: number) {
    return new AgentMapProposalConflictError({ code: "stale_version", currentVersion: version,
      affectedNodeIds: [], affectedRelationshipIds: [], recovery: "reread" });
  }
}
