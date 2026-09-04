import { createHash } from "node:crypto";

import type {
  AgentMapGraph,
  PlanNode,
  PlanNodeId,
  PlanRelationship,
} from "../shared/agent-map.js";
import {
  canonicalDigest,
  canonicalJson,
  compareCanonicalStrings,
  computeAgentMapVersionRecordDigest,
  computeGraphContentDigest,
} from "../shared/agent-map-canonical.js";
import type {
  AgentBriefFocusSelection,
  CompileAgentBriefsRequest,
  CompileAgentBriefsResult,
  CompiledAgentBriefCandidate,
} from "../shared/agent-brief.js";
import {
  canonicalWorkstreamScopes,
  computeAgentBriefId,
  computeAgentBriefScopeKey,
} from "../shared/agent-brief.js";
import type {
  AgentBriefDependencyFingerprint,
  AgentBriefFingerprintKind,
  AgentBriefVersion,
  AgentBriefVersionId,
  BuildPlanAssignmentIntent,
  BuildPlanDiagnostic,
  ProjectBuildPlanVersion,
  ProjectBuildPlanVersionRef,
} from "../shared/build-plan.js";
import {
  AGENT_BRIEF_COMPILER_VERSION,
  BUILD_PLAN_SCHEMA_VERSION,
  agentMapVersionRefsEqual,
  projectBuildPlanVersionRefsEqual,
} from "../shared/build-plan.js";
import {
  computeAgentBriefRecordDigest,
  computeAgentBriefSemanticDigest,
  computeBuildPlanRecordDigest,
  computeBuildPlanSemanticDigest,
} from "./build-plan-canonicalization.js";
import { evaluateAgentBriefImpact } from "./build-plan-impact-evaluator.js";

export const AGENT_BRIEF_COMPILER_DIAGNOSTIC_LIMIT = 64;
export const AGENT_BRIEF_TEXT_LIMIT = 2_000;

const unique = <T extends string>(values: readonly T[]): T[] =>
  [...new Set(values)].sort(compareCanonicalStrings);
const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
const versionRef = (plan: ProjectBuildPlanVersion): ProjectBuildPlanVersionRef => ({
  projectId: plan.projectId,
  planId: plan.planId,
  versionId: plan.versionId,
  semanticDigest: plan.semanticDigest,
});
const deterministicVersionId = (briefId: string, version: number, inputFingerprint: string) => {
  const hex = createHash("sha256")
    .update(["sapiom.agent-brief.version-id.v1", briefId, String(version), inputFingerprint].join("\0"), "utf8")
    .digest("hex");
  return `briefv_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as AgentBriefVersionId;
};

function diagnostic(
  code: BuildPlanDiagnostic["code"],
  path: string,
  relatedIds: readonly string[] = [],
  severity: BuildPlanDiagnostic["severity"] = "error",
): BuildPlanDiagnostic {
  return { code, severity, path: path.slice(0, 512), relatedIds: unique(relatedIds).slice(0, 16) };
}

function finalizeDiagnostics(values: readonly BuildPlanDiagnostic[]): BuildPlanDiagnostic[] {
  const deduplicated = new Map<string, BuildPlanDiagnostic>();
  values.forEach((entry) => deduplicated.set(canonicalJson(entry), entry));
  return sorted([...deduplicated.values()], (entry) =>
    `${entry.path}\0${entry.code}\0${entry.relatedIds.join("\0")}`,
  ).slice(0, AGENT_BRIEF_COMPILER_DIAGNOSTIC_LIMIT);
}

type GraphIndex = Readonly<{
  nodes: ReadonlyMap<PlanNodeId, PlanNode>;
  relationships: readonly PlanRelationship[];
  rootByNodeId: ReadonlyMap<PlanNodeId, PlanNodeId>;
  ownedByRoot: ReadonlyMap<PlanNodeId, readonly PlanNodeId[]>;
  topLevelAgents: readonly PlanNode[];
}>;

function indexGraph(graph: AgentMapGraph, diagnostics: BuildPlanDiagnostic[]): GraphIndex {
  const nodes = new Map<PlanNodeId, PlanNode>();
  graph.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) diagnostics.push(diagnostic("invalid-dependency", `map.graph.nodes[${index}].id`, [node.id]));
    else nodes.set(node.id, node);
  });
  const rootByNodeId = new Map<PlanNodeId, PlanNodeId>();
  const resolveRoot = (node: PlanNode): PlanNodeId | null => {
    if (node.kind !== "subagent" && node.ownerAgentId !== null) {
      diagnostics.push(diagnostic("invalid-dependency", "map.graph.nodes.ownerAgentId", [node.id, node.ownerAgentId]));
      return null;
    }
    const seen = new Set<PlanNodeId>();
    let current: PlanNode | undefined = node;
    while (current) {
      if (seen.has(current.id)) {
        diagnostics.push(diagnostic("invalid-dependency", "map.graph.nodes.ownerAgentId", [...seen, current.id]));
        return null;
      }
      seen.add(current.id);
      if (current.ownerAgentId === null) return current.kind === "agent" ? current.id : null;
      const owner = nodes.get(current.ownerAgentId);
      if (current.kind === "subagent" && owner && (owner.kind !== "agent" || owner.ownerAgentId !== null)) {
        diagnostics.push(diagnostic("invalid-dependency", "map.graph.nodes.ownerAgentId", [node.id, owner.id]));
        return null;
      }
      current = owner;
      if (!current) {
        diagnostics.push(diagnostic("unknown-node-reference", "map.graph.nodes.ownerAgentId", [node.id]));
        return null;
      }
    }
    return null;
  };
  sorted([...nodes.values()], (node) => node.id).forEach((node) => {
    const root = resolveRoot(node);
    if (root) rootByNodeId.set(node.id, root);
  });
  const ownedByRoot = new Map<PlanNodeId, PlanNodeId[]>();
  rootByNodeId.forEach((root, nodeId) => ownedByRoot.set(root, [...(ownedByRoot.get(root) ?? []), nodeId]));
  ownedByRoot.forEach((ids) => ids.sort(compareCanonicalStrings));
  const relationshipIds = new Set<string>();
  const declaredContracts = new Set([...nodes.values()].flatMap(({ contractRefs }) => contractRefs));
  const relationships = sorted(graph.relationships, (entry) => entry.id).filter((relationship, index) => {
    if (relationshipIds.has(relationship.id)) {
      diagnostics.push(diagnostic("invalid-dependency", `map.graph.relationships[${index}].id`, [relationship.id]));
      return false;
    }
    relationshipIds.add(relationship.id);
    if (!nodes.has(relationship.fromNodeId) || !nodes.has(relationship.toNodeId)) {
      diagnostics.push(diagnostic("unknown-node-reference", `map.graph.relationships[${index}]`,
        [relationship.id, relationship.fromNodeId, relationship.toNodeId]));
      return false;
    }
    if (relationship.contractRef && !declaredContracts.has(relationship.contractRef))
      diagnostics.push(diagnostic("invalid-dependency", `map.graph.relationships[${index}].contractRef`,
        [relationship.id, relationship.contractRef]));
    return true;
  });
  return {
    nodes,
    relationships,
    rootByNodeId,
    ownedByRoot,
    topLevelAgents: sorted([...nodes.values()].filter((node) =>
      node.kind === "agent" && node.ownerAgentId === null), (node) => node.id),
  };
}

function verifyExactSources(request: CompileAgentBriefsRequest, diagnostics: BuildPlanDiagnostic[]): boolean {
  const { projectId, map, plan } = request;
  if (map.projectId !== projectId || plan.projectId !== projectId || plan.map.projectId !== projectId)
    diagnostics.push(diagnostic("source-mismatch", "projectId", [projectId, map.projectId, plan.projectId]));
  if (!agentMapVersionRefsEqual(plan.map, {
    projectId: map.projectId, versionId: map.versionId, contentDigest: map.contentDigest,
  })) diagnostics.push(diagnostic("source-mismatch", "plan.map", [map.versionId, plan.map.versionId]));
  const matches = (compute: () => string, expected: string): boolean => {
    try { return compute() === expected; } catch { return false; }
  };
  if (!matches(() => computeGraphContentDigest(map.graph), map.contentDigest))
    diagnostics.push(diagnostic("source-mismatch", "map.contentDigest", [map.versionId]));
  if (!matches(() => computeAgentMapVersionRecordDigest(map), map.recordDigest))
    diagnostics.push(diagnostic("source-mismatch", "map.recordDigest", [map.versionId]));
  if (!matches(() => computeBuildPlanSemanticDigest(plan), plan.semanticDigest))
    diagnostics.push(diagnostic("source-mismatch", "plan.semanticDigest", [plan.versionId]));
  if (!matches(() => computeBuildPlanRecordDigest(plan), plan.recordDigest))
    diagnostics.push(diagnostic("source-mismatch", "plan.recordDigest", [plan.versionId]));

  const maps = sorted(request.mapHistory, (entry) => `${String(entry.version).padStart(16, "0")}\0${entry.versionId}`);
  maps.forEach((entry, index) => {
    if (entry.projectId !== projectId || entry.version !== index + 1 ||
      entry.parentVersionId !== (maps[index - 1]?.versionId ?? null) ||
      !matches(() => computeGraphContentDigest(entry.graph), entry.contentDigest) ||
      !matches(() => computeAgentMapVersionRecordDigest(entry), entry.recordDigest))
      diagnostics.push(diagnostic("source-lineage-mismatch", `mapHistory[${index}]`, [entry.versionId]));
  });
  const plans = sorted(request.planHistory, (entry) => `${String(entry.version).padStart(16, "0")}\0${entry.versionId}`);
  plans.forEach((entry, index) => {
    const historicalMap = maps.find(({ versionId }) => versionId === entry.map.versionId);
    if (entry.projectId !== projectId || entry.version !== index + 1 ||
      entry.parentVersionId !== (plans[index - 1]?.versionId ?? null) ||
      !historicalMap || !agentMapVersionRefsEqual(entry.map, {
        projectId: historicalMap.projectId, versionId: historicalMap.versionId,
        contentDigest: historicalMap.contentDigest,
      }) || !matches(() => computeBuildPlanSemanticDigest(entry), entry.semanticDigest) ||
      !matches(() => computeBuildPlanRecordDigest(entry), entry.recordDigest))
      diagnostics.push(diagnostic("source-lineage-mismatch", `planHistory[${index}]`, [entry.versionId]));
  });
  if (!maps.some((entry) => entry.versionId === map.versionId && entry.contentDigest === map.contentDigest))
    diagnostics.push(diagnostic("source-lineage-mismatch", "mapHistory", [map.versionId]));
  if (!plans.some((entry) => projectBuildPlanVersionRefsEqual(versionRef(entry), versionRef(plan))))
    diagnostics.push(diagnostic("source-lineage-mismatch", "planHistory", [plan.versionId]));

  const mapById = new Map(maps.map((entry) => [entry.versionId, entry]));
  const planById = new Map(plans.map((entry) => [entry.versionId, entry]));
  request.previousBriefs.forEach(({ pointer, version }, index) => {
    const historicalMap = mapById.get(version.map.versionId);
    const historicalPlan = planById.get(version.plan.versionId);
    if (pointer.briefId !== version.briefId || pointer.scopeKey !== version.scopeKey ||
      pointer.focusScope.family !== version.focusScope.family ||
      canonicalJson(pointer.focusScope) !== canonicalJson(version.focusScope) ||
      pointer.version.projectId !== version.projectId || pointer.version.briefId !== version.briefId ||
      pointer.version.versionId !== version.versionId || pointer.version.semanticDigest !== version.semanticDigest ||
      !historicalMap || historicalMap.contentDigest !== version.map.contentDigest ||
      !historicalPlan || !projectBuildPlanVersionRefsEqual(versionRef(historicalPlan), version.plan) ||
      !matches(() => computeAgentBriefSemanticDigest(version), version.semanticDigest) ||
      !matches(() => computeAgentBriefRecordDigest(version), version.recordDigest))
      diagnostics.push(diagnostic("source-lineage-mismatch", `previousBriefs[${index}]`, [version.briefId]));
  });
  return diagnostics.every(({ code }) => code !== "source-mismatch" && code !== "source-lineage-mismatch");
}

const relationshipProjection = (relationship: PlanRelationship) => ({
  id: relationship.id,
  fromNodeId: relationship.fromNodeId,
  toNodeId: relationship.toNodeId,
  kind: relationship.kind,
  executionMode: relationship.executionMode,
  contractRef: relationship.contractRef,
  description: relationship.description,
});
const nodeProjection = (node: PlanNode) => ({
  id: node.id,
  kind: node.kind,
  name: node.name,
  purpose: node.purpose,
  ownerAgentId: node.ownerAgentId,
  contractRefs: unique(node.contractRefs),
});

function fingerprint(
  kind: AgentBriefFingerprintKind,
  value: unknown,
  refs: Partial<Omit<AgentBriefDependencyFingerprint, "kind" | "digest">> = {},
): AgentBriefDependencyFingerprint {
  return {
    kind,
    digest: canonicalDigest(`sapiom.agent-brief.fingerprint.${kind}.v1`, value),
    nodeIds: unique(refs.nodeIds ?? []),
    relationshipIds: unique(refs.relationshipIds ?? []),
    contractRefs: unique(refs.contractRefs ?? []),
  };
}

type ScopeProjection = Readonly<{
  root: PlanNodeId;
  assignment: BuildPlanAssignmentIntent;
  ownedNodeIds: PlanNodeId[];
  relevantNodeIds: PlanNodeId[];
  relationships: PlanRelationship[];
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  resources: PlanNodeId[];
}>;

type Flow = Readonly<{
  relationship: PlanRelationship;
  fromNodeId: PlanNodeId;
  toNodeId: PlanNodeId;
  fromRoot: PlanNodeId | null;
  toRoot: PlanNodeId | null;
}>;

function effectiveFlow(relationship: PlanRelationship, index: GraphIndex): Flow | null {
  if (relationship.kind === "uses") return null;
  const fromNodeId = relationship.kind === "reads" ? relationship.toNodeId : relationship.fromNodeId;
  const toNodeId = relationship.kind === "reads" ? relationship.fromNodeId : relationship.toNodeId;
  return { relationship, fromNodeId, toNodeId,
    fromRoot: index.rootByNodeId.get(fromNodeId) ?? null,
    toRoot: index.rootByNodeId.get(toNodeId) ?? null };
}

function actorRoot(nodeId: PlanNodeId, index: GraphIndex): PlanNodeId | null {
  const node = index.nodes.get(nodeId);
  return node?.kind === "agent" || node?.kind === "subagent"
    ? index.rootByNodeId.get(nodeId) ?? null
    : null;
}

function connectedFlowEvidence(
  flows: readonly Flow[],
  provider: PlanNodeId,
  consumer: PlanNodeId,
  index: GraphIndex,
): Flow[] | null {
  const starts = new Set(flows.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])
    .filter((nodeId) => actorRoot(nodeId, index) === provider));
  const targets = new Set(flows.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])
    .filter((nodeId) => actorRoot(nodeId, index) === consumer));
  if (starts.size === 0 || targets.size === 0) return null;
  const walk = (initial: ReadonlySet<PlanNodeId>, reverse: boolean) => {
    const reached = new Set(initial);
    const queue = [...initial];
    for (let offset = 0; offset < queue.length; offset += 1) {
      const current = queue[offset]!;
      for (const flow of flows) {
        const from = reverse ? flow.toNodeId : flow.fromNodeId;
        const to = reverse ? flow.fromNodeId : flow.toNodeId;
        if (from === current && !reached.has(to)) { reached.add(to); queue.push(to); }
      }
    }
    return reached;
  };
  const forward = walk(starts, false);
  if (![...targets].some((target) => forward.has(target))) return null;
  const backward = walk(targets, true);
  return flows.filter(({ fromNodeId, toNodeId }) => forward.has(fromNodeId) && backward.has(toNodeId));
}

function projectScope(
  selection: AgentBriefFocusSelection,
  plan: ProjectBuildPlanVersion,
  index: GraphIndex,
  diagnostics: BuildPlanDiagnostic[],
): ScopeProjection | null {
  const selected = selection.focusScope.family === "canonical-workstream"
    ? [...(index.ownedByRoot.get(selection.focusScope.plannedAgentId) ?? [])]
    : unique(selection.nodeIds ?? []);
  const missing = selected.filter((id) => !index.nodes.has(id));
  missing.forEach((id) => diagnostics.push(diagnostic("missing-focus-node", "selections.nodeIds", [id])));
  const valid = selected.filter((id) => index.nodes.has(id));
  const requestedAssignment = selection.assignmentId
    ? plan.content.assignments.find(({ id }) => id === selection.assignmentId)
    : undefined;
  const roots = unique(valid.flatMap((id) => {
    const root = index.rootByNodeId.get(id);
    return root ? [root] : [];
  }));
  const root = selection.focusScope.family === "canonical-workstream"
    ? selection.focusScope.plannedAgentId
    : requestedAssignment?.plannedAgentId ?? (roots.length === 1 ? roots[0] : undefined);
  if (!root || (roots.length > 1 && !requestedAssignment)) {
    diagnostics.push(diagnostic("ambiguous-focus-owner", "selections.focusScope", roots));
    return null;
  }
  const assignment = requestedAssignment ?? plan.content.assignments.find(({ plannedAgentId }) => plannedAgentId === root);
  if (!assignment) {
    diagnostics.push(diagnostic("missing-assignment", "plan.content.assignments", [root]));
    return null;
  }
  const ownedNodeIds = unique(valid.length > 0 ? valid : [root]);
  const owned = new Set(ownedNodeIds);
  const boundaryRelationships = index.relationships.filter((entry) => owned.has(entry.fromNodeId) || owned.has(entry.toNodeId));
  const relevant = new Set(boundaryRelationships.flatMap((entry) => [entry.fromNodeId, entry.toNodeId])
    .filter((id) => !owned.has(id)));
  const relevantRelationships = new Map(boundaryRelationships.map((entry) => [entry.id, entry]));
  const format = (entry: PlanRelationship, direction: "input" | "output") =>
    canonicalJson({ direction, relationshipId: entry.id, kind: entry.kind, executionMode: entry.executionMode,
      contractRef: entry.contractRef, fromNodeId: entry.fromNodeId, toNodeId: entry.toNodeId, description: entry.description });
  const flows = boundaryRelationships.map((entry) => effectiveFlow(entry, index)).filter((entry): entry is Flow => entry !== null);
  const inputs = flows.filter((entry) => owned.has(entry.toNodeId) && !owned.has(entry.fromNodeId))
    .map(({ relationship }) => format(relationship, "input"));
  const outputs = flows.filter((entry) => owned.has(entry.fromNodeId) && !owned.has(entry.toNodeId))
    .map(({ relationship }) => format(relationship, "output"));
  const dependencies = boundaryRelationships.filter((entry) => owned.has(entry.fromNodeId) !== owned.has(entry.toNodeId)).map((entry) =>
    canonicalJson({ relationshipId: entry.id, kind: entry.kind,
      direction: owned.has(entry.fromNodeId) ? "downstream" : "upstream",
      counterpartNodeId: owned.has(entry.fromNodeId) ? entry.toNodeId : entry.fromNodeId,
      contractRef: entry.contractRef, executionMode: entry.executionMode, description: entry.description }));
  const contractGroups = new Map<string, Flow[]>();
  index.relationships.forEach((relationship) => {
    if (!relationship.contractRef) return;
    const flow = effectiveFlow(relationship, index);
    if (flow) contractGroups.set(relationship.contractRef, [...(contractGroups.get(relationship.contractRef) ?? []), flow]);
  });
  for (const [contractRef, contractFlows] of [...contractGroups].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    const providers = unique(contractFlows.flatMap(({ fromNodeId }) => {
      const value = actorRoot(fromNodeId, index);
      return value ? [value] : [];
    }));
    const consumers = unique(contractFlows.flatMap(({ toNodeId }) => {
      const value = actorRoot(toNodeId, index);
      return value ? [value] : [];
    }));
    for (const provider of providers) for (const consumer of consumers) {
      if (provider === consumer || (provider !== root && consumer !== root)) continue;
      const evidence = connectedFlowEvidence(contractFlows, provider, consumer, index);
      if (!evidence) continue;
      evidence.forEach(({ relationship }) => {
        relevantRelationships.set(relationship.id, relationship);
        if (!owned.has(relationship.fromNodeId)) relevant.add(relationship.fromNodeId);
        if (!owned.has(relationship.toNodeId)) relevant.add(relationship.toNodeId);
      });
      const direction = provider === root ? "downstream" as const : "upstream" as const;
      dependencies.push(canonicalJson({
        kind: direction === "downstream" ? "provides-input" : "consumes-output",
        direction,
        counterpartAgentId: direction === "downstream" ? consumer : provider,
        relationshipIds: unique(evidence.map(({ relationship }) => relationship.id)),
        contractRef,
        blocking: true,
      }));
    }
  }
  const relationships = sorted([...relevantRelationships.values()], (entry) => entry.id);
  const relevantNodeIds = unique([...relevant]);
  const resources = unique(relevantNodeIds.filter((id) => {
    const kind = index.nodes.get(id)?.kind;
    return kind === "resource" || kind === "connector" || kind === "artifact";
  }));
  const bounded = (values: readonly string[], path: string) => unique(values).map((value) => {
    if ([...value].length <= AGENT_BRIEF_TEXT_LIMIT) return value;
    diagnostics.push(diagnostic("context-truncated", path, [root], "warning"));
    return `${[...value].slice(0, AGENT_BRIEF_TEXT_LIMIT - 1).join("")}…`;
  });
  return { root, assignment, ownedNodeIds, relevantNodeIds, relationships,
    inputs: bounded(inputs, "brief.content.inputs"),
    outputs: bounded(outputs, "brief.content.outputs"),
    dependencies: bounded(dependencies, "brief.content.dependencies"), resources };
}

function fingerprints(
  projection: ScopeProjection,
  selection: AgentBriefFocusSelection,
  plan: ProjectBuildPlanVersion,
  index: GraphIndex,
): AgentBriefDependencyFingerprint[] {
  const nodes = (ids: readonly PlanNodeId[]) => ids.flatMap((id) => {
    const node = index.nodes.get(id);
    return node ? [nodeProjection(node)] : [];
  });
  const relationshipIds = projection.relationships.map(({ id }) => id);
  const contractRefs = unique(projection.relationships.flatMap(({ contractRef }) => contractRef ? [contractRef] : []));
  const repositoryIntents = plan.content.repositoryIntents.filter(({ plannedAgentId }) => plannedAgentId === projection.root);
  return [
    fingerprint("owned-nodes", nodes(projection.ownedNodeIds), { nodeIds: projection.ownedNodeIds }),
    fingerprint("relevant-nodes", nodes(projection.relevantNodeIds), { nodeIds: projection.relevantNodeIds }),
    fingerprint("input-contracts", projection.inputs, { relationshipIds, contractRefs }),
    fingerprint("output-contracts", projection.outputs, { relationshipIds, contractRefs }),
    fingerprint("relationships", projection.relationships.map(relationshipProjection), { relationshipIds, contractRefs,
      nodeIds: unique(projection.relationships.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])) }),
    fingerprint("resources", nodes(projection.resources), { nodeIds: projection.resources, relationshipIds }),
    fingerprint("milestones", { milestones: plan.content.milestones, sequenceGates: plan.content.sequenceGates }, { nodeIds: [projection.root] }),
    fingerprint("shared-plan-content", { outcome: plan.content.outcome, nonGoals: plan.content.nonGoals,
      sharedConstraints: plan.content.sharedConstraints, integrationCriteria: plan.content.integrationCriteria,
      acceptanceCriteria: plan.content.acceptanceCriteria, decisions: plan.content.decisions,
      unresolvedDecisions: plan.content.unresolvedDecisions, risks: plan.content.risks, repositoryIntents }, { nodeIds: [projection.root] }),
    fingerprint("assignment-content", {
      assignment: projection.assignment,
      focusScope: selection.focusScope,
      ...(selection.mission === undefined ? {} : { mission: selection.mission }),
      ...(selection.scope === undefined ? {} : { scope: selection.scope }),
      ...(selection.nonGoals === undefined ? {} : { nonGoals: selection.nonGoals }),
      ...(selection.nodeIds === undefined ? {} : { nodeIds: unique(selection.nodeIds) }),
    }, { nodeIds: [projection.root] }),
  ];
}

function sealBrief(value: Omit<AgentBriefVersion, "semanticDigest" | "recordDigest">): AgentBriefVersion {
  const withSemantic = { ...value, semanticDigest: computeAgentBriefSemanticDigest(value) };
  return { ...withSemantic, recordDigest: computeAgentBriefRecordDigest(withSemantic) };
}

function compile(
  request: CompileAgentBriefsRequest,
  retireMissingCanonical: boolean,
): CompileAgentBriefsResult {
  const diagnostics: BuildPlanDiagnostic[] = [];
  if (!verifyExactSources(request, diagnostics)) return {
    map: request.map.contentDigest,
    plan: request.plan.semanticDigest,
    briefs: [],
    impact: evaluateAgentBriefImpact({ previousGraph: request.map.graph, nextGraph: request.map.graph,
      previousBriefs: [], previousFingerprints: new Map(), candidates: [] }),
    diagnostics: finalizeDiagnostics(diagnostics),
  };
  const index = indexGraph(request.map.graph, diagnostics);
  const previousByScope = new Map(request.previousBriefs.map((entry) => [entry.pointer.scopeKey, entry]));
  const candidates: CompiledAgentBriefCandidate[] = [];
  const currentFingerprints = new Map<string, readonly AgentBriefDependencyFingerprint[]>();
  const selectionCounts = new Map<string, number>();
  request.selections.forEach(({ focusScope }) => {
    const scopeKey = computeAgentBriefScopeKey(request.projectId, focusScope);
    selectionCounts.set(scopeKey, (selectionCounts.get(scopeKey) ?? 0) + 1);
  });
  for (const [selectionIndex, selection] of sorted(request.selections, (entry) =>
    computeAgentBriefScopeKey(request.projectId, entry.focusScope)).entries()) {
    const scopeKey = computeAgentBriefScopeKey(request.projectId, selection.focusScope);
    if ((selectionCounts.get(scopeKey) ?? 0) > 1) {
      diagnostics.push(diagnostic("invalid-dependency", `selections[${selectionIndex}].focusScope`, [scopeKey]));
      continue;
    }
    const projection = projectScope(selection, request.plan, index, diagnostics);
    if (!projection) continue;
    const previous = previousByScope.get(scopeKey) ?? null;
    const dependencyFingerprints = fingerprints(projection, selection, request.plan, index);
    currentFingerprints.set(scopeKey, dependencyFingerprints);
    const compilerInputFingerprint = canonicalDigest("sapiom.agent-brief.compiler-input.v1", dependencyFingerprints);
    const briefId = previous?.version.briefId ?? computeAgentBriefId(request.projectId, selection.focusScope);
    const nextVersion = (previous?.version.version ?? 0) + 1;
    const content = {
      mission: selection.mission ?? projection.assignment.mission,
      scope: unique(selection.scope ?? projection.assignment.scope),
      nonGoals: unique(selection.nonGoals ?? projection.assignment.nonGoals),
      ownedNodeIds: projection.ownedNodeIds,
      relevantNodeIds: projection.relevantNodeIds,
      inputs: projection.inputs,
      outputs: projection.outputs,
      dependencies: projection.dependencies,
      sharedResourceNodeIds: projection.resources,
      sequenceGateIds: request.plan.content.sequenceGates.map(({ id }) => id),
      deliverables: unique(projection.outputs.length > 0
        ? projection.outputs
        : [selection.mission ?? projection.assignment.mission]),
      acceptanceCriteria: unique([...request.plan.content.acceptanceCriteria, ...request.plan.content.integrationCriteria]),
      constraints: unique(request.plan.content.sharedConstraints),
      milestoneIds: request.plan.content.milestones.map(({ id }) => id),
      unresolvedDecisionIds: request.plan.content.unresolvedDecisions.filter(({ status }) => status === "open").map(({ id }) => id),
    };
    const base = {
      schemaVersion: BUILD_PLAN_SCHEMA_VERSION,
      projectId: request.projectId,
      briefId,
      scopeKey,
      focusScope: selection.focusScope,
      versionId: deterministicVersionId(briefId, nextVersion, compilerInputFingerprint),
      version: nextVersion,
      parentVersionId: previous?.version.versionId ?? null,
      changeKind: previous ? "edited" as const : "created" as const,
      restoredFromVersionId: null,
      assignmentId: projection.assignment.id,
      plannedAgentId: projection.root,
      map: { projectId: request.map.projectId, versionId: request.map.versionId, contentDigest: request.map.contentDigest },
      plan: versionRef(request.plan),
      content,
      compilerVersion: AGENT_BRIEF_COMPILER_VERSION,
      compilerInputFingerprint,
      authoredBy: request.plan.authoredBy,
      createdAt: request.plan.createdAt,
      origin: request.plan.origin,
    };
    const draft = sealBrief(base);
    const unchanged = previous?.pointer.status === "active" && previous.version.semanticDigest === draft.semanticDigest;
    candidates.push({ scopeKey, focusScope: selection.focusScope,
      disposition: !previous ? "created" : unchanged ? "unchanged" : "new-version",
      previous: previous?.version ?? null, brief: unchanged ? previous.version : draft,
      fingerprints: dependencyFingerprints });
    if (content.mission.trim().length === 0)
      diagnostics.push(diagnostic("missing-brief", `selections[${selectionIndex}].mission`, [scopeKey]));
  }

  if (retireMissingCanonical) {
    const active = new Set(canonicalWorkstreamScopes(index.topLevelAgents.map(({ id }) => id))
      .map((scope) => computeAgentBriefScopeKey(request.projectId, scope)));
    for (const previous of sorted(request.previousBriefs, (entry) => entry.pointer.scopeKey)) {
      if (previous.pointer.focusScope.family !== "canonical-workstream" || active.has(previous.pointer.scopeKey) ||
        previous.pointer.status === "retired") continue;
      const nextVersion = previous.version.version + 1;
      const retired = sealBrief({ ...previous.version,
        versionId: deterministicVersionId(previous.version.briefId, nextVersion, previous.version.compilerInputFingerprint),
        version: nextVersion, parentVersionId: previous.version.versionId, changeKind: "edited", restoredFromVersionId: null,
        map: { projectId: request.map.projectId, versionId: request.map.versionId, contentDigest: request.map.contentDigest },
        plan: versionRef(request.plan), createdAt: request.plan.createdAt, authoredBy: request.plan.authoredBy,
        origin: request.plan.origin });
      candidates.push({ scopeKey: previous.pointer.scopeKey, focusScope: previous.pointer.focusScope,
        disposition: "retired", previous: previous.version, brief: retired,
        fingerprints: [] });
    }
  }

  const previousPlan = [...request.planHistory]
    .filter(({ versionId }) => versionId !== request.plan.versionId)
    .sort((left, right) => right.version - left.version)[0];
  const previousMap = previousPlan
    ? request.mapHistory.find(({ versionId }) => versionId === previousPlan.map.versionId)
    : undefined;
  const previousFingerprints = new Map<string, readonly AgentBriefDependencyFingerprint[]>();
  for (const { pointer, version } of request.previousBriefs) {
    const historicalPlan = request.planHistory.find(({ versionId }) => version.plan.versionId === versionId);
    const historicalMap = request.mapHistory.find(({ versionId }) => version.map.versionId === versionId);
    if (!historicalPlan || !historicalMap) {
      previousFingerprints.set(pointer.scopeKey, []);
      continue;
    }
    const historicalIndex = indexGraph(historicalMap.graph, []);
    const historicalSelection: AgentBriefFocusSelection = pointer.focusScope.family === "canonical-workstream"
      ? { focusScope: pointer.focusScope }
      : { focusScope: pointer.focusScope, nodeIds: version.content.ownedNodeIds,
          assignmentId: version.assignmentId, mission: version.content.mission,
          scope: version.content.scope, nonGoals: version.content.nonGoals };
    const historicalProjection = projectScope(historicalSelection, historicalPlan, historicalIndex, []);
    previousFingerprints.set(pointer.scopeKey, historicalProjection
      ? fingerprints(historicalProjection, historicalSelection, historicalPlan, historicalIndex)
      : []);
  }
  const impact = evaluateAgentBriefImpact({
    previousGraph: previousMap?.graph ?? { nodes: [], relationships: [] },
    nextGraph: request.map.graph,
    previousBriefs: request.previousBriefs,
    previousFingerprints,
    candidates,
  });
  return { map: request.map.contentDigest, plan: request.plan.semanticDigest,
    briefs: sorted(candidates, (entry) => entry.scopeKey), impact,
    diagnostics: finalizeDiagnostics(diagnostics) };
}

/** Compile and retire the canonical one-brief-per-top-level-workstream set. */
export function compileCanonicalWorkstreamBriefs(
  request: Omit<CompileAgentBriefsRequest, "selections">,
): CompileAgentBriefsResult {
  const topLevel = request.map.graph.nodes.filter((node) => node.kind === "agent" && node.ownerAgentId === null)
    .map(({ id }) => id);
  return compile({ ...request, selections: canonicalWorkstreamScopes(topLevel).map((focusScope) => ({ focusScope })) }, true);
}

/** Compile one or more explicit ad-hoc/nested focus selections without sweeping unrelated history. */
export function projectFocusedBriefs(request: CompileAgentBriefsRequest): CompileAgentBriefsResult {
  return compile(request, false);
}

/** Compatibility-neutral public entry: explicit selections compile without lifecycle sweeping. */
export const compileAgentBriefs = projectFocusedBriefs;

export class DeterministicAgentBriefCompiler {
  compileCanonical(request: Omit<CompileAgentBriefsRequest, "selections">): CompileAgentBriefsResult {
    return compileCanonicalWorkstreamBriefs(request);
  }

  compileFocused(request: CompileAgentBriefsRequest): CompileAgentBriefsResult {
    return projectFocusedBriefs(request);
  }
}
