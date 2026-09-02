import { describe, expect, it, vi } from "vitest";

import type {
  AgentMapGraph,
  DraftRef,
  MapOperationInput,
  PlanNode,
  PlanNodeId,
  PlanNodeKind,
  PlanRelationshipId,
  ProposalBatchRequest,
  RelationshipKind,
} from "../shared/agent-map.js";
import {
  canonicalizeAgentMapGraph,
  materializeValidatedMapBatch,
  proposalTouchSetsOverlap,
  RELATIONSHIP_ENDPOINT_MATRIX,
  semanticRelationshipKey,
  validateMapOperationBatch,
} from "./agent-map-proposal-validator.js";

const uuid = (value: number): string =>
  `018f0000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const nodeId = (value: number): PlanNodeId =>
  `node_${uuid(value)}` as PlanNodeId;
const relationshipId = (value: number): PlanRelationshipId =>
  `rel_${uuid(value)}` as PlanRelationshipId;
const draftRef = (value: string): DraftRef => value as DraftRef;

const request = (operations: MapOperationInput[]): ProposalBatchRequest => ({
  schemaVersion: 1,
  proposalId: null,
  expectedVersion: 0,
  requestId: "request_1",
  operations,
});

const node = (
  id: PlanNodeId,
  kind: PlanNodeKind,
  ownerAgentId: PlanNodeId | null = null,
): PlanNode => ({
  id,
  kind,
  name: `${kind}-${id}`,
  purpose: `Purpose for ${kind}`,
  ownerAgentId,
  contractRefs: [],
});

const empty: AgentMapGraph = { nodes: [], relationships: [] };

const addNode = (
  ref: string,
  kind: PlanNodeKind,
  ownerAgent: { draftRef: DraftRef } | { nodeId: PlanNodeId } | null = null,
): MapOperationInput => ({
  kind: "add-node",
  draftRef: draftRef(ref),
  node: {
    kind,
    name: ref,
    purpose: `${ref} purpose`,
    ownerAgent,
    contractRefs: [],
  },
});

const addRelationship = (
  ref: string,
  from: { draftRef: DraftRef } | { nodeId: PlanNodeId },
  to: { draftRef: DraftRef } | { nodeId: PlanNodeId },
  kind: RelationshipKind,
  overrides: Partial<{
    executionMode:
      | "synchronous"
      | "asynchronous"
      | "scheduled"
      | "human-triggered"
      | null;
    contractRef: string | null;
    description: string;
  }> = {},
): MapOperationInput => ({
  kind: "add-relationship",
  draftRef: draftRef(ref),
  relationship: {
    from,
    to,
    kind,
    executionMode: null,
    contractRef: null,
    description: ref,
    ...overrides,
  },
});

describe("validateMapOperationBatch", () => {
  it("accepts exactly the closed endpoint matrix for every kind pair", () => {
    const kinds: PlanNodeKind[] = [
      "agent",
      "subagent",
      "resource",
      "connector",
      "artifact",
    ];
    const relationshipKinds: RelationshipKind[] = [
      "invokes",
      "feeds",
      "reads",
      "writes",
      "uses",
      "triggers",
    ];

    for (const relationshipKind of relationshipKinds) {
      for (const fromKind of kinds) {
        for (const toKind of kinds) {
          const owner = nodeId(900);
          const from = nodeId(1);
          const to = nodeId(2);
          const graph: AgentMapGraph = {
            nodes: [
              node(owner, "agent"),
              node(from, fromKind, fromKind === "subagent" ? owner : null),
              node(to, toKind, toKind === "subagent" ? owner : null),
            ],
            relationships: [],
          };
          const result = validateMapOperationBatch(
            graph,
            request([
              addRelationship(
                "edge",
                { nodeId: from },
                { nodeId: to },
                relationshipKind,
              ),
            ]),
          );
          const rule = RELATIONSHIP_ENDPOINT_MATRIX[relationshipKind];
          expect(
            result.ok,
            `${relationshipKind}: ${fromKind} -> ${toKind}`,
          ).toBe(rule.from.has(fromKind) && rule.to.has(toKind));
        }
      }
    }
  });

  it("resolves forward owner and endpoint references across the whole batch", () => {
    const result = validateMapOperationBatch(
      empty,
      request([
        addRelationship(
          "delegates",
          { draftRef: draftRef("research") },
          { draftRef: draftRef("editor") },
          "invokes",
        ),
        addNode("editor", "subagent", { draftRef: draftRef("research") }),
        addNode("research", "agent"),
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    [
      "duplicate aliases",
      [addNode("same", "agent"), addNode("same", "resource")],
      "duplicate_draft_ref",
    ],
    [
      "missing aliases",
      [
        addRelationship(
          "edge",
          { draftRef: draftRef("missing") },
          { draftRef: draftRef("also_missing") },
          "invokes",
        ),
      ],
      "unknown_reference",
    ],
    ["orphaned subagents", [addNode("orphan", "subagent")], "invalid_owner"],
    [
      "non-agent owners",
      [
        addNode("store", "resource"),
        addNode("child", "subagent", { draftRef: draftRef("store") }),
      ],
      "invalid_owner",
    ],
  ])("rejects %s atomically", (_name, operations, code) => {
    const result = validateMapOperationBatch(empty, request(operations));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((entry) => entry.code)).toContain(code);
  });

  it("requires explicit incident-edge and owned-subagent removal", () => {
    const owner = nodeId(1);
    const child = nodeId(2);
    const other = nodeId(3);
    const edge = relationshipId(1);
    const graph: AgentMapGraph = {
      nodes: [
        node(owner, "agent"),
        node(child, "subagent", owner),
        node(other, "agent"),
      ],
      relationships: [
        {
          id: edge,
          fromNodeId: owner,
          toNodeId: other,
          kind: "invokes",
          executionMode: null,
          contractRef: null,
          description: "delegate",
        },
      ],
    };
    const incomplete = validateMapOperationBatch(
      graph,
      request([{ kind: "remove-node", nodeId: owner }]),
    );
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.issues.map((entry) => entry.code)).toContain(
        "dependent_entity",
      );
    }

    const complete = validateMapOperationBatch(
      graph,
      request([
        { kind: "remove-node", nodeId: owner },
        { kind: "remove-relationship", relationshipId: edge },
        { kind: "remove-node", nodeId: child },
      ]),
    );
    expect(complete.ok).toBe(true);
  });

  it("rejects self edges and semantic duplicates but permits distinct parallel edges", () => {
    const first = nodeId(1);
    const second = nodeId(2);
    const graph = {
      nodes: [node(first, "agent"), node(second, "agent")],
      relationships: [],
    };
    const self = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "self",
          { nodeId: first },
          { nodeId: first },
          "invokes",
        ),
      ]),
    );
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.issues[0]?.code).toBe("self_relationship");

    const duplicate = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "one",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { description: "one" },
        ),
        addRelationship(
          "two",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { description: "different prose" },
        ),
      ]),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.issues[0]?.code).toBe("duplicate_relationship");
    }

    const parallel = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "one",
          { nodeId: first },
          { nodeId: second },
          "invokes",
        ),
        addRelationship(
          "two",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { executionMode: "asynchronous" },
        ),
        addRelationship(
          "three",
          { nodeId: first },
          { nodeId: second },
          "feeds",
        ),
        addRelationship(
          "four",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { contractRef: "contract/v2" },
        ),
      ]),
    );
    expect(parallel.ok).toBe(true);
  });

  it("allows cycles and cross-owner subagent relationships", () => {
    const result = validateMapOperationBatch(
      empty,
      request([
        addNode("owner_a", "agent"),
        addNode("owner_b", "agent"),
        addNode("child_a", "subagent", { draftRef: draftRef("owner_a") }),
        addNode("child_b", "subagent", { draftRef: draftRef("owner_b") }),
        addRelationship(
          "a_to_b",
          { draftRef: draftRef("child_a") },
          { draftRef: draftRef("child_b") },
          "invokes",
        ),
        addRelationship(
          "b_to_a",
          { draftRef: draftRef("child_b") },
          { draftRef: draftRef("child_a") },
          "invokes",
        ),
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects multiple mutations of one existing identity", () => {
    const existing = nodeId(1);
    const result = validateMapOperationBatch(
      { nodes: [node(existing, "agent")], relationships: [] },
      request([
        { kind: "update-node", nodeId: existing, changes: { name: "renamed" } },
        { kind: "remove-node", nodeId: existing },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("duplicate_target");
  });

  it("drops undefined patch values and rejects an empty direct patch", () => {
    const existing = nodeId(1);
    const mixed = validateMapOperationBatch(
      { nodes: [node(existing, "agent")], relationships: [] },
      request([
        {
          kind: "update-node",
          nodeId: existing,
          changes: { name: undefined, purpose: "Defined purpose" },
        },
      ]),
    );
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.value.request.operations[0]).toMatchObject({
        changes: { purpose: "Defined purpose" },
      });
      expect(mixed.value.request.operations[0]).not.toHaveProperty(
        "changes.name",
      );
    }

    const emptyPatch = validateMapOperationBatch(
      { nodes: [node(existing, "agent")], relationships: [] },
      request([
        {
          kind: "update-node",
          nodeId: existing,
          changes: { name: undefined },
        },
      ]),
    );
    expect(emptyPatch).toEqual({
      ok: false,
      issues: [
        {
          code: "malformed_input",
          operationIndex: 0,
          path: ["operations", 0, "changes"],
          recovery: "correct",
        },
      ],
    });
  });

  it("marks invalid persisted graph state for reread, not caller correction", () => {
    const invalidStoredGraph: AgentMapGraph = {
      nodes: [node(nodeId(1), "subagent")],
      relationships: [],
    };
    const result = validateMapOperationBatch(
      invalidStoredGraph,
      request([addNode("unrelated", "agent")]),
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "invalid_owner",
          operationIndex: null,
          path: ["current", "nodes"],
          recovery: "reread",
        },
      ],
    });
  });
});

describe("proposal touch sets and canonicalization", () => {
  const baseGraph = (): AgentMapGraph => {
    const owner = nodeId(1);
    const target = nodeId(2);
    const artifact = nodeId(3);
    return {
      nodes: [
        node(owner, "agent"),
        node(target, "agent"),
        node(artifact, "artifact"),
      ],
      relationships: [
        {
          id: relationshipId(1),
          fromNodeId: owner,
          toNodeId: target,
          kind: "invokes",
          executionMode: null,
          contractRef: null,
          description: "existing",
        },
      ],
    };
  };

  it("overlaps node deletion with new endpoint and owner dependencies", () => {
    const graph = baseGraph();
    const removedNode = graph.nodes[0]!.id;
    const otherAgent = graph.nodes[1]!.id;
    const incidentEdge = graph.relationships[0]!.id;
    const deletion = validateMapOperationBatch(
      graph,
      request([
        { kind: "remove-node", nodeId: removedNode },
        { kind: "remove-relationship", relationshipId: incidentEdge },
      ]),
    );
    const newEdge = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "new_dependency",
          { nodeId: removedNode },
          { nodeId: otherAgent },
          "invokes",
          { executionMode: "asynchronous" },
        ),
      ]),
    );
    const newOwnedNode = validateMapOperationBatch(
      graph,
      request([addNode("new_child", "subagent", { nodeId: removedNode })]),
    );

    expect(deletion.ok).toBe(true);
    expect(newEdge.ok).toBe(true);
    expect(newOwnedNode.ok).toBe(true);
    if (!deletion.ok || !newEdge.ok || !newOwnedNode.ok) return;
    expect(
      proposalTouchSetsOverlap(deletion.value.touchSet, newEdge.value.touchSet),
    ).toBe(true);
    expect(
      proposalTouchSetsOverlap(
        deletion.value.touchSet,
        newOwnedNode.value.touchSet,
      ),
    ).toBe(true);
    expect(newEdge.value.touchSet.entityKeys).toContain(`node:${removedNode}`);
    expect(newOwnedNode.value.touchSet.entityKeys).toEqual([
      `node:${removedNode}`,
    ]);
  });

  it("keeps independent additions disjoint and semantic duplicates overlapping", () => {
    const graph = baseGraph();
    const first = graph.nodes[0]!.id;
    const second = graph.nodes[1]!.id;
    const agentEdge = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "agent_edge",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { executionMode: "asynchronous" },
        ),
      ]),
    );
    const duplicateAgentEdge = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "same_semantics",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { executionMode: "asynchronous", description: "different prose" },
        ),
      ]),
    );
    expect(agentEdge.ok).toBe(true);
    expect(duplicateAgentEdge.ok).toBe(true);
    if (!agentEdge.ok || !duplicateAgentEdge.ok) return;
    expect(
      proposalTouchSetsOverlap(
        agentEdge.value.touchSet,
        duplicateAgentEdge.value.touchSet,
      ),
    ).toBe(true);
    expect(agentEdge.value.touchSet.semanticRelationshipKeys).toEqual(
      duplicateAgentEdge.value.touchSet.semanticRelationshipKeys,
    );
    const updateFirst = validateMapOperationBatch(
      graph,
      request([
        { kind: "update-node", nodeId: first, changes: { name: "First" } },
      ]),
    );
    const updateSecond = validateMapOperationBatch(
      graph,
      request([
        { kind: "update-node", nodeId: second, changes: { name: "Second" } },
      ]),
    );
    expect(updateFirst.ok).toBe(true);
    expect(updateSecond.ok).toBe(true);
    if (updateFirst.ok && updateSecond.ok) {
      expect(
        proposalTouchSetsOverlap(
          updateFirst.value.touchSet,
          updateSecond.value.touchSet,
        ),
      ).toBe(false);
    }
  });

  it("canonicalizes graph order without mutating the input", () => {
    const graph: AgentMapGraph = {
      nodes: [
        { ...node(nodeId(2), "agent"), contractRefs: ["z", "a"] },
        node(nodeId(1), "agent"),
      ],
      relationships: [
        {
          id: relationshipId(2),
          fromNodeId: nodeId(2),
          toNodeId: nodeId(1),
          kind: "invokes",
          executionMode: null,
          contractRef: null,
          description: "second",
        },
        {
          id: relationshipId(1),
          fromNodeId: nodeId(1),
          toNodeId: nodeId(2),
          kind: "invokes",
          executionMode: null,
          contractRef: null,
          description: "first",
        },
      ],
    };
    const canonical = canonicalizeAgentMapGraph(graph);

    expect(canonical.nodes.map((entry) => entry.id)).toEqual([
      nodeId(1),
      nodeId(2),
    ]);
    expect(canonical.nodes[1]!.contractRefs).toEqual(["a", "z"]);
    expect(canonical.relationships.map((entry) => entry.id)).toEqual([
      relationshipId(1),
      relationshipId(2),
    ]);
    expect(graph.nodes[0]!.contractRefs).toEqual(["z", "a"]);
  });
});

describe("materializeValidatedMapBatch", () => {
  it("treats caller-authored record-key aliases as inert data", () => {
    const validated = validateMapOperationBatch(
      empty,
      request([addNode("__proto__", "agent")]),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const allocated = nodeId(77);
    const materialized = materializeValidatedMapBatch(validated.value, {
      allocateNodeId: () => allocated,
      allocateRelationshipId: () => relationshipId(77),
    });
    expect(Object.keys(materialized.allocatedNodeIds)).toEqual(["__proto__"]);
    expect(materialized.allocatedNodeIds[draftRef("__proto__")]).toBe(
      allocated,
    );
  });

  it("validates and materializes every operation variant declaratively", () => {
    const first = nodeId(1);
    const removed = nodeId(2);
    const resource = nodeId(3);
    const removedEdge = relationshipId(1);
    const updatedEdge = relationshipId(2);
    const graph: AgentMapGraph = {
      nodes: [
        node(first, "agent"),
        node(removed, "agent"),
        node(resource, "resource"),
      ],
      relationships: [
        {
          id: removedEdge,
          fromNodeId: first,
          toNodeId: removed,
          kind: "invokes",
          executionMode: null,
          contractRef: null,
          description: "old",
        },
        {
          id: updatedEdge,
          fromNodeId: first,
          toNodeId: resource,
          kind: "uses",
          executionMode: null,
          contractRef: null,
          description: "storage",
        },
      ],
    };
    const validated = validateMapOperationBatch(
      graph,
      request([
        addNode("artifact", "artifact"),
        {
          kind: "update-node",
          nodeId: first,
          changes: { purpose: "New purpose" },
        },
        { kind: "remove-node", nodeId: removed },
        addRelationship(
          "write",
          { nodeId: first },
          { draftRef: draftRef("artifact") },
          "writes",
        ),
        {
          kind: "update-relationship",
          relationshipId: updatedEdge,
          changes: { description: "durable storage" },
        },
        { kind: "remove-relationship", relationshipId: removedEdge },
      ]),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const materialized = materializeValidatedMapBatch(validated.value, {
      allocateNodeId: () => nodeId(10),
      allocateRelationshipId: () => relationshipId(10),
    });
    expect(materialized.operations.map((operation) => operation.kind)).toEqual([
      "add-node",
      "update-node",
      "remove-node",
      "add-relationship",
      "update-relationship",
      "remove-relationship",
    ]);
    expect(materialized.graph.nodes.map((entry) => entry.id)).not.toContain(
      removed,
    );
    expect(
      materialized.graph.relationships.map((entry) => entry.id),
    ).not.toContain(removedEdge);
  });

  it("materializes the stock-research golden batch with nodes allocated before edges", () => {
    const golden = request([
      addRelationship(
        "report_feed",
        { draftRef: draftRef("report") },
        { draftRef: draftRef("publisher") },
        "feeds",
        { contractRef: "ResearchReport/v1" },
      ),
      addNode("publisher", "agent"),
      addNode("distribution_channel", "connector"),
      addNode("research_store", "resource"),
      addNode("report", "artifact"),
      addNode("researcher", "agent"),
      addRelationship(
        "store_write",
        { draftRef: draftRef("researcher") },
        { draftRef: draftRef("research_store") },
        "writes",
      ),
      addRelationship(
        "publish",
        { draftRef: draftRef("publisher") },
        { draftRef: draftRef("distribution_channel") },
        "uses",
      ),
    ]);
    const validated = validateMapOperationBatch(empty, golden);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const calls: string[] = [];
    let nextNode = 1;
    let nextRelationship = 1;
    const allocator = {
      allocateNodeId: vi.fn(() => {
        calls.push("node");
        return nodeId(nextNode++);
      }),
      allocateRelationshipId: vi.fn(() => {
        calls.push("relationship");
        return relationshipId(nextRelationship++);
      }),
    };
    const materialized = materializeValidatedMapBatch(
      validated.value,
      allocator,
    );
    expect(calls).toEqual([
      "node",
      "node",
      "node",
      "node",
      "node",
      "relationship",
      "relationship",
      "relationship",
    ]);
    expect(Object.keys(materialized.allocatedNodeIds)).toHaveLength(5);
    expect(Object.keys(materialized.allocatedRelationshipIds)).toHaveLength(3);
    expect(materialized.graph.nodes).toHaveLength(5);
    expect(materialized.graph.relationships).toHaveLength(3);
    expect(
      materialized.touchSet.semanticRelationshipKeys.join(" "),
    ).not.toContain("draft-");
    expect(materialized.graph.nodes.map((entry) => entry.id)).toEqual(
      [...materialized.graph.nodes.map((entry) => entry.id)].sort(),
    );
  });

  it("does not allocate during validation and preserves stable IDs across rename", () => {
    const existing = nodeId(44);
    const allocator = {
      allocateNodeId: vi.fn(() => nodeId(99)),
      allocateRelationshipId: vi.fn(() => relationshipId(99)),
    };
    const validated = validateMapOperationBatch(
      { nodes: [node(existing, "agent")], relationships: [] },
      request([
        {
          kind: "update-node",
          nodeId: existing,
          changes: { name: "Renamed", contractRefs: ["z", "a"] },
        },
      ]),
    );
    expect(allocator.allocateNodeId).not.toHaveBeenCalled();
    expect(allocator.allocateRelationshipId).not.toHaveBeenCalled();
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const materialized = materializeValidatedMapBatch(
      validated.value,
      allocator,
    );
    expect(materialized.graph.nodes[0]).toMatchObject({
      id: existing,
      name: "Renamed",
      contractRefs: ["a", "z"],
    });
    expect(allocator.allocateNodeId).not.toHaveBeenCalled();
  });

  it("keeps validated and materialized touch sets aligned for existing refs", () => {
    const first = nodeId(1);
    const resource = nodeId(2);
    const graph = {
      nodes: [node(first, "agent"), node(resource, "resource")],
      relationships: [],
    };
    const validated = validateMapOperationBatch(
      graph,
      request([
        addRelationship(
          "storage",
          { nodeId: first },
          { nodeId: resource },
          "uses",
        ),
      ]),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const materialized = materializeValidatedMapBatch(validated.value, {
      allocateNodeId: () => nodeId(10),
      allocateRelationshipId: () => relationshipId(10),
    });
    expect(materialized.touchSet).toEqual(validated.value.touchSet);
  });

  it("rejects node and relationship ID allocator collisions", () => {
    const duplicateNodes = validateMapOperationBatch(
      empty,
      request([addNode("one", "agent"), addNode("two", "resource")]),
    );
    expect(duplicateNodes.ok).toBe(true);
    if (duplicateNodes.ok) {
      expect(() =>
        materializeValidatedMapBatch(duplicateNodes.value, {
          allocateNodeId: () => nodeId(10),
          allocateRelationshipId: () => relationshipId(10),
        }),
      ).toThrowError("duplicate node ID");
    }

    const first = nodeId(1);
    const second = nodeId(2);
    const duplicateRelationships = validateMapOperationBatch(
      {
        nodes: [node(first, "agent"), node(second, "agent")],
        relationships: [],
      },
      request([
        addRelationship(
          "one",
          { nodeId: first },
          { nodeId: second },
          "invokes",
        ),
        addRelationship(
          "two",
          { nodeId: first },
          { nodeId: second },
          "invokes",
          { executionMode: "asynchronous" },
        ),
      ]),
    );
    expect(duplicateRelationships.ok).toBe(true);
    if (duplicateRelationships.ok) {
      expect(() =>
        materializeValidatedMapBatch(duplicateRelationships.value, {
          allocateNodeId: () => nodeId(10),
          allocateRelationshipId: () => relationshipId(10),
        }),
      ).toThrowError("duplicate relationship ID");
    }
  });

  it("derives semantic keys without using mutable descriptions", () => {
    const base = {
      fromNodeId: nodeId(1),
      toNodeId: nodeId(2),
      kind: "invokes" as const,
      executionMode: null,
      contractRef: null,
    };
    const first = { ...base, description: "one" };
    const second = { ...base, description: "two" };
    expect(semanticRelationshipKey(first)).toBe(
      semanticRelationshipKey(second),
    );
  });
});
