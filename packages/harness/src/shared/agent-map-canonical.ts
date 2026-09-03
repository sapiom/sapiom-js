import type {
  AgentMapGraph,
  ExecutionMode,
  PlanNode,
  PlanNodeId,
  PlanNodeKind,
  PlanRelationship,
  PlanRelationshipId,
  RelationshipKind,
  StudioProjectId,
} from "./agent-map.js";

/**
 * Changing this tuple is an Agent Map digest protocol change. Object property
 * order, locale collation, and incidental proposal metadata must never affect
 * the architecture identity.
 */
export type CanonicalAgentMapArchitectureV1 = readonly [
  "sapiom.agent-map.architecture",
  1,
  StudioProjectId,
  readonly (readonly [
    PlanNodeId,
    PlanNodeKind,
    string,
    string,
    PlanNodeId | null,
    readonly string[],
  ])[],
  readonly (readonly [
    PlanRelationshipId,
    PlanNodeId,
    PlanNodeId,
    RelationshipKind,
    ExecutionMode | null,
    string | null,
    string,
  ])[],
];

export const compareAgentMapStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalizeAgentMapStrings = (
  values: readonly string[],
): string[] => [...values].sort(compareAgentMapStrings);

const canonicalNode = (node: PlanNode): PlanNode => ({
  ...node,
  contractRefs: canonicalizeAgentMapStrings(node.contractRefs),
});

const canonicalRelationship = (
  relationship: PlanRelationship,
): PlanRelationship => ({ ...relationship });

/** Return a deep-enough defensive graph copy in protocol ordering. */
export function canonicalizeAgentMapGraph(graph: AgentMapGraph): AgentMapGraph {
  return {
    nodes: graph.nodes
      .map(canonicalNode)
      .sort((left, right) => compareAgentMapStrings(left.id, right.id)),
    relationships: graph.relationships
      .map(canonicalRelationship)
      .sort((left, right) => compareAgentMapStrings(left.id, right.id)),
  };
}

function assertUniqueCanonicalInputs(graph: AgentMapGraph): void {
  if (new Set(graph.nodes.map(({ id }) => id)).size !== graph.nodes.length)
    throw new Error("duplicate Agent Map node ID");
  if (
    new Set(graph.relationships.map(({ id }) => id)).size !==
    graph.relationships.length
  )
    throw new Error("duplicate Agent Map relationship ID");
  if (
    graph.nodes.some(
      ({ contractRefs }) => new Set(contractRefs).size !== contractRefs.length,
    )
  )
    throw new Error("duplicate Agent Map contract reference");
}

/** Build the exact JSON-serializable V1 architecture digest payload. */
export function canonicalAgentMapArchitecturePayload(
  projectId: StudioProjectId,
  graph: AgentMapGraph,
): CanonicalAgentMapArchitectureV1 {
  assertUniqueCanonicalInputs(graph);
  const canonical = canonicalizeAgentMapGraph(graph);
  return [
    "sapiom.agent-map.architecture",
    1,
    projectId,
    canonical.nodes.map(
      ({ id, kind, name, purpose, ownerAgentId, contractRefs }) =>
        [id, kind, name, purpose, ownerAgentId, contractRefs] as const,
    ),
    canonical.relationships.map(
      ({
        id,
        fromNodeId,
        toNodeId,
        kind,
        executionMode,
        contractRef,
        description,
      }) =>
        [
          id,
          fromNodeId,
          toNodeId,
          kind,
          executionMode,
          contractRef,
          description,
        ] as const,
    ),
  ];
}
