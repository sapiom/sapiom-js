import type { AgentMapGraph, PlanNode } from "../shared/agent-map.js";
import type {
  AgentBriefRef,
  AgentBriefVersionRecord,
  BuilderBootstrapContext,
  BuilderBootstrapDigest,
  BuildMilestone,
  ProjectBuildPlanVersion,
} from "../shared/build-plan.js";
import {
  canonicalJson,
  computeCanonicalDigest,
} from "./build-plan-canonicalization.js";

export const BUILDER_BOOTSTRAP_MAX_BYTES = 128_000;
export const BUILDER_BOOTSTRAP_MAX_STRING_LENGTH = 4_000;
export const BUILDER_BOOTSTRAP_MAX_LIST_LENGTH = 256;
export const BUILDER_BOOTSTRAP_COMPILER_VERSION = "1.0.0";

export class BuilderBootstrapLimitError extends Error {
  constructor(readonly path: string) {
    super(`Builder bootstrap content exceeds its bound at ${path}`);
    this.name = "BuilderBootstrapLimitError";
  }
}

const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const byId = <T>(values: readonly T[], id: (value: T) => string): T[] =>
  [...values].sort((left, right) => compare(id(left), id(right)));

function assertBounds(value: unknown, path = "bootstrap"): void {
  if (typeof value === "string") {
    if (value.length > BUILDER_BOOTSTRAP_MAX_STRING_LENGTH)
      throw new BuilderBootstrapLimitError(path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > BUILDER_BOOTSTRAP_MAX_LIST_LENGTH)
      throw new BuilderBootstrapLimitError(path);
    value.forEach((entry, index) => assertBounds(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null)
    Object.entries(value).forEach(([key, entry]) =>
      assertBounds(entry, `${path}.${key}`),
    );
}

const summary = (node: PlanNode) => ({
  id: node.id,
  kind: node.kind,
  name: node.name,
  purpose: node.purpose,
  ownerAgentId: node.ownerAgentId,
  contractRefs: [...node.contractRefs].sort(compare),
});

function relevantMilestones(
  plan: ProjectBuildPlanVersion,
  selectedIds: readonly string[],
): BuildMilestone[] {
  const index = new Map(plan.milestones.map((entry) => [entry.milestoneId, entry]));
  const selected = new Set(selectedIds);
  const visit = (id: string): void => {
    const milestone = index.get(id as BuildMilestone["milestoneId"]);
    if (!milestone) return;
    selected.add(id);
    milestone.dependsOn.forEach(visit);
  };
  selectedIds.forEach(visit);
  return plan.milestones
    .filter((entry) => selected.has(entry.milestoneId))
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || compare(left.milestoneId, right.milestoneId),
    )
    .map((entry) => ({ ...entry, dependsOn: [...entry.dependsOn].sort(compare) }));
}

export function createBuilderBootstrapContext(input: {
  plan: ProjectBuildPlanVersion;
  graph: AgentMapGraph;
  brief: AgentBriefVersionRecord;
  briefRef?: AgentBriefRef;
}): BuilderBootstrapContext {
  const { plan, graph, brief } = input;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const agent = nodes.get(brief.plannedAgentId);
  if (!agent) throw new Error("planned agent is missing from the architecture");
  const assignment = plan.assignments.find(
    (entry) => entry.plannedAgentId === brief.plannedAgentId,
  );
  if (!assignment) throw new Error("planned agent assignment is missing");
  const briefRef = input.briefRef ?? {
    briefId: brief.briefId,
    version: brief.version,
    semanticDigest: brief.semanticDigest,
  };
  const withoutDigest = {
    schemaVersion: 1 as const,
    compilerVersion: brief.compilerVersion,
    assignmentId: brief.assignmentId,
    plannedAgentId: brief.plannedAgentId,
    architectureSource: plan.source,
    plan: {
      planId: plan.planId,
      version: plan.version,
      semanticDigest: plan.semanticDigest,
    },
    brief: briefRef,
    project: {
      outcome: plan.outcome.summary,
      relevantMilestones: relevantMilestones(plan, assignment.milestoneIds),
      sharedConstraints: byId(plan.sharedConstraints, (entry) => entry.constraintId),
      integrationCriteria: [...plan.integrationCriteria].sort(
        (left, right) =>
          left.ordinal - right.ordinal || compare(left.criterionId, right.criterionId),
      ),
    },
    architecture: {
      agent: summary(agent),
      ownedNodes: brief.ownedNodeIds
        .map((id) => nodes.get(id))
        .filter((node): node is PlanNode => node !== undefined)
        .sort((left, right) => compare(left.id, right.id))
        .map(summary),
      relevantNodes: brief.relevantNodeIds
        .map((id) => nodes.get(id))
        .filter((node): node is PlanNode => node !== undefined)
        .sort((left, right) => compare(left.id, right.id))
        .map(summary),
      contracts: byId(
        [...brief.inputs, ...brief.outputs],
        (entry) => `${entry.contractId}\0${entry.nodeId}`,
      ),
    },
    assignment: {
      mission: brief.mission,
      scope: brief.scope,
      inputs: brief.inputs,
      outputs: brief.outputs,
      dependencies: brief.dependencies,
      deliverables: brief.deliverables,
      acceptanceCriteria: brief.acceptanceCriteria,
      constraints: brief.constraints,
      repositoryIntents: byId(
        plan.repositoryIntents.filter(
          (entry) => entry.plannedAgentId === brief.plannedAgentId,
        ),
        (entry) => entry.repositoryIntentId,
      ),
      unresolvedDecisions: brief.unresolvedDecisions,
      changeProtocol: brief.changeProtocol,
    },
  };
  assertBounds(withoutDigest);
  const result: BuilderBootstrapContext = {
    ...withoutDigest,
    contextDigest: computeCanonicalDigest(
      "sapiom.builder-bootstrap.v1",
      withoutDigest,
    ) as BuilderBootstrapDigest,
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > BUILDER_BOOTSTRAP_MAX_BYTES)
    throw new BuilderBootstrapLimitError("bootstrap");
  return result;
}

/** SAP-3074 may place this canonical, escaped payload inside trusted delimiters. */
export function serializeBuilderBootstrapContext(
  context: BuilderBootstrapContext,
): string {
  const body = canonicalJson(context).replace(/[<>&]/gu, (character) =>
    character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026",
  );
  return `<builder-assignment-data trust="untrusted">\n${body}\n</builder-assignment-data>`;
}
