import type {
  MapChangeProposal,
  MapOperation,
  PlanNodeId,
  PlanRelationshipId,
} from "../../src/shared/agent-map.js";

/** Anonymous graph: 34 nodes, 13 edges, 21 components, 17 singleton agents. */
export function agentMapPackingFixture(
  projectId = "project_00000000-0000-4000-8000-000000000001",
  copies = 1,
): MapChangeProposal {
  const nodeId = (index: number) =>
    `node_00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}` as PlanNodeId;
  const nodes = Array.from({ length: 34 * copies }, (_, index) => {
    const local = index % 34;
    const kind = [1, 5, 9, 13].includes(local)
      ? "resource"
      : [2, 6, 8, 12, 15].includes(local)
        ? "artifact"
        : [3, 16].includes(local)
          ? "connector"
          : "agent";
    return {
      id: nodeId(index),
      kind,
      name: `${kind} ${index + 1}`,
      purpose: "Anonymous layout comparison",
      ownerAgentId: null,
      contractRefs: [],
    } as MapChangeProposal["nodes"][number];
  });
  const from = [0, 0, 0, 0, 4, 4, 7, 7, 7, 11, 11, 14, 14];
  const to = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 15, 16];
  const relationships: MapChangeProposal["relationships"] = Array.from(
    { length: 13 * copies },
    (_, index) => {
      const offset = Math.floor(index / 13) * 34,
        target = to[index % 13]! + offset;
      const kind =
        nodes[target]!.kind === "agent"
          ? "invokes"
          : nodes[target]!.kind === "artifact"
            ? "writes"
            : nodes[target]!.kind === "resource"
              ? "reads"
              : "uses";
      return {
        id: `rel_00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}` as PlanRelationshipId,
        fromNodeId: nodeId(from[index % 13]! + offset),
        toNodeId: nodeId(target),
        kind,
        executionMode: "asynchronous" as const,
        contractRef: null,
        description: "Transfer the result",
      };
    },
  );
  const at = "2026-09-08T00:00:00.000Z";
  const operations: MapOperation[] = [
    ...nodes.map((node) => ({ kind: "add-node" as const, node })),
    ...relationships.map((relationship) => ({
      kind: "add-relationship" as const,
      relationship,
    })),
  ];
  return {
    schemaVersion: 1,
    id: "proposal_00000000-0000-7000-8000-000000000105" as MapChangeProposal["id"],
    projectId,
    version: 1,
    baseRevisionId: null,
    nodes,
    relationships,
    history: operations.map((operation, index) => ({
      id: `operation_00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}` as MapChangeProposal["history"][number]["id"],
      requestId: "anonymous-fixture",
      acceptedVersion: 1,
      operation,
      actor: { userId: "user_fixture", sessionId: "session_fixture" },
      acceptedAt: at,
    })),
    createdAt: at,
    updatedAt: at,
  };
}
