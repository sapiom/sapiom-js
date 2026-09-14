import type { AgentMapGraph, PlanNodeId } from "../shared/agent-map.js";
import { canonicalDigest, canonicalJson, compareCanonicalStrings } from "../shared/agent-map-canonical.js";
import type {
  AgentBriefDependencyFingerprint,
  AgentBriefFingerprintKind,
  AgentBriefImpact,
  AgentBriefImpactEntry,
  AgentBriefStaleReason,
} from "../shared/build-plan.js";
import type { CompiledAgentBriefCandidate, PreviousAgentBrief } from "../shared/agent-brief.js";

export const AGENT_BRIEF_IMPACT_ENTRY_LIMIT = 256;
export const AGENT_BRIEF_IMPACT_EVIDENCE_LIMIT = 32;

const unique = <T extends string>(values: readonly T[]): T[] =>
  [...new Set(values)].sort(compareCanonicalStrings);

const changedIds = <T extends { id: string }>(left: readonly T[], right: readonly T[]): string[] => {
  const before = new Map(left.map((entry) => [entry.id, entry]));
  const after = new Map(right.map((entry) => [entry.id, entry]));
  return unique([...before.keys(), ...after.keys()]).filter(
    (id) => canonicalJson(before.get(id) ?? null) !== canonicalJson(after.get(id) ?? null),
  );
};

function changedContracts(previous: AgentMapGraph, next: AgentMapGraph): string[] {
  const project = (graph: AgentMapGraph) => {
    const contracts = new Map<string, unknown[]>();
    const add = (key: string, value: unknown) => contracts.set(key, [...(contracts.get(key) ?? []), value]);
    graph.nodes.forEach((node) => node.contractRefs.forEach((contractRef) => add(contractRef, {
      nodeId: node.id, kind: node.kind, ownerAgentId: node.ownerAgentId,
    })));
    graph.relationships.forEach((relationship) => {
      if (relationship.contractRef) add(relationship.contractRef, relationship);
    });
    return new Map([...contracts].map(([key, values]) => [key,
      values.sort((a, b) => compareCanonicalStrings(canonicalJson(a), canonicalJson(b)))]));
  };
  const before = project(previous);
  const after = project(next);
  return unique([...before.keys(), ...after.keys()]).filter(
    (key) => canonicalJson(before.get(key) ?? []) !== canonicalJson(after.get(key) ?? []),
  );
}

const reasonCode = (kind: AgentBriefFingerprintKind): AgentBriefStaleReason["code"] => {
  switch (kind) {
    case "owned-nodes": return "ownership-changed";
    case "relevant-nodes": return "relevant-node-changed";
    case "input-contracts":
    case "output-contracts": return "contract-changed";
    case "relationships": return "relationship-changed";
    case "resources": return "resource-changed";
    case "milestones": return "milestone-changed";
    case "shared-plan-content": return "shared-plan-content-changed";
    case "assignment-content": return "assignment-content-changed";
  }
};

function reasons(
  previous: readonly AgentBriefDependencyFingerprint[],
  next: readonly AgentBriefDependencyFingerprint[],
  changed: Readonly<{ nodes: Set<string>; relationships: Set<string>; contracts: Set<string> }>,
): AgentBriefStaleReason[] {
  const before = new Map(previous.map((entry) => [entry.kind, entry]));
  const after = new Map(next.map((entry) => [entry.kind, entry]));
  return unique([...before.keys(), ...after.keys()]).flatMap((kind) => {
    const left = before.get(kind as AgentBriefFingerprintKind);
    const right = after.get(kind as AgentBriefFingerprintKind);
    if (left?.digest === right?.digest) return [];
    const values = [left, right].filter((entry): entry is AgentBriefDependencyFingerprint => entry !== undefined);
    const evidence = <T extends string>(ids: readonly T[], changedSet: Set<string>, graphDerived: boolean) =>
      unique(ids).filter((id) => !graphDerived || changedSet.has(id)).slice(0, AGENT_BRIEF_IMPACT_EVIDENCE_LIMIT);
    const graphDerived = !["milestones", "shared-plan-content", "assignment-content"].includes(kind);
    return [{
      code: reasonCode(kind as AgentBriefFingerprintKind),
      affectedNodeIds: evidence(values.flatMap((entry) => entry.nodeIds), changed.nodes, graphDerived) as PlanNodeId[],
      affectedRelationshipIds: evidence(values.flatMap((entry) => entry.relationshipIds), changed.relationships, graphDerived),
      affectedContractRefs: evidence(values.flatMap((entry) => entry.contractRefs), changed.contracts, graphDerived),
      ...(left ? { previousFingerprint: left.digest } : {}),
      ...(right ? { currentFingerprint: right.digest } : {}),
    }];
  });
}

/** Categorized, canonical-workstream-only stale impact. Delegations never pollute project impact. */
export function evaluateAgentBriefImpact(input: Readonly<{
  previousGraph: AgentMapGraph;
  nextGraph: AgentMapGraph;
  previousBriefs: readonly PreviousAgentBrief[];
  previousFingerprints: ReadonlyMap<string, readonly AgentBriefDependencyFingerprint[]>;
  candidates: readonly CompiledAgentBriefCandidate[];
}>): AgentBriefImpact {
  const previous = new Map(input.previousBriefs
    .filter(({ pointer }) => pointer.focusScope.family === "canonical-workstream")
    .map((entry) => [entry.pointer.scopeKey, entry]));
  const next = new Map(input.candidates
    .filter(({ focusScope }) => focusScope.family === "canonical-workstream")
    .map((entry) => [entry.scopeKey, entry]));
  const nodeIds = changedIds(input.previousGraph.nodes, input.nextGraph.nodes) as PlanNodeId[];
  const relationshipIds = changedIds(input.previousGraph.relationships, input.nextGraph.relationships);
  const contractRefs = changedContracts(input.previousGraph, input.nextGraph);
  const changed = { nodes: new Set<string>(nodeIds), relationships: new Set(relationshipIds), contracts: new Set(contractRefs) };
  const entries: AgentBriefImpactEntry[] = [];
  const stale = [];
  const preserved = [];
  for (const scopeKey of unique([...previous.keys(), ...next.keys()]).slice(0, AGENT_BRIEF_IMPACT_ENTRY_LIMIT)) {
    const before = previous.get(scopeKey);
    const after = next.get(scopeKey);
    if (!before && after) {
      entries.push({ scopeKey: after.scopeKey, briefId: after.brief.briefId, disposition: "added", reasons: [{
        code: "agent-added", affectedNodeIds: [after.brief.plannedAgentId], affectedRelationshipIds: [], affectedContractRefs: [],
      }] });
      continue;
    }
    if (before && (!after || after.disposition === "retired")) {
      stale.push(before.version.briefId);
      entries.push({ scopeKey: before.pointer.scopeKey, briefId: before.version.briefId, disposition: "removed", reasons: [{
        code: "agent-removed", affectedNodeIds: [before.version.plannedAgentId], affectedRelationshipIds: [], affectedContractRefs: [],
      }] });
      continue;
    }
    const staleReasons = reasons(
      input.previousFingerprints.get(scopeKey) ?? [],
      after!.fingerprints,
      changed,
    );
    if (staleReasons.length > 0) stale.push(after!.brief.briefId);
    else preserved.push(after!.brief.briefId);
    entries.push({ scopeKey: after!.scopeKey, briefId: after!.brief.briefId,
      disposition: staleReasons.length > 0 ? "stale" : "preserved", reasons: staleReasons });
  }
  const withoutDigest = {
    affectedWorkstreamCount: entries.filter(({ disposition }) => disposition !== "preserved").length,
    entries,
    staleBriefIds: unique(stale),
    preservedBriefIds: unique(preserved),
    changedNodeIds: nodeIds.slice(0, AGENT_BRIEF_IMPACT_EVIDENCE_LIMIT),
    changedRelationshipIds: relationshipIds.slice(0, AGENT_BRIEF_IMPACT_EVIDENCE_LIMIT),
    changedContractRefs: contractRefs.slice(0, AGENT_BRIEF_IMPACT_EVIDENCE_LIMIT),
  };
  return { ...withoutDigest, digest: canonicalDigest("sapiom.agent-brief.impact.v1", withoutDigest) };
}
