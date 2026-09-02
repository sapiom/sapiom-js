import type {
  AgentMapGraph,
  DraftRef,
  MapOperation,
  MapOperationInput,
  PlanNode,
  PlanNodeId,
  PlanNodeKind,
  PlanRelationship,
  PlanRelationshipId,
  ProposalBatchRequest,
  ProposalValidationIssue,
  ProposalValidationResult,
  RelationshipKind,
} from "../shared/agent-map.js";

const ACTOR_KINDS = new Set<PlanNodeKind>(["agent", "subagent"]);
const ALL_NODE_KINDS = new Set<PlanNodeKind>([
  "agent",
  "subagent",
  "resource",
  "connector",
  "artifact",
]);

export const RELATIONSHIP_ENDPOINT_MATRIX: Readonly<
  Record<
    RelationshipKind,
    { from: ReadonlySet<PlanNodeKind>; to: ReadonlySet<PlanNodeKind> }
  >
> = {
  invokes: { from: ACTOR_KINDS, to: ACTOR_KINDS },
  feeds: { from: ALL_NODE_KINDS, to: ACTOR_KINDS },
  reads: {
    from: ACTOR_KINDS,
    to: new Set<PlanNodeKind>(["resource", "artifact"]),
  },
  writes: {
    from: ACTOR_KINDS,
    to: new Set<PlanNodeKind>(["resource", "artifact"]),
  },
  uses: {
    from: ACTOR_KINDS,
    to: new Set<PlanNodeKind>(["resource", "connector"]),
  },
  triggers: { from: ALL_NODE_KINDS, to: ACTOR_KINDS },
};

export interface ProposalTouchSet {
  entityKeys: string[];
  semanticRelationshipKeys: string[];
}

interface WorkingNode extends Omit<PlanNode, "id" | "ownerAgentId"> {
  key: string;
  ownerKey: string | null;
  operationIndex: number | null;
}

interface WorkingRelationship extends Omit<
  PlanRelationship,
  "id" | "fromNodeId" | "toNodeId"
> {
  key: string;
  fromKey: string;
  toKey: string;
  operationIndex: number | null;
  /** The operation that introduced or changed this relationship's semantic key. */
  semanticOperationIndex: number | null;
}

export interface ValidatedMapOperationBatch {
  readonly request: ProposalBatchRequest;
  readonly current: AgentMapGraph;
  readonly touchSet: ProposalTouchSet;
  /** Internal prospective graph; draft keys are replaced during materialization. */
  readonly prospective: {
    readonly nodes: readonly WorkingNode[];
    readonly relationships: readonly WorkingRelationship[];
  };
}

export interface AgentMapIdAllocator {
  allocateNodeId(): PlanNodeId;
  allocateRelationshipId(): PlanRelationshipId;
}

export interface MaterializedMapBatch {
  operations: MapOperation[];
  graph: AgentMapGraph;
  allocatedNodeIds: Record<DraftRef, PlanNodeId>;
  allocatedRelationshipIds: Record<DraftRef, PlanRelationshipId>;
  touchSet: ProposalTouchSet;
}

const nodeDraftKey = (draftRef: DraftRef): string => `draft-node:${draftRef}`;
const relationshipDraftKey = (draftRef: DraftRef): string =>
  `draft-relationship:${draftRef}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalStrings = (values: readonly string[]): string[] =>
  [...values].sort(compareStrings);

const stripUndefinedProperties = <T extends Record<string, unknown>>(
  value: T,
): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;

const canonicalNode = (node: PlanNode): PlanNode => ({
  ...node,
  contractRefs: canonicalStrings(node.contractRefs),
});

const canonicalRelationship = (
  relationship: PlanRelationship,
): PlanRelationship => ({ ...relationship });

export function canonicalizeAgentMapGraph(graph: AgentMapGraph): AgentMapGraph {
  return {
    nodes: graph.nodes
      .map(canonicalNode)
      .sort((left, right) => compareStrings(left.id, right.id)),
    relationships: graph.relationships
      .map(canonicalRelationship)
      .sort((left, right) => compareStrings(left.id, right.id)),
  };
}

export function semanticRelationshipKey(
  relationship: Pick<
    PlanRelationship,
    "fromNodeId" | "toNodeId" | "kind" | "executionMode" | "contractRef"
  >,
): string {
  return JSON.stringify([
    relationship.fromNodeId,
    relationship.toNodeId,
    relationship.kind,
    relationship.executionMode,
    relationship.contractRef,
  ]);
}

const workingSemanticKey = (relationship: WorkingRelationship): string =>
  JSON.stringify([
    relationship.fromKey,
    relationship.toKey,
    relationship.kind,
    relationship.executionMode,
    relationship.contractRef,
  ]);

const issue = (
  code: ProposalValidationIssue["code"],
  operationIndex: number | null,
  path: Array<string | number>,
): ProposalValidationIssue => ({
  code,
  operationIndex,
  path,
  // A caller cannot correct persisted graph state through an unrelated
  // operation batch. Keep those failures distinct from caller-authored ones
  // so the service can fail closed and direct the session back to its source.
  recovery: path[0] === "current" ? "reread" : "correct",
});

function deduplicateIssues(
  issues: ProposalValidationIssue[],
): ProposalValidationIssue[] {
  const unique = new Map<string, ProposalValidationIssue>();
  for (const entry of issues) {
    unique.set(
      JSON.stringify([entry.code, entry.operationIndex, entry.path]),
      entry,
    );
  }
  return [...unique.values()].sort((left, right) => {
    const leftIndex = left.operationIndex ?? -1;
    const rightIndex = right.operationIndex ?? -1;
    return (
      leftIndex - rightIndex ||
      compareStrings(JSON.stringify(left.path), JSON.stringify(right.path)) ||
      compareStrings(left.code, right.code)
    );
  });
}

function cloneRequest(request: ProposalBatchRequest): ProposalBatchRequest {
  return {
    ...request,
    operations: request.operations.map((operation) => {
      switch (operation.kind) {
        case "add-node":
          return {
            ...operation,
            node: {
              ...operation.node,
              ownerAgent: operation.node.ownerAgent
                ? { ...operation.node.ownerAgent }
                : null,
              contractRefs: canonicalStrings(operation.node.contractRefs),
            },
          };
        case "update-node":
          return {
            ...operation,
            changes: {
              ...stripUndefinedProperties(operation.changes),
              ...(operation.changes.contractRefs
                ? {
                    contractRefs: canonicalStrings(
                      operation.changes.contractRefs,
                    ),
                  }
                : {}),
            },
          };
        case "add-relationship":
          return {
            ...operation,
            relationship: {
              ...operation.relationship,
              from: { ...operation.relationship.from },
              to: { ...operation.relationship.to },
            },
          };
        case "update-relationship":
          return {
            ...operation,
            changes: stripUndefinedProperties(operation.changes),
          };
        case "remove-node":
        case "remove-relationship":
          return { ...operation };
      }
    }),
  };
}

function resolveNodeRef(
  ref: { nodeId: PlanNodeId } | { draftRef: DraftRef },
  baseNodes: ReadonlyMap<PlanNodeId, PlanNode>,
  nodeDrafts: ReadonlyMap<DraftRef, number>,
  operationIndex: number,
  path: Array<string | number>,
  issues: ProposalValidationIssue[],
): string | null {
  if ("nodeId" in ref) {
    if (!baseNodes.has(ref.nodeId)) {
      issues.push(
        issue("unknown_reference", operationIndex, [...path, "nodeId"]),
      );
      return null;
    }
    return ref.nodeId;
  }

  if (!nodeDrafts.has(ref.draftRef)) {
    issues.push(
      issue("unknown_reference", operationIndex, [...path, "draftRef"]),
    );
    return null;
  }
  return nodeDraftKey(ref.draftRef);
}

function deriveTouchSet(
  currentRelationships: ReadonlyMap<PlanRelationshipId, PlanRelationship>,
  operations: readonly MapOperationInput[],
  prospectiveRelationships: readonly WorkingRelationship[],
): ProposalTouchSet {
  const entityKeys = new Set<string>();
  const semanticKeys = new Set<string>();
  const prospectiveByKey = new Map(
    prospectiveRelationships.map((relationship) => [
      relationship.key,
      relationship,
    ]),
  );

  for (const operation of operations) {
    switch (operation.kind) {
      case "update-node":
      case "remove-node":
        entityKeys.add(`node:${operation.nodeId}`);
        break;
      case "update-relationship": {
        entityKeys.add(`relationship:${operation.relationshipId}`);
        const previous = currentRelationships.get(operation.relationshipId);
        if (previous) semanticKeys.add(semanticRelationshipKey(previous));
        const next = prospectiveByKey.get(operation.relationshipId);
        if (next) semanticKeys.add(workingSemanticKey(next));
        break;
      }
      case "remove-relationship": {
        entityKeys.add(`relationship:${operation.relationshipId}`);
        const previous = currentRelationships.get(operation.relationshipId);
        if (previous) semanticKeys.add(semanticRelationshipKey(previous));
        break;
      }
      case "add-relationship": {
        if ("nodeId" in operation.relationship.from) {
          entityKeys.add(`node:${operation.relationship.from.nodeId}`);
        }
        if ("nodeId" in operation.relationship.to) {
          entityKeys.add(`node:${operation.relationship.to.nodeId}`);
        }
        const next = prospectiveByKey.get(
          relationshipDraftKey(operation.draftRef),
        );
        if (next) semanticKeys.add(workingSemanticKey(next));
        break;
      }
      case "add-node":
        if (
          operation.node.ownerAgent &&
          "nodeId" in operation.node.ownerAgent
        ) {
          entityKeys.add(`node:${operation.node.ownerAgent.nodeId}`);
        }
        break;
    }
  }

  return {
    entityKeys: canonicalStrings([...entityKeys]),
    semanticRelationshipKeys: canonicalStrings([...semanticKeys]),
  };
}

export function proposalTouchSetsOverlap(
  left: ProposalTouchSet,
  right: ProposalTouchSet,
): boolean {
  const rightEntities = new Set(right.entityKeys);
  const rightSemantics = new Set(right.semanticRelationshipKeys);
  return (
    left.entityKeys.some((key) => rightEntities.has(key)) ||
    left.semanticRelationshipKeys.some((key) => rightSemantics.has(key))
  );
}

function deriveMaterializedTouchSet(
  current: AgentMapGraph,
  operations: readonly MapOperation[],
  prospective: AgentMapGraph,
): ProposalTouchSet {
  const currentRelationships = new Map(
    current.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const prospectiveRelationships = new Map(
    prospective.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const entityKeys = new Set<string>();
  const semanticKeys = new Set<string>();
  const addedNodeIds = new Set(
    operations.flatMap((operation) =>
      operation.kind === "add-node" ? [operation.node.id] : [],
    ),
  );

  for (const operation of operations) {
    switch (operation.kind) {
      case "update-node":
      case "remove-node":
        entityKeys.add(`node:${operation.nodeId}`);
        break;
      case "add-node":
        if (
          operation.node.ownerAgentId !== null &&
          !addedNodeIds.has(operation.node.ownerAgentId)
        ) {
          entityKeys.add(`node:${operation.node.ownerAgentId}`);
        }
        break;
      case "add-relationship":
        if (!addedNodeIds.has(operation.relationship.fromNodeId)) {
          entityKeys.add(`node:${operation.relationship.fromNodeId}`);
        }
        if (!addedNodeIds.has(operation.relationship.toNodeId)) {
          entityKeys.add(`node:${operation.relationship.toNodeId}`);
        }
        semanticKeys.add(semanticRelationshipKey(operation.relationship));
        break;
      case "update-relationship": {
        entityKeys.add(`relationship:${operation.relationshipId}`);
        const previous = currentRelationships.get(operation.relationshipId);
        const next = prospectiveRelationships.get(operation.relationshipId);
        if (previous) semanticKeys.add(semanticRelationshipKey(previous));
        if (next) semanticKeys.add(semanticRelationshipKey(next));
        break;
      }
      case "remove-relationship": {
        entityKeys.add(`relationship:${operation.relationshipId}`);
        const previous = currentRelationships.get(operation.relationshipId);
        if (previous) semanticKeys.add(semanticRelationshipKey(previous));
        break;
      }
    }
  }

  return {
    entityKeys: canonicalStrings([...entityKeys]),
    semanticRelationshipKeys: canonicalStrings([...semanticKeys]),
  };
}

/**
 * Resolve a declarative batch and validate its complete prospective graph.
 * This function is pure and never has access to an ID allocator.
 */
export function validateMapOperationBatch(
  currentInput: AgentMapGraph,
  requestInput: ProposalBatchRequest,
): ProposalValidationResult<ValidatedMapOperationBatch> {
  const current = canonicalizeAgentMapGraph(currentInput);
  const request = cloneRequest(requestInput);
  const issues: ProposalValidationIssue[] = [];

  if (request.operations.length === 0) {
    return {
      ok: false,
      issues: [issue("empty_batch", null, ["operations"])],
    };
  }

  const baseNodes = new Map<PlanNodeId, PlanNode>();
  for (const node of current.nodes) {
    if (baseNodes.has(node.id)) {
      issues.push(issue("malformed_input", null, ["current", "nodes"]));
    }
    baseNodes.set(node.id, node);
  }
  const baseRelationships = new Map<PlanRelationshipId, PlanRelationship>();
  for (const relationship of current.relationships) {
    if (baseRelationships.has(relationship.id)) {
      issues.push(issue("malformed_input", null, ["current", "relationships"]));
    }
    baseRelationships.set(relationship.id, relationship);
  }

  const allDrafts = new Map<DraftRef, number>();
  const nodeDrafts = new Map<DraftRef, number>();
  const existingTargets = new Map<string, number>();
  const removedNodeIds = new Map<PlanNodeId, number>();
  const removedRelationshipIds = new Set<PlanRelationshipId>();

  request.operations.forEach((operation, operationIndex) => {
    if (
      (operation.kind === "update-node" ||
        operation.kind === "update-relationship") &&
      Object.keys(operation.changes).length === 0
    ) {
      issues.push(
        issue("malformed_input", operationIndex, [
          "operations",
          operationIndex,
          "changes",
        ]),
      );
    }

    if (
      operation.kind === "add-node" ||
      operation.kind === "add-relationship"
    ) {
      const previous = allDrafts.get(operation.draftRef);
      if (previous !== undefined) {
        issues.push(
          issue("duplicate_draft_ref", operationIndex, [
            "operations",
            operationIndex,
            "draftRef",
          ]),
        );
      } else {
        allDrafts.set(operation.draftRef, operationIndex);
        if (operation.kind === "add-node") {
          nodeDrafts.set(operation.draftRef, operationIndex);
        }
      }
      return;
    }

    const target =
      operation.kind === "update-node" || operation.kind === "remove-node"
        ? `node:${operation.nodeId}`
        : `relationship:${operation.relationshipId}`;
    if (existingTargets.has(target)) {
      issues.push(
        issue("duplicate_target", operationIndex, [
          "operations",
          operationIndex,
          operation.kind.includes("relationship") ? "relationshipId" : "nodeId",
        ]),
      );
    } else {
      existingTargets.set(target, operationIndex);
    }

    if (operation.kind === "update-node" || operation.kind === "remove-node") {
      if (!baseNodes.has(operation.nodeId)) {
        issues.push(
          issue("unknown_reference", operationIndex, [
            "operations",
            operationIndex,
            "nodeId",
          ]),
        );
      }
      if (operation.kind === "remove-node") {
        removedNodeIds.set(operation.nodeId, operationIndex);
      }
    } else {
      if (!baseRelationships.has(operation.relationshipId)) {
        issues.push(
          issue("unknown_reference", operationIndex, [
            "operations",
            operationIndex,
            "relationshipId",
          ]),
        );
      }
      if (operation.kind === "remove-relationship") {
        removedRelationshipIds.add(operation.relationshipId);
      }
    }
  });

  const workingNodes = new Map<string, WorkingNode>();
  for (const node of current.nodes) {
    if (!removedNodeIds.has(node.id)) {
      workingNodes.set(node.id, {
        key: node.id,
        kind: node.kind,
        name: node.name,
        purpose: node.purpose,
        ownerKey: node.ownerAgentId,
        contractRefs: canonicalStrings(node.contractRefs),
        operationIndex: null,
      });
    }
  }

  request.operations.forEach((operation, operationIndex) => {
    if (operation.kind === "update-node") {
      const node = workingNodes.get(operation.nodeId);
      if (node) {
        workingNodes.set(operation.nodeId, {
          ...node,
          ...operation.changes,
          ...(operation.changes.contractRefs
            ? { contractRefs: canonicalStrings(operation.changes.contractRefs) }
            : {}),
          operationIndex,
        });
      }
      return;
    }
    if (operation.kind !== "add-node") return;

    const ownerKey = operation.node.ownerAgent
      ? resolveNodeRef(
          operation.node.ownerAgent,
          baseNodes,
          nodeDrafts,
          operationIndex,
          ["operations", operationIndex, "node", "ownerAgent"],
          issues,
        )
      : null;
    workingNodes.set(nodeDraftKey(operation.draftRef), {
      key: nodeDraftKey(operation.draftRef),
      kind: operation.node.kind,
      name: operation.node.name,
      purpose: operation.node.purpose,
      ownerKey,
      contractRefs: canonicalStrings(operation.node.contractRefs),
      operationIndex,
    });
  });

  const workingRelationships = new Map<string, WorkingRelationship>();
  for (const relationship of current.relationships) {
    if (!removedRelationshipIds.has(relationship.id)) {
      workingRelationships.set(relationship.id, {
        key: relationship.id,
        fromKey: relationship.fromNodeId,
        toKey: relationship.toNodeId,
        kind: relationship.kind,
        executionMode: relationship.executionMode,
        contractRef: relationship.contractRef,
        description: relationship.description,
        operationIndex: null,
        semanticOperationIndex: null,
      });
    }
  }

  request.operations.forEach((operation, operationIndex) => {
    if (operation.kind === "update-relationship") {
      const relationship = workingRelationships.get(operation.relationshipId);
      if (relationship) {
        workingRelationships.set(operation.relationshipId, {
          ...relationship,
          ...operation.changes,
          operationIndex,
          semanticOperationIndex:
            "executionMode" in operation.changes ||
            "contractRef" in operation.changes
              ? operationIndex
              : relationship.semanticOperationIndex,
        });
      }
      return;
    }
    if (operation.kind !== "add-relationship") return;

    const fromKey = resolveNodeRef(
      operation.relationship.from,
      baseNodes,
      nodeDrafts,
      operationIndex,
      ["operations", operationIndex, "relationship", "from"],
      issues,
    );
    const toKey = resolveNodeRef(
      operation.relationship.to,
      baseNodes,
      nodeDrafts,
      operationIndex,
      ["operations", operationIndex, "relationship", "to"],
      issues,
    );
    if (fromKey === null || toKey === null) return;
    workingRelationships.set(relationshipDraftKey(operation.draftRef), {
      key: relationshipDraftKey(operation.draftRef),
      fromKey,
      toKey,
      kind: operation.relationship.kind,
      executionMode: operation.relationship.executionMode,
      contractRef: operation.relationship.contractRef,
      description: operation.relationship.description,
      operationIndex,
      semanticOperationIndex: operationIndex,
    });
  });

  for (const [nodeId, operationIndex] of removedNodeIds) {
    for (const relationship of current.relationships) {
      if (
        (relationship.fromNodeId === nodeId ||
          relationship.toNodeId === nodeId) &&
        !removedRelationshipIds.has(relationship.id)
      ) {
        issues.push(
          issue("dependent_entity", operationIndex, [
            "operations",
            operationIndex,
            "nodeId",
          ]),
        );
      }
    }
    for (const node of current.nodes) {
      if (node.ownerAgentId === nodeId && !removedNodeIds.has(node.id)) {
        issues.push(
          issue("dependent_entity", operationIndex, [
            "operations",
            operationIndex,
            "nodeId",
          ]),
        );
      }
    }
  }

  for (const node of workingNodes.values()) {
    const owner = node.ownerKey ? workingNodes.get(node.ownerKey) : null;
    if (node.kind === "subagent") {
      if (
        node.ownerKey === null ||
        node.ownerKey === node.key ||
        owner?.kind !== "agent"
      ) {
        issues.push(
          issue("invalid_owner", node.operationIndex, [
            ...(node.operationIndex === null
              ? ["current", "nodes"]
              : ["operations", node.operationIndex, "node", "ownerAgent"]),
          ]),
        );
      }
    } else if (node.ownerKey !== null) {
      issues.push(
        issue("invalid_owner", node.operationIndex, [
          ...(node.operationIndex === null
            ? ["current", "nodes"]
            : ["operations", node.operationIndex, "node", "ownerAgent"]),
        ]),
      );
    }
  }

  const semanticKeys = new Map<string, string>();
  for (const relationship of workingRelationships.values()) {
    const path =
      relationship.operationIndex === null
        ? ["current", "relationships"]
        : ["operations", relationship.operationIndex, "relationship"];
    const from = workingNodes.get(relationship.fromKey);
    const to = workingNodes.get(relationship.toKey);
    if (!from || !to) {
      issues.push(issue("dependent_entity", relationship.operationIndex, path));
      continue;
    }
    if (relationship.fromKey === relationship.toKey) {
      issues.push(
        issue("self_relationship", relationship.operationIndex, path),
      );
      continue;
    }
    const endpointRule = RELATIONSHIP_ENDPOINT_MATRIX[relationship.kind];
    if (!endpointRule.from.has(from.kind) || !endpointRule.to.has(to.kind)) {
      issues.push(
        issue(
          "invalid_relationship_endpoints",
          relationship.operationIndex,
          path,
        ),
      );
      continue;
    }
    const semanticKey = workingSemanticKey(relationship);
    const duplicateKey = semanticKeys.get(semanticKey);
    if (duplicateKey !== undefined) {
      const duplicate = workingRelationships.get(duplicateKey);
      const contributor =
        relationship.semanticOperationIndex !== null ||
        duplicate === undefined ||
        duplicate.semanticOperationIndex === null
          ? relationship
          : duplicate;
      const contributorPath =
        contributor.operationIndex === null
          ? ["current", "relationships"]
          : ["operations", contributor.operationIndex, "relationship"];
      issues.push(
        issue(
          "duplicate_relationship",
          contributor.operationIndex,
          contributorPath,
        ),
      );
    } else {
      semanticKeys.set(semanticKey, relationship.key);
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues: deduplicateIssues(issues) };
  }

  const prospectiveNodes = [...workingNodes.values()].sort((left, right) =>
    compareStrings(left.key, right.key),
  );
  const prospectiveRelationships = [...workingRelationships.values()].sort(
    (left, right) => compareStrings(left.key, right.key),
  );
  return {
    ok: true,
    value: {
      request,
      current,
      prospective: {
        nodes: prospectiveNodes,
        relationships: prospectiveRelationships,
      },
      touchSet: deriveTouchSet(
        baseRelationships,
        request.operations,
        prospectiveRelationships,
      ),
    },
  };
}

function resolvedNodeId(
  ref: { nodeId: PlanNodeId } | { draftRef: DraftRef },
  allocatedNodeIds: Readonly<Record<string, PlanNodeId>>,
): PlanNodeId {
  return "nodeId" in ref ? ref.nodeId : allocatedNodeIds[ref.draftRef]!;
}

/** Allocate permanent IDs only after validation has accepted the whole batch. */
export function materializeValidatedMapBatch(
  validated: ValidatedMapOperationBatch,
  allocator: AgentMapIdAllocator,
): MaterializedMapBatch {
  // draftRef is caller-authored, so null-prototype records keep aliases such
  // as `__proto__` inert while preserving the public Record wire shape.
  const allocatedNodeIds = Object.create(null) as Record<DraftRef, PlanNodeId>;
  const allocatedRelationshipIds = Object.create(null) as Record<
    DraftRef,
    PlanRelationshipId
  >;
  const usedNodeIds = new Set(validated.current.nodes.map((node) => node.id));
  const usedRelationshipIds = new Set(
    validated.current.relationships.map((relationship) => relationship.id),
  );

  for (const operation of validated.request.operations) {
    if (operation.kind === "add-node") {
      const allocatedId = allocator.allocateNodeId();
      if (usedNodeIds.has(allocatedId)) {
        throw new Error("Agent Map allocator returned a duplicate node ID");
      }
      usedNodeIds.add(allocatedId);
      allocatedNodeIds[operation.draftRef] = allocatedId;
    }
  }
  for (const operation of validated.request.operations) {
    if (operation.kind === "add-relationship") {
      const allocatedId = allocator.allocateRelationshipId();
      if (usedRelationshipIds.has(allocatedId)) {
        throw new Error(
          "Agent Map allocator returned a duplicate relationship ID",
        );
      }
      usedRelationshipIds.add(allocatedId);
      allocatedRelationshipIds[operation.draftRef] = allocatedId;
    }
  }

  const operations: MapOperation[] = validated.request.operations.map(
    (operation): MapOperation => {
      switch (operation.kind) {
        case "add-node":
          return {
            kind: "add-node",
            node: {
              id: allocatedNodeIds[operation.draftRef]!,
              kind: operation.node.kind,
              name: operation.node.name,
              purpose: operation.node.purpose,
              ownerAgentId: operation.node.ownerAgent
                ? resolvedNodeId(operation.node.ownerAgent, allocatedNodeIds)
                : null,
              contractRefs: canonicalStrings(operation.node.contractRefs),
            },
          };
        case "update-node":
          return {
            ...operation,
            changes: {
              ...operation.changes,
              ...(operation.changes.contractRefs
                ? {
                    contractRefs: canonicalStrings(
                      operation.changes.contractRefs,
                    ),
                  }
                : {}),
            },
          };
        case "remove-node":
          return { ...operation };
        case "add-relationship":
          return {
            kind: "add-relationship",
            relationship: {
              id: allocatedRelationshipIds[operation.draftRef]!,
              fromNodeId: resolvedNodeId(
                operation.relationship.from,
                allocatedNodeIds,
              ),
              toNodeId: resolvedNodeId(
                operation.relationship.to,
                allocatedNodeIds,
              ),
              kind: operation.relationship.kind,
              executionMode: operation.relationship.executionMode,
              contractRef: operation.relationship.contractRef,
              description: operation.relationship.description,
            },
          };
        case "update-relationship":
          return { ...operation, changes: { ...operation.changes } };
        case "remove-relationship":
          return { ...operation };
      }
    },
  );

  const nodeIdForKey = (key: string): PlanNodeId => {
    if (!key.startsWith("draft-node:")) return key as PlanNodeId;
    return allocatedNodeIds[key.slice("draft-node:".length) as DraftRef]!;
  };
  const relationshipIdForKey = (key: string): PlanRelationshipId => {
    if (!key.startsWith("draft-relationship:")) {
      return key as PlanRelationshipId;
    }
    return allocatedRelationshipIds[
      key.slice("draft-relationship:".length) as DraftRef
    ]!;
  };

  const graph = canonicalizeAgentMapGraph({
    nodes: validated.prospective.nodes.map((node) => ({
      id: nodeIdForKey(node.key),
      kind: node.kind,
      name: node.name,
      purpose: node.purpose,
      ownerAgentId: node.ownerKey ? nodeIdForKey(node.ownerKey) : null,
      contractRefs: canonicalStrings(node.contractRefs),
    })),
    relationships: validated.prospective.relationships.map((relationship) => ({
      id: relationshipIdForKey(relationship.key),
      fromNodeId: nodeIdForKey(relationship.fromKey),
      toNodeId: nodeIdForKey(relationship.toKey),
      kind: relationship.kind,
      executionMode: relationship.executionMode,
      contractRef: relationship.contractRef,
      description: relationship.description,
    })),
  });

  return {
    operations,
    graph,
    allocatedNodeIds,
    allocatedRelationshipIds,
    touchSet: deriveMaterializedTouchSet(validated.current, operations, graph),
  };
}
