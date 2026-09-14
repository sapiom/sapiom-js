import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  AgentMapVersion,
  AgentMapVersionId,
  AgentMapVersionRef,
  MapOperation,
  PlanNodeKind,
  ProjectAgentActorRef,
  ProjectMutationOrigin,
  RecordDigest,
  StudioProjectId,
} from "../shared/agent-map.js";
import {
  canonicalizeAgentMapGraph,
  computeAgentMapVersionRecordDigest,
  computeGraphContentDigest,
} from "../shared/agent-map-canonical.js";
import { RELATIONSHIP_ENDPOINT_MATRIX, semanticRelationshipKey } from "./agent-map-proposal-validator.js";

export const agentMapVersionRef = (version: AgentMapVersion): AgentMapVersionRef => ({
  projectId: version.projectId,
  versionId: version.versionId,
  contentDigest: version.contentDigest,
});

export function applyPersistedMapOperations(
  graph: AgentMapGraph,
  operations: readonly MapOperation[],
): AgentMapGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, structuredClone(node)]));
  const relationships = new Map(graph.relationships.map((relationship) => [relationship.id, structuredClone(relationship)]));
  for (const operation of operations) {
    switch (operation.kind) {
      case "add-node": nodes.set(operation.node.id, structuredClone(operation.node)); break;
      case "update-node": {
        const current = nodes.get(operation.nodeId);
        if (!current) throw new TypeError("map operation references an unknown node");
        nodes.set(operation.nodeId, { ...current, ...structuredClone(operation.changes) });
        break;
      }
      case "remove-node":
        if (!nodes.delete(operation.nodeId)) throw new TypeError("map operation references an unknown node");
        break;
      case "add-relationship": relationships.set(operation.relationship.id, structuredClone(operation.relationship)); break;
      case "update-relationship": {
        const current = relationships.get(operation.relationshipId);
        if (!current) throw new TypeError("map operation references an unknown relationship");
        relationships.set(operation.relationshipId, { ...current, ...structuredClone(operation.changes) });
        break;
      }
      case "remove-relationship":
        if (!relationships.delete(operation.relationshipId)) throw new TypeError("map operation references an unknown relationship");
        break;
    }
  }
  return assertValidAgentMapGraph({ nodes: [...nodes.values()], relationships: [...relationships.values()] });
}

export function assertValidAgentMapGraph(graph: AgentMapGraph): AgentMapGraph {
  const canonical = canonicalizeAgentMapGraph(graph);
  const nodes = new Map(canonical.nodes.map((node) => [node.id, node]));
  const semanticEdges = new Set<string>();
  for (const node of canonical.nodes) {
    if (node.kind === "subagent") {
      const owner = node.ownerAgentId ? nodes.get(node.ownerAgentId) : undefined;
      if (owner?.kind !== "agent") throw new TypeError("invalid subagent owner");
    } else if (node.ownerAgentId !== null) throw new TypeError("invalid node owner");
  }
  for (const relationship of canonical.relationships) {
    const from = nodes.get(relationship.fromNodeId);
    const to = nodes.get(relationship.toNodeId);
    if (!from || !to || from.id === to.id) throw new TypeError("invalid relationship endpoint");
    const allowed = RELATIONSHIP_ENDPOINT_MATRIX[relationship.kind];
    if (!allowed.from.has(from.kind as PlanNodeKind) || !allowed.to.has(to.kind as PlanNodeKind))
      throw new TypeError("invalid relationship endpoint kind");
    const key = semanticRelationshipKey(relationship);
    if (semanticEdges.has(key)) throw new TypeError("duplicate semantic relationship");
    semanticEdges.add(key);
  }
  return canonical;
}

export function deterministicVersionId(
  prefix: "mapv" | "planv" | "briefv" | "proposal",
  parts: readonly string[],
): string {
  const hex = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createAgentMapVersion(input: {
  projectId: StudioProjectId;
  versionId: AgentMapVersionId;
  version: number;
  parentVersionId: AgentMapVersionId | null;
  graph: AgentMapGraph;
  changeKind: AgentMapVersion["changeKind"];
  restoredFromVersionId: AgentMapVersionId | null;
  authoredBy: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
}): AgentMapVersion {
  const graph = assertValidAgentMapGraph(input.graph);
  const base = {
    schemaVersion: 1 as const,
    ...input,
    graph,
    contentDigest: computeGraphContentDigest(graph),
  };
  return { ...base, recordDigest: computeAgentMapVersionRecordDigest(base) };
}

export function restoreAgentMapVersion(input: {
  projectId: StudioProjectId;
  current: AgentMapVersion;
  historical: AgentMapVersion;
  versionId: AgentMapVersionId;
  actor: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
}): AgentMapVersion {
  if (input.current.projectId !== input.projectId || input.historical.projectId !== input.projectId)
    throw new TypeError("cross-project map restoration");
  return createAgentMapVersion({
    projectId: input.projectId,
    versionId: input.versionId,
    version: input.current.version + 1,
    parentVersionId: input.current.versionId,
    graph: input.historical.graph,
    changeKind: "restored",
    restoredFromVersionId: input.historical.versionId,
    authoredBy: input.actor,
    createdAt: input.createdAt,
    origin: input.origin,
  });
}

export function appendRestoredAgentMapVersion(input: {
  projectId: StudioProjectId;
  versions: readonly AgentMapVersion[];
  expectedCurrent: AgentMapVersionRef;
  historical: AgentMapVersionRef;
  versionId: AgentMapVersionId;
  actor: ProjectAgentActorRef;
  createdAt: string;
  origin: ProjectMutationOrigin;
}): AgentMapVersion {
  validateAgentMapVersionHistory(input.versions, input.projectId);
  const current = input.versions.at(-1);
  const historical = input.versions.find(({ versionId }) => versionId === input.historical.versionId);
  if (!current ||
    current.versionId !== input.expectedCurrent.versionId ||
    current.contentDigest !== input.expectedCurrent.contentDigest ||
    input.expectedCurrent.projectId !== input.projectId)
    throw new TypeError("stale Agent Map restoration");
  if (!historical ||
    historical.contentDigest !== input.historical.contentDigest ||
    input.historical.projectId !== input.projectId)
    throw new TypeError("unknown Agent Map restoration source");
  return restoreAgentMapVersion({
    projectId: input.projectId,
    current,
    historical,
    versionId: input.versionId,
    actor: input.actor,
    createdAt: input.createdAt,
    origin: input.origin,
  });
}

export function validateAgentMapVersionHistory(
  versions: readonly AgentMapVersion[],
  projectId: StudioProjectId,
): void {
  const ids = new Set<string>();
  versions.forEach((version, index) => {
    if (
      version.projectId !== projectId ||
      version.version !== index + 1 ||
      version.parentVersionId !== (versions[index - 1]?.versionId ?? null) ||
      ids.has(version.versionId) ||
      computeGraphContentDigest(assertValidAgentMapGraph(version.graph)) !== version.contentDigest ||
      computeAgentMapVersionRecordDigest(version) !== version.recordDigest
    ) throw new TypeError("invalid Agent Map version history");
    if (version.changeKind === "restored" && !ids.has(version.restoredFromVersionId ?? ""))
      throw new TypeError("invalid Agent Map restoration source");
    ids.add(version.versionId);
  });
}

export const EMPTY_RECORD_DIGEST = `sha256:${"0".repeat(64)}` as RecordDigest;
