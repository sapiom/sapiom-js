import { describe, expect, it } from "vitest";

import type {
  AgentMapGraph,
  PlanNodeId,
  PlanRelationshipId,
} from "../shared/agent-map.js";
import type {
  AgentBriefId,
  ArchitectureSourceRef,
  BriefDependencyId,
  PlanContractId,
  PlanDecisionId,
  PlanningAssignmentId,
} from "../shared/build-plan.js";
import {
  AGENT_ID,
  graph,
  makeBrief,
  makePlan,
  PROJECT_ID,
} from "./build-plan.test-support.js";
import {
  BuildPlanContractValidator,
  computeBriefFreshness,
} from "./build-plan-contract-validator.js";

const validator = new BuildPlanContractValidator({
  resolve: async (_projectId, source) => ({
    projectId: PROJECT_ID,
    source,
    graph,
  }),
});

describe("BuildPlanContractValidator", () => {
  it("computes proposal planning eligibility without forging implementation readiness", async () => {
    const plan = makePlan();
    const result = await validator.validate(plan, [makeBrief(plan)]);

    expect(result).toEqual({
      completeness: { status: "complete", issues: [] },
      eligibility: {
        planningEligible: true,
        implementationEligible: false,
        reasons: ["source-not-confirmed"],
      },
    });
  });

  it("returns deterministic path-addressable missing and unresolved diagnostics", async () => {
    const plan = makePlan({
      assignments: [
        {
          ...makePlan().assignments[0]!,
          unresolvedDecisions: [
            {
              decisionId:
                "decision_00000000-0000-7000-8000-000000000007" as PlanDecisionId,
              question: "Which database?",
              required: true,
              status: "open",
              resolution: null,
            },
          ],
        },
      ],
    });
    const result = await validator.validate(plan, []);

    expect(result.completeness.status).toBe("incomplete");
    expect(
      result.completeness.issues.map(({ code, relatedIds }) => ({
        code,
        relatedIds,
      })),
    ).toEqual([
      {
        code: "unresolved-required-decision",
        relatedIds: ["decision_00000000-0000-7000-8000-000000000007"],
      },
      { code: "missing-brief", relatedIds: [AGENT_ID] },
    ]);
    expect(result.eligibility.planningEligible).toBe(false);
  });

  it("compares caller-built exact sources independently of property order", () => {
    const plan = makePlan();
    const reordered: ArchitectureSourceRef = {
      graphDigest: plan.source.graphDigest,
      version: plan.source.kind === "proposal" ? plan.source.version : 1,
      proposalId:
        plan.source.kind === "proposal"
          ? plan.source.proposalId
          : ("proposal_00000000-0000-7000-8000-000000000005" as never),
      kind: "proposal",
    };

    expect(computeBriefFreshness(makeBrief(plan), reordered).status).toBe(
      "current",
    );
  });

  it("accepts subagent boundary evidence and shared-resource paths", async () => {
    const fixture = dependencyFixture();
    const result = await fixture.validator.validate(fixture.plan, [
      fixture.primaryBrief,
      fixture.counterpartBrief,
    ]);

    expect(result.completeness.issues).toEqual([]);
    expect(result.completeness.status).toBe("complete");
  });

  it("rejects empty evidence and ports without endpoint-contract linkage", async () => {
    const fixture = dependencyFixture();
    const invalid = makeBrief(fixture.plan, {
      ...fixture.primaryBrief,
      inputs: [
        {
          ...fixture.primaryBrief.inputs[0]!,
          contractId: fixture.otherContractId,
        },
      ],
      dependencies: [
        {
          ...fixture.primaryBrief.dependencies[0]!,
          kind: "coordination",
          relationshipIds: [],
          contractIds: [],
        },
      ],
    });
    const result = await fixture.validator.validate(fixture.plan, [
      invalid,
      fixture.counterpartBrief,
    ]);

    expect(result.completeness.issues.map(({ code }) => code)).toEqual([
      "invalid-dependency",
      "incompatible-contract-direction",
    ]);
  });

  it("accepts producer and consumer evidence through a written and read artifact", async () => {
    const fixture = reportFlowFixture();
    const result = await fixture.validator.validate(fixture.plan, [
      fixture.researchBrief,
      fixture.marketingBrief,
    ]);

    expect(result.completeness.issues).toEqual([]);
    expect(result.completeness.status).toBe("complete");
  });

  it("rejects report-flow evidence with the wrong dependency direction", async () => {
    const fixture = reportFlowFixture();
    const marketingBrief = makeBrief(fixture.plan, {
      ...fixture.marketingBrief,
      dependencies: fixture.marketingBrief.dependencies.map((dependency) => ({
        ...dependency,
        direction: "downstream" as const,
      })),
    });
    const result = await fixture.validator.validate(fixture.plan, [
      fixture.researchBrief,
      marketingBrief,
    ]);

    expect(result.completeness.issues.map(({ code }) => code)).toEqual([
      "invalid-dependency",
    ]);
  });

  it("rejects report-flow ports and dependencies with the wrong contract", async () => {
    const fixture = reportFlowFixture();
    const marketingBrief = makeBrief(fixture.plan, {
      ...fixture.marketingBrief,
      inputs: fixture.marketingBrief.inputs.map((port) => ({
        ...port,
        contractId: fixture.otherContractId,
      })),
      dependencies: fixture.marketingBrief.dependencies.map((dependency) => ({
        ...dependency,
        contractIds: [fixture.otherContractId],
      })),
    });
    const result = await fixture.validator.validate(fixture.plan, [
      fixture.researchBrief,
      marketingBrief,
    ]);

    expect(result.completeness.issues.map(({ code }) => code)).toEqual([
      "invalid-dependency",
      "incompatible-contract-direction",
    ]);
  });
});

function dependencyFixture() {
  const counterpartAgentId =
    "node_00000000-0000-7000-8000-000000000011" as PlanNodeId;
  const primarySubagentId =
    "node_00000000-0000-7000-8000-000000000012" as PlanNodeId;
  const counterpartSubagentId =
    "node_00000000-0000-7000-8000-000000000013" as PlanNodeId;
  const resourceId = "node_00000000-0000-7000-8000-000000000014" as PlanNodeId;
  const inboundId =
    "rel_00000000-0000-7000-8000-000000000011" as PlanRelationshipId;
  const primaryResourceId =
    "rel_00000000-0000-7000-8000-000000000012" as PlanRelationshipId;
  const counterpartResourceId =
    "rel_00000000-0000-7000-8000-000000000013" as PlanRelationshipId;
  const contractId =
    "contract_00000000-0000-7000-8000-000000000011" as PlanContractId;
  const otherContractId =
    "contract_00000000-0000-7000-8000-000000000012" as PlanContractId;
  const dependencyGraph: AgentMapGraph = {
    nodes: [
      graph.nodes[0]!,
      {
        id: counterpartAgentId,
        kind: "agent",
        name: "Counterpart",
        purpose: "Provide data",
        ownerAgentId: null,
        contractRefs: [],
      },
      {
        id: primarySubagentId,
        kind: "subagent",
        name: "Primary worker",
        purpose: "Consume data",
        ownerAgentId: AGENT_ID,
        contractRefs: [contractId],
      },
      {
        id: counterpartSubagentId,
        kind: "subagent",
        name: "Counterpart worker",
        purpose: "Produce data",
        ownerAgentId: counterpartAgentId,
        contractRefs: [contractId],
      },
      {
        id: resourceId,
        kind: "resource",
        name: "Shared queue",
        purpose: "Coordinate work",
        ownerAgentId: null,
        contractRefs: [],
      },
    ],
    relationships: [
      {
        id: inboundId,
        fromNodeId: counterpartSubagentId,
        toNodeId: primarySubagentId,
        kind: "feeds",
        executionMode: "asynchronous",
        contractRef: contractId,
        description: "Provides input",
      },
      {
        id: primaryResourceId,
        fromNodeId: primarySubagentId,
        toNodeId: resourceId,
        kind: "uses",
        executionMode: null,
        contractRef: null,
        description: "Uses shared queue",
      },
      {
        id: counterpartResourceId,
        fromNodeId: counterpartSubagentId,
        toNodeId: resourceId,
        kind: "uses",
        executionMode: null,
        contractRef: null,
        description: "Uses shared queue",
      },
    ],
  };
  const baseAssignment = makePlan().assignments[0]!;
  const plan = makePlan({
    assignments: [
      baseAssignment,
      { ...baseAssignment, plannedAgentId: counterpartAgentId },
    ],
  });
  const primaryBrief = makeBrief(plan, {
    ownedNodeIds: [AGENT_ID, primarySubagentId],
    relevantNodeIds: [
      AGENT_ID,
      primarySubagentId,
      counterpartAgentId,
      counterpartSubagentId,
      resourceId,
    ],
    inputs: [
      {
        contractId,
        nodeId: primarySubagentId,
        relationshipIds: [inboundId],
        description: "Counterpart input",
      },
    ],
    dependencies: [
      {
        dependencyId:
          "dependency_00000000-0000-7000-8000-000000000011" as BriefDependencyId,
        kind: "consumes-output",
        direction: "upstream",
        counterpartAgentId,
        relationshipIds: [inboundId],
        contractIds: [contractId],
        requiredByMilestoneIds: [],
        blocking: true,
        description: "Consumes counterpart data",
      },
      {
        dependencyId:
          "dependency_00000000-0000-7000-8000-000000000012" as BriefDependencyId,
        kind: "shared-resource",
        direction: "bidirectional",
        counterpartAgentId,
        relationshipIds: [primaryResourceId, counterpartResourceId],
        contractIds: [],
        requiredByMilestoneIds: [],
        blocking: false,
        description: "Shares a queue",
      },
    ],
  });
  const counterpartBrief = makeBrief(plan, {
    briefId: "brief_00000000-0000-7000-8000-000000000011" as AgentBriefId,
    assignmentId:
      "assignment_00000000-0000-7000-8000-000000000011" as PlanningAssignmentId,
    plannedAgentId: counterpartAgentId,
    ownedNodeIds: [counterpartAgentId, counterpartSubagentId],
    relevantNodeIds: [counterpartAgentId, counterpartSubagentId],
  });
  return {
    validator: new BuildPlanContractValidator({
      resolve: async (_projectId, source) => ({
        projectId: PROJECT_ID,
        source,
        graph: dependencyGraph,
      }),
    }),
    plan,
    primaryBrief,
    counterpartBrief,
    otherContractId,
  };
}

function reportFlowFixture() {
  const marketingAgentId =
    "node_00000000-0000-7000-8000-000000000021" as PlanNodeId;
  const reportArtifactId =
    "node_00000000-0000-7000-8000-000000000022" as PlanNodeId;
  const writeRelationshipId =
    "rel_00000000-0000-7000-8000-000000000021" as PlanRelationshipId;
  const readRelationshipId =
    "rel_00000000-0000-7000-8000-000000000022" as PlanRelationshipId;
  const contractId =
    "contract_00000000-0000-7000-8000-000000000021" as PlanContractId;
  const otherContractId =
    "contract_00000000-0000-7000-8000-000000000022" as PlanContractId;
  const reportGraph: AgentMapGraph = {
    nodes: [
      { ...graph.nodes[0]!, name: "Research", purpose: "Research the market" },
      {
        id: marketingAgentId,
        kind: "agent",
        name: "Marketing",
        purpose: "Use research in campaigns",
        ownerAgentId: null,
        contractRefs: [contractId],
      },
      {
        id: reportArtifactId,
        kind: "artifact",
        name: "ResearchReport",
        purpose: "Carry research findings",
        ownerAgentId: null,
        contractRefs: [contractId],
      },
    ],
    relationships: [
      {
        id: writeRelationshipId,
        fromNodeId: AGENT_ID,
        toNodeId: reportArtifactId,
        kind: "writes",
        executionMode: "asynchronous",
        contractRef: contractId,
        description: "Research produces the report",
      },
      {
        id: readRelationshipId,
        fromNodeId: marketingAgentId,
        toNodeId: reportArtifactId,
        kind: "reads",
        executionMode: "asynchronous",
        contractRef: contractId,
        description: "Marketing consumes the report",
      },
    ],
  };
  const baseAssignment = makePlan().assignments[0]!;
  const plan = makePlan({
    assignments: [
      baseAssignment,
      { ...baseAssignment, plannedAgentId: marketingAgentId },
    ],
  });
  const researchBrief = makeBrief(plan, {
    ownedNodeIds: [AGENT_ID],
    relevantNodeIds: [AGENT_ID, marketingAgentId, reportArtifactId],
    outputs: [
      {
        contractId,
        nodeId: AGENT_ID,
        relationshipIds: [writeRelationshipId],
        description: "Published research report",
      },
    ],
    dependencies: [
      {
        dependencyId:
          "dependency_00000000-0000-7000-8000-000000000021" as BriefDependencyId,
        kind: "provides-input",
        direction: "downstream",
        counterpartAgentId: marketingAgentId,
        relationshipIds: [writeRelationshipId, readRelationshipId],
        contractIds: [contractId],
        requiredByMilestoneIds: [],
        blocking: false,
        description: "Provides the report to Marketing",
      },
    ],
  });
  const marketingBrief = makeBrief(plan, {
    briefId: "brief_00000000-0000-7000-8000-000000000021" as AgentBriefId,
    assignmentId:
      "assignment_00000000-0000-7000-8000-000000000021" as PlanningAssignmentId,
    plannedAgentId: marketingAgentId,
    ownedNodeIds: [marketingAgentId],
    relevantNodeIds: [AGENT_ID, marketingAgentId, reportArtifactId],
    inputs: [
      {
        contractId,
        nodeId: marketingAgentId,
        relationshipIds: [readRelationshipId],
        description: "Research report input",
      },
    ],
    dependencies: [
      {
        dependencyId:
          "dependency_00000000-0000-7000-8000-000000000022" as BriefDependencyId,
        kind: "consumes-output",
        direction: "upstream",
        counterpartAgentId: AGENT_ID,
        relationshipIds: [writeRelationshipId, readRelationshipId],
        contractIds: [contractId],
        requiredByMilestoneIds: [],
        blocking: true,
        description: "Consumes Research's report",
      },
    ],
  });
  return {
    validator: new BuildPlanContractValidator({
      resolve: async (_projectId, source) => ({
        projectId: PROJECT_ID,
        source,
        graph: reportGraph,
      }),
    }),
    plan,
    researchBrief,
    marketingBrief,
    otherContractId,
  };
}
