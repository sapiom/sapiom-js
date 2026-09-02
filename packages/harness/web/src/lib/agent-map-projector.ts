import type {
  AcceptedProposalDelta,
  AgentMapWorkspaceResponse,
  MapOperation,
  PlanNode,
  PlanNodeId,
  PlanRelationship,
  ProposalActor,
} from "@shared/agent-map";

export type AgentMapProjectionResult =
  | {
      status: "applied";
      snapshot: AgentMapWorkspaceResponse;
      selection: PlanNodeId | null;
      selectionRemoved: boolean;
    }
  | { status: "ignored"; snapshot: AgentMapWorkspaceResponse }
  | { status: "needs-refetch"; snapshot: AgentMapWorkspaceResponse };

const actorKind = (node: PlanNode): boolean =>
  node.kind === "agent" || node.kind === "subagent";

function relationshipEndpointsValid(
  relationship: PlanRelationship,
  nodes: ReadonlyMap<PlanNodeId, PlanNode>,
): boolean {
  const from = nodes.get(relationship.fromNodeId);
  const to = nodes.get(relationship.toNodeId);
  if (!from || !to || from.id === to.id) return false;
  switch (relationship.kind) {
    case "invokes":
      return actorKind(from) && actorKind(to);
    case "feeds":
    case "triggers":
      return actorKind(to);
    case "reads":
    case "writes":
      return (
        actorKind(from) && (to.kind === "resource" || to.kind === "artifact")
      );
    case "uses":
      return (
        actorKind(from) && (to.kind === "resource" || to.kind === "connector")
      );
  }
}

function semanticKey(relationship: PlanRelationship): string {
  return JSON.stringify([
    relationship.fromNodeId,
    relationship.toNodeId,
    relationship.kind,
    relationship.executionMode,
    relationship.contractRef,
  ]);
}

function projectionIsCoherent(
  nodes: ReadonlyMap<PlanNodeId, PlanNode>,
  relationships: ReadonlyMap<string, PlanRelationship>,
): boolean {
  const semanticKeys = new Set<string>();
  for (const node of nodes.values()) {
    const owner =
      node.ownerAgentId === null ? null : nodes.get(node.ownerAgentId);
    if (
      (node.kind === "subagent" && owner?.kind !== "agent") ||
      (node.kind !== "subagent" && node.ownerAgentId !== null)
    )
      return false;
  }
  for (const relationship of relationships.values()) {
    const key = semanticKey(relationship);
    if (
      !relationshipEndpointsValid(relationship, nodes) ||
      semanticKeys.has(key)
    )
      return false;
    semanticKeys.add(key);
  }
  return true;
}

function applyOperation(
  operation: MapOperation,
  nodes: Map<PlanNodeId, PlanNode>,
  relationships: Map<string, PlanRelationship>,
): boolean {
  switch (operation.kind) {
    case "add-node":
      if (nodes.has(operation.node.id)) return false;
      nodes.set(operation.node.id, structuredClone(operation.node));
      return true;
    case "update-node": {
      const current = nodes.get(operation.nodeId);
      if (!current) return false;
      nodes.set(operation.nodeId, {
        ...current,
        ...structuredClone(operation.changes),
      });
      return true;
    }
    case "remove-node":
      return nodes.delete(operation.nodeId);
    case "add-relationship":
      if (relationships.has(operation.relationship.id)) return false;
      relationships.set(
        operation.relationship.id,
        structuredClone(operation.relationship),
      );
      return true;
    case "update-relationship": {
      const current = relationships.get(operation.relationshipId);
      if (!current) return false;
      relationships.set(operation.relationshipId, {
        ...current,
        ...structuredClone(operation.changes),
      });
      return true;
    }
    case "remove-relationship":
      return relationships.delete(operation.relationshipId);
  }
}

/**
 * Atomically folds exactly one contiguous server-authored delta. Browser state
 * is disposable: any uncertainty asks the caller to replace it from GET.
 */
export function applyAcceptedProposalDelta(
  snapshot: AgentMapWorkspaceResponse,
  delta: AcceptedProposalDelta,
  selection: PlanNodeId | null = null,
): AgentMapProjectionResult {
  const proposal = snapshot.proposal;
  if (delta.projectId !== snapshot.project.projectId) {
    return { status: "ignored", snapshot };
  }
  if (
    !proposal ||
    proposal.id !== delta.proposalId ||
    snapshot.workspace.activeProposalId !== delta.proposalId ||
    delta.fromVersion !== proposal.version ||
    delta.version !== delta.fromVersion + 1 ||
    delta.operations.length !== delta.operationIds.length
  ) {
    return { status: "needs-refetch", snapshot };
  }

  const nodes = new Map(
    proposal.nodes.map((node) => [node.id, structuredClone(node)]),
  );
  const relationships = new Map(
    proposal.relationships.map((relationship) => [
      relationship.id,
      structuredClone(relationship),
    ]),
  );
  if (
    delta.operations.some(
      (operation) => !applyOperation(operation, nodes, relationships),
    ) ||
    !projectionIsCoherent(nodes, relationships)
  ) {
    return { status: "needs-refetch", snapshot };
  }

  const selectionRemoved = selection !== null && !nodes.has(selection);
  // AcceptedProposalDelta deliberately omits the idempotency requestId. The
  // browser projection is disposable, so use the first permanent operation
  // id as a stable local batch key until the next durable GET replaces it.
  const projectedRequestId = delta.operationIds[0]!;
  const appendedHistory = delta.operations.map((operation, index) => ({
    id: delta.operationIds[index]!,
    requestId: projectedRequestId,
    acceptedVersion: delta.version,
    operation: structuredClone(operation),
    actor: structuredClone(delta.actor),
    acceptedAt: delta.acceptedAt,
  }));
  return {
    status: "applied",
    selection: selectionRemoved ? null : selection,
    selectionRemoved,
    snapshot: {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        recordVersion: snapshot.workspace.recordVersion + 1,
        updatedAt: delta.acceptedAt,
      },
      proposal: {
        ...proposal,
        version: delta.version,
        nodes: [...nodes.values()],
        relationships: [...relationships.values()],
        history: [...proposal.history, ...appendedHistory],
        updatedAt: delta.acceptedAt,
      },
    },
  };
}

/** Latest bounded attribution affecting a node or one of its incident edges. */
export interface LatestNodeAttribution {
  actor: ProposalActor;
  acceptedAt: string;
}

export function latestNodeAttribution(
  snapshot: AgentMapWorkspaceResponse,
  nodeId: PlanNodeId,
): LatestNodeAttribution | null {
  const proposal = snapshot.proposal;
  if (!proposal) return null;
  const relationships = new Map(
    proposal.relationships.map((edge) => [edge.id, edge]),
  );
  const affectsNode = (operation: MapOperation): boolean => {
    switch (operation.kind) {
      case "add-node":
        return operation.node.id === nodeId;
      case "update-node":
      case "remove-node":
        return operation.nodeId === nodeId;
      case "add-relationship":
        return (
          operation.relationship.fromNodeId === nodeId ||
          operation.relationship.toNodeId === nodeId
        );
      case "update-relationship":
      case "remove-relationship": {
        const edge = relationships.get(operation.relationshipId);
        return edge?.fromNodeId === nodeId || edge?.toNodeId === nodeId;
      }
    }
  };
  return (
    [...proposal.history]
      .reverse()
      .find(({ operation }) => affectsNode(operation)) ?? null
  );
}
