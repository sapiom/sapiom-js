import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

import {
  AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
  type AcceptedProposalDelta,
  type AgentMapGraph,
  type MapChangeProposal,
  type MapOperation,
  type MapProposalId,
  type PlanNodeId,
  type PlanRelationshipId,
  type PlanningSessionIdentity,
  type ProposalActor,
  type ProposalBatchRequest,
  type ProposalBatchResult,
  type ProposalConflict,
  type ProposalOperationId,
  type ProposalValidationIssue,
  type StudioProjectId,
} from "../shared/agent-map.js";
import { parseProposalBatchRequest } from "./agent-map-proposal-schema.js";
import {
  canonicalizeAgentMapGraph,
  materializeValidatedMapBatch,
  proposalTouchSetsOverlap,
  validateMapOperationBatch,
  type AgentMapIdAllocator,
  type ProposalTouchSet,
} from "./agent-map-proposal-validator.js";
import {
  AgentMapWorkspaceStore,
  type AgentMapProjectAggregate,
} from "./agent-map-workspace-store.js";

export class AgentMapProposalValidationError extends Error {
  readonly code = "validation_failed" as const;
  constructor(
    readonly issues: ProposalValidationIssue[],
    readonly currentVersion: number,
  ) {
    super("Agent Map proposal batch is invalid");
    this.name = "AgentMapProposalValidationError";
  }
}

export class AgentMapProposalConflictError extends Error {
  constructor(readonly conflict: ProposalConflict) {
    super(
      conflict.code === "request_id_reused"
        ? "Proposal request ID was reused"
        : "Agent Map proposal changed",
    );
    this.name = "AgentMapProposalConflictError";
  }
}

export class AgentMapProposalProjectError extends Error {
  readonly code = "cross_project" as const;
  constructor() {
    super("Proposal identity does not belong to this project");
    this.name = "AgentMapProposalProjectError";
  }
}

export interface AgentMapPermanentIdAllocator extends AgentMapIdAllocator {
  allocateProposalId(): MapProposalId;
  allocateOperationId(): ProposalOperationId;
}

export class UuidV7AgentMapIdAllocator implements AgentMapPermanentIdAllocator {
  allocateNodeId = (): PlanNodeId => `node_${uuidv7()}` as PlanNodeId;
  allocateRelationshipId = (): PlanRelationshipId =>
    `rel_${uuidv7()}` as PlanRelationshipId;
  allocateProposalId = (): MapProposalId =>
    `proposal_${uuidv7()}` as MapProposalId;
  allocateOperationId = (): ProposalOperationId =>
    `operation_${uuidv7()}` as ProposalOperationId;
}

export interface AgentMapProposalServiceOptions {
  allocator?: AgentMapPermanentIdAllocator;
  now?: () => Date;
  readBaseRevision?: (
    projectId: StudioProjectId,
    revisionId: string,
  ) => Promise<AgentMapGraph | null>;
  onAccepted?: (delta: AcceptedProposalDelta) => void | Promise<void>;
}

const actorFor = (identity: PlanningSessionIdentity): ProposalActor => ({
  userId: identity.userId,
  sessionId: identity.sessionId,
  role: identity.role,
  assignment:
    identity.role === "agent-builder"
      ? structuredClone(identity.assignment)
      : null,
});

const requestDigest = (request: ProposalBatchRequest): string =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");

function applyOperations(
  graph: AgentMapGraph,
  operations: readonly MapOperation[],
): AgentMapGraph {
  const nodes = new Map(
    graph.nodes.map((node) => [node.id, structuredClone(node)]),
  );
  const relationships = new Map(
    graph.relationships.map((relationship) => [
      relationship.id,
      structuredClone(relationship),
    ]),
  );
  for (const operation of operations) {
    switch (operation.kind) {
      case "add-node":
        nodes.set(operation.node.id, structuredClone(operation.node));
        break;
      case "update-node": {
        const node = nodes.get(operation.nodeId);
        if (node)
          nodes.set(operation.nodeId, {
            ...node,
            ...structuredClone(operation.changes),
          });
        break;
      }
      case "remove-node":
        nodes.delete(operation.nodeId);
        break;
      case "add-relationship":
        relationships.set(
          operation.relationship.id,
          structuredClone(operation.relationship),
        );
        break;
      case "update-relationship": {
        const relationship = relationships.get(operation.relationshipId);
        if (relationship)
          relationships.set(operation.relationshipId, {
            ...relationship,
            ...structuredClone(operation.changes),
          });
        break;
      }
      case "remove-relationship":
        relationships.delete(operation.relationshipId);
        break;
    }
  }
  return canonicalizeAgentMapGraph({
    nodes: [...nodes.values()],
    relationships: [...relationships.values()],
  });
}

function affectedFromTouchSets(
  left: ProposalTouchSet,
  right: ProposalTouchSet,
): Pick<ProposalConflict, "affectedNodeIds" | "affectedRelationshipIds"> {
  const entities = new Set(right.entityKeys);
  return {
    affectedNodeIds: left.entityKeys
      .filter((key) => key.startsWith("node:") && entities.has(key))
      .map((key) => key.slice(5) as PlanNodeId),
    affectedRelationshipIds: left.entityKeys
      .filter((key) => key.startsWith("relationship:") && entities.has(key))
      .map((key) => key.slice(13) as PlanRelationshipId),
  };
}

/** Transport-neutral authority for the one shared active proposal per project. */
export class AgentMapProposalService {
  private readonly allocator: AgentMapPermanentIdAllocator;
  private readonly now: () => Date;

  constructor(
    private readonly store: AgentMapWorkspaceStore,
    private readonly options: AgentMapProposalServiceOptions = {},
  ) {
    this.allocator = options.allocator ?? new UuidV7AgentMapIdAllocator();
    this.now = options.now ?? (() => new Date());
  }

  read(projectId: StudioProjectId) {
    return this.store.readSnapshot(projectId);
  }

  private async baseGraph(
    aggregate: AgentMapProjectAggregate,
  ): Promise<AgentMapGraph> {
    const revisionId = aggregate.workspace.confirmedRevisionId;
    if (revisionId === null) return { nodes: [], relationships: [] };
    const graph = await this.options.readBaseRevision?.(
      aggregate.workspace.projectId,
      revisionId,
    );
    if (!graph)
      throw new AgentMapProposalValidationError(
        [
          {
            code: "unknown_reference",
            operationIndex: null,
            path: ["baseRevisionId"],
            recovery: "reread",
          },
        ],
        aggregate.proposal?.version ?? 0,
      );
    return canonicalizeAgentMapGraph(graph);
  }

  private graphAt(
    base: AgentMapGraph,
    proposal: MapChangeProposal | null,
    version: number,
  ): AgentMapGraph {
    if (!proposal || version === 0) return base;
    let graph = base;
    for (const record of proposal.history) {
      if (record.acceptedVersion > version) break;
      graph = applyOperations(graph, [record.operation]);
    }
    return graph;
  }

  async validate(identity: PlanningSessionIdentity, input: unknown) {
    const parsed = parseProposalBatchRequest(input);
    if (!parsed.ok) throw new AgentMapProposalValidationError(parsed.issues, 0);
    const aggregate = await this.store.readAggregate(identity.projectId);
    const currentVersion = aggregate.proposal?.version ?? 0;
    this.assertProposalPointer(aggregate, parsed.value, currentVersion);
    const base = await this.baseGraph(aggregate);
    const graph = this.graphAt(
      base,
      aggregate.proposal,
      parsed.value.expectedVersion,
    );
    const validated = validateMapOperationBatch(graph, parsed.value);
    if (!validated.ok)
      throw new AgentMapProposalValidationError(
        validated.issues,
        currentVersion,
      );
    return {
      schemaVersion: 1 as const,
      valid: true as const,
      currentVersion,
      touchSet: validated.value.touchSet,
    };
  }

  async propose(
    identity: PlanningSessionIdentity,
    input: unknown,
  ): Promise<ProposalBatchResult> {
    const parsed = parseProposalBatchRequest(input);
    if (!parsed.ok) throw new AgentMapProposalValidationError(parsed.issues, 0);
    const request = parsed.value;
    let acceptedDelta: AcceptedProposalDelta | null = null;
    const result = await this.store.transact(
      identity.projectId,
      async (aggregate) => {
        if (aggregate.workspace.projectId !== identity.projectId)
          throw new AgentMapProposalProjectError();
        const currentVersion = aggregate.proposal?.version ?? 0;
        const digest = requestDigest(request);
        const receipt = aggregate.receipts.find(
          (candidate) =>
            candidate.sessionId === identity.sessionId &&
            candidate.requestId === request.requestId,
        );
        if (receipt) {
          if (receipt.requestDigest !== digest)
            throw new AgentMapProposalConflictError({
              code: "request_id_reused",
              currentVersion,
              affectedNodeIds: [],
              affectedRelationshipIds: [],
              recovery: "reread",
            });
          return { value: receipt.result };
        }
        this.assertProposalPointer(aggregate, request, currentVersion);
        if (request.expectedVersion > currentVersion)
          throw this.stale(currentVersion);

        const base = await this.baseGraph(aggregate);
        const readGraph = this.graphAt(
          base,
          aggregate.proposal,
          request.expectedVersion,
        );
        const atRead = validateMapOperationBatch(readGraph, request);
        if (!atRead.ok)
          throw new AgentMapProposalValidationError(
            atRead.issues,
            currentVersion,
          );

        if (request.expectedVersion < currentVersion) {
          for (const prior of aggregate.receipts.filter(
            (candidate) => candidate.result.version > request.expectedVersion,
          )) {
            if (
              proposalTouchSetsOverlap(atRead.value.touchSet, prior.touchSet)
            ) {
              throw new AgentMapProposalConflictError({
                code: "stale_version",
                currentVersion,
                ...affectedFromTouchSets(atRead.value.touchSet, prior.touchSet),
                recovery: "reread",
              });
            }
          }
        }
        const currentGraph = aggregate.proposal
          ? {
              nodes: aggregate.proposal.nodes,
              relationships: aggregate.proposal.relationships,
            }
          : base;
        const rebased = validateMapOperationBatch(currentGraph, request);
        if (!rebased.ok) {
          if (request.expectedVersion < currentVersion)
            throw this.stale(currentVersion);
          throw new AgentMapProposalValidationError(
            rebased.issues,
            currentVersion,
          );
        }
        const materialized = materializeValidatedMapBatch(
          rebased.value,
          this.allocator,
        );
        const proposalId =
          aggregate.proposal?.id ?? this.allocator.allocateProposalId();
        const version = currentVersion + 1;
        const operationIds = materialized.operations.map(() =>
          this.allocator.allocateOperationId(),
        );
        const ids = [
          proposalId,
          ...operationIds,
          ...Object.values(materialized.allocatedNodeIds),
          ...Object.values(materialized.allocatedRelationshipIds),
        ];
        if (new Set(ids).size !== ids.length)
          throw new AgentMapProposalValidationError(
            [
              {
                code: "malformed_input",
                operationIndex: null,
                path: ["allocator"],
                recovery: "retry",
              },
            ],
            currentVersion,
          );
        const acceptedAt = this.now().toISOString();
        const actor = actorFor(identity);
        const delta: AcceptedProposalDelta = {
          schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
          projectId: identity.projectId,
          proposalId,
          fromVersion: currentVersion,
          version,
          operationIds,
          operations: materialized.operations,
          actor,
          acceptedAt,
        };
        const batchResult: ProposalBatchResult = {
          schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
          proposalId,
          version,
          operationIds,
          allocatedNodeIds: materialized.allocatedNodeIds,
          allocatedRelationshipIds: materialized.allocatedRelationshipIds,
          delta,
        };
        const proposal: MapChangeProposal = {
          schemaVersion: AGENT_MAP_PROPOSAL_SCHEMA_VERSION,
          id: proposalId,
          projectId: identity.projectId,
          baseRevisionId: aggregate.workspace.confirmedRevisionId,
          version,
          nodes: materialized.graph.nodes,
          relationships: materialized.graph.relationships,
          history: [
            ...(aggregate.proposal?.history ?? []),
            ...materialized.operations.map((operation, index) => ({
              id: operationIds[index]!,
              requestId: request.requestId,
              acceptedVersion: version,
              operation,
              actor,
              acceptedAt,
            })),
          ],
          createdAt: aggregate.proposal?.createdAt ?? acceptedAt,
          updatedAt: acceptedAt,
        };
        const next: AgentMapProjectAggregate = {
          ...aggregate,
          workspace: {
            ...aggregate.workspace,
            recordVersion: aggregate.workspace.recordVersion + 1,
            activeProposalId: proposalId,
            updatedAt: acceptedAt,
          },
          proposal,
          receipts: [
            ...aggregate.receipts,
            {
              sessionId: identity.sessionId,
              requestId: request.requestId,
              requestDigest: digest,
              result: batchResult,
              touchSet: materialized.touchSet,
            },
          ],
        };
        acceptedDelta = delta;
        return { value: batchResult, next };
      },
    );
    if (acceptedDelta) {
      try {
        await this.options.onAccepted?.(acceptedDelta);
      } catch {
        // Durable state is authoritative; subscribers recover by refetching.
      }
    }
    return result;
  }

  private assertProposalPointer(
    aggregate: AgentMapProjectAggregate,
    request: ProposalBatchRequest,
    currentVersion: number,
  ): void {
    const active = aggregate.proposal?.id ?? null;
    if (
      request.proposalId !== active ||
      (active === null && request.expectedVersion !== 0)
    )
      throw this.stale(currentVersion);
  }

  private stale(currentVersion: number) {
    return new AgentMapProposalConflictError({
      code: "stale_version",
      currentVersion,
      affectedNodeIds: [],
      affectedRelationshipIds: [],
      recovery: "reread",
    });
  }
}
