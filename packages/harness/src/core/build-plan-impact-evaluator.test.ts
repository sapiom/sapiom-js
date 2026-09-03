import { describe, expect, it } from "vitest";

import {
  BUILD_PLAN_IMPACT_ASSIGNMENT_LIMIT,
  BUILD_PLAN_IMPACT_REASON_ID_LIMIT,
  BUILD_PLAN_MAX_IMPACT_BYTES,
  BUILD_PLAN_MAX_RESULT_BYTES,
  type AgentBriefVersionRecord,
  type DependencyFingerprintKind,
  type MilestoneId,
} from "../shared/build-plan.js";
import { compileAgentBriefs } from "./agent-brief-compiler.js";
import {
  ANALYST_ID,
  MARKETING_ID,
  RESEARCH_ID,
  STOCK_PROJECT_ID,
  reviseStockPlan,
  stockAssignments,
  stockResearchGraph,
  stockResearchPlan,
} from "./agent-brief-compiler.test-support.js";
import { canonicalJson } from "./build-plan-canonicalization.js";
import { evaluateBuildPlanImpact } from "./build-plan-impact-evaluator.js";

const initial = () => {
  const graph = stockResearchGraph();
  const plan = stockResearchPlan(graph);
  const result = compileAgentBriefs({
    projectId: STOCK_PROJECT_ID,
    source: plan.source,
    graph,
    plan,
    assignments: stockAssignments(),
  });
  return { graph, plan, result };
};

describe("canonical build plan impact evaluator", () => {
  it("stales both provider and consumer for a shared contract change", () => {
    const previous = initial();
    const graph = structuredClone(previous.graph);
    graph.relationships = graph.relationships.map((entry) =>
      entry.contractRef
        ? { ...entry, description: `${entry.description} with schema v2` }
        : entry,
    );
    const plan = reviseStockPlan(previous.plan, graph);
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(result.impact.assignmentChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plannedAgentId: RESEARCH_ID,
          disposition: "stale",
        }),
        expect.objectContaining({
          plannedAgentId: MARKETING_ID,
          disposition: "stale",
        }),
      ]),
    );
    expect(result.impact.changedContractIds).toContain(
      "contract-research-report",
    );
  });

  it("stales only the owner for an internal subagent implementation change", () => {
    const previous = initial();
    const graph = structuredClone(previous.graph);
    graph.nodes.find((entry) => entry.id === ANALYST_ID)!.purpose =
      "Analyze fundamentals and valuation scenarios";
    const plan = reviseStockPlan(previous.plan, graph);
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(
      result.impact.assignmentChanges.find(
        (entry) => entry.plannedAgentId === RESEARCH_ID,
      )?.disposition,
    ).toBe("stale");
    expect(
      result.impact.assignmentChanges.find(
        (entry) => entry.plannedAgentId === MARKETING_ID,
      )?.disposition,
    ).toBe("preserved");
  });

  it("refreshes presentation without semantic staleness for a label-only rename", () => {
    const previous = initial();
    const graph = structuredClone(previous.graph);
    graph.nodes.find((entry) => entry.id === ANALYST_ID)!.name =
      "Senior equity analyst";
    const plan = reviseStockPlan(previous.plan, graph);
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(result.impact.semanticChange).toBe(false);
    expect(
      result.impact.assignmentChanges.find(
        (entry) => entry.plannedAgentId === RESEARCH_ID,
      )?.disposition,
    ).toBe("presentation-refreshed");
    expect(
      result.briefs.every((entry) => entry.disposition === "source-rebound"),
    ).toBe(true);
  });

  it("targets assignment-authored changes and preserves unaffected identities", () => {
    const previous = initial();
    const plan = reviseStockPlan(previous.plan, previous.graph, {
      source: previous.plan.source,
      assignments: previous.plan.assignments.map((entry) =>
        entry.plannedAgentId === MARKETING_ID
          ? { ...entry, mission: "Publish an approved investor campaign" }
          : entry,
      ),
    });
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph: previous.graph,
      plan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(
      result.briefs.find((entry) => entry.plannedAgentId === RESEARCH_ID)
        ?.disposition,
    ).toBe("unchanged");
    expect(
      result.briefs.find((entry) => entry.plannedAgentId === MARKETING_ID)
        ?.disposition,
    ).toBe("new-version");

    const globalPlan = reviseStockPlan(previous.plan, previous.graph, {
      source: previous.plan.source,
      sharedConstraints: [
        ...previous.plan.sharedConstraints,
        {
          constraintId: "global-security",
          description: "Apply project-global security review",
          required: true,
        },
      ],
    });
    const global = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: globalPlan.source,
      graph: previous.graph,
      plan: globalPlan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(
      global.impact.assignmentChanges.every(
        (entry) => entry.disposition === "stale",
      ),
    ).toBe(true);
  });

  it("fingerprints the same transitive milestone closure projected to bootstrap", () => {
    const graph = stockResearchGraph();
    const prerequisiteId =
      "milestone_10000000-0000-7000-8000-000000000010" as MilestoneId;
    const deliveryId =
      "milestone_10000000-0000-7000-8000-000000000011" as MilestoneId;
    const base = stockResearchPlan(graph);
    const plan = stockResearchPlan(graph, {
      milestones: [
        {
          milestoneId: prerequisiteId,
          ordinal: 1,
          title: "Evidence ready",
          outcome: "Evidence is collected",
          dependsOn: [],
        },
        {
          milestoneId: deliveryId,
          ordinal: 2,
          title: "Research delivered",
          outcome: "Research is ready",
          dependsOn: [prerequisiteId],
        },
      ],
      assignments: base.assignments.map((assignment) => ({
        ...assignment,
        milestoneIds:
          assignment.plannedAgentId === RESEARCH_ID ? [deliveryId] : [],
      })),
    });
    const previous = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
    });
    const changedPlan = reviseStockPlan(plan, graph, {
      source: plan.source,
      milestones: plan.milestones.map((milestone) =>
        milestone.milestoneId === prerequisiteId
          ? { ...milestone, outcome: "Evidence is collected and reviewed" }
          : milestone,
      ),
    });
    const changed = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: changedPlan.source,
      graph,
      plan: changedPlan,
      assignments: stockAssignments(),
      previous: {
        plan,
        graph,
        briefs: previous.briefs.map((candidate) => candidate.brief),
      },
    });
    const beforeResearch = previous.briefs.find(
      (candidate) => candidate.plannedAgentId === RESEARCH_ID,
    )!;
    const afterResearch = changed.briefs.find(
      (candidate) => candidate.plannedAgentId === RESEARCH_ID,
    )!;

    expect(
      beforeResearch.bootstrap.project.relevantMilestones.map(
        (milestone) => milestone.milestoneId,
      ),
    ).toEqual([prerequisiteId, deliveryId]);
    expect(afterResearch.disposition).toBe("new-version");
    expect(afterResearch.bootstrap.contextDigest).not.toBe(
      beforeResearch.bootstrap.contextDigest,
    );
    expect(
      changed.impact.assignmentChanges.find(
        (impact) => impact.plannedAgentId === RESEARCH_ID,
      ),
    ).toMatchObject({ disposition: "stale" });
    expect(
      changed.briefs.find(
        (candidate) => candidate.plannedAgentId === MARKETING_ID,
      )?.disposition,
    ).toBe("unchanged");
  });

  it("uses the full graph change set before bounding emitted change evidence", () => {
    const base = initial();
    const researchNode = base.graph.nodes.find(
      (node) => node.id === RESEARCH_ID,
    )!;
    const subagents = Array.from({ length: 130 }, (_, index) => ({
      id: `node_90000000-0000-7000-8000-${index
        .toString(16)
        .padStart(12, "0")}` as typeof RESEARCH_ID,
      kind: "subagent" as const,
      name: `Worker ${index}`,
      purpose: "Before",
      ownerAgentId: RESEARCH_ID,
      contractRefs: [],
    }));
    const targetId = subagents.at(-1)!.id;
    const previousGraph = {
      nodes: [researchNode, ...subagents],
      relationships: [],
    };
    const nextGraph = {
      ...previousGraph,
      nodes: previousGraph.nodes.map((node) =>
        node.kind === "subagent" ? { ...node, purpose: "After" } : node,
      ),
    };
    const brief = base.result.briefs.find(
      (candidate) => candidate.plannedAgentId === RESEARCH_ID,
    )!.brief as AgentBriefVersionRecord;
    const previousBrief = {
      ...brief,
      ownedNodeIds: [RESEARCH_ID, targetId],
      relevantNodeIds: [RESEARCH_ID, targetId],
      dependencyFingerprints: [
        {
          kind: "owned-nodes" as const,
          digest: `sha256:${"a".repeat(64)}`,
          nodeIds: [targetId],
          relationshipIds: [],
          contractIds: [],
        },
      ],
    };
    const nextBrief = {
      ...previousBrief,
      dependencyFingerprints: previousBrief.dependencyFingerprints.map(
        (fingerprint) => ({
          ...fingerprint,
          digest: `sha256:${"b".repeat(64)}`,
        }),
      ),
    };
    const impact = evaluateBuildPlanImpact({
      previousSource: base.plan.source,
      nextSource: base.plan.source,
      briefs: [previousBrief],
      previousPlan: base.plan,
      nextPlan: base.plan,
      previousGraph,
      nextGraph,
      nextBriefs: [nextBrief],
    });

    expect(impact.changedNodeIds).toHaveLength(128);
    expect(impact.changedNodeIds).not.toContain(targetId);
    expect(impact.assignmentChanges[0]).toMatchObject({
      disposition: "stale",
      reasons: [
        {
          code: "ownership-changed",
          affectedNodeIds: [targetId],
        },
      ],
    });
  });

  it("projects schema-bound repeated evidence into a receipt-safe canonical impact", () => {
    const base = initial();
    const baseBrief = base.result.briefs.find(
      (candidate) => candidate.plannedAgentId === RESEARCH_ID,
    )!.brief as AgentBriefVersionRecord;
    const suffix = (index: number) => index.toString(16).padStart(12, "0");
    const nodeIds = Array.from(
      { length: BUILD_PLAN_IMPACT_ASSIGNMENT_LIMIT },
      (_, index) =>
        `node_20000000-0000-7000-8000-${suffix(index)}` as typeof RESEARCH_ID,
    );
    const relationshipIds = nodeIds.map(
      (_, index) => `rel_50000000-0000-7000-8000-${suffix(index)}` as never,
    );
    const contractIds = nodeIds.map((_, index) =>
      `contract-${suffix(index)}${"x".repeat(491)}`.slice(0, 512),
    );
    const previousGraph = {
      nodes: nodeIds.map((id, index) => ({
        id,
        kind: "agent" as const,
        name: `Agent ${index}`,
        purpose: "Before",
        ownerAgentId: null,
        contractRefs: [contractIds[index]!],
      })),
      relationships: relationshipIds.map((id, index) => ({
        id,
        fromNodeId: nodeIds[index]!,
        toNodeId: nodeIds[(index + 1) % nodeIds.length]!,
        kind: "triggers" as const,
        executionMode: "asynchronous" as const,
        contractRef: contractIds[index]!,
        description: "Before",
      })),
    };
    const nextGraph = {
      ...previousGraph,
      nodes: previousGraph.nodes.map((node) => ({
        ...node,
        purpose: "After",
      })),
      relationships: previousGraph.relationships.map((relationship) => ({
        ...relationship,
        description: "After",
      })),
    };
    const fingerprintKinds: DependencyFingerprintKind[] = [
      "owned-nodes",
      "relevant-nodes",
      "input-contracts",
      "output-contracts",
      "cross-agent-relationships",
      "shared-resources",
      "milestones",
      "shared-plan-content",
      "assignment-content",
    ];
    const briefs = nodeIds.map(
      (plannedAgentId, index): AgentBriefVersionRecord => ({
        ...baseBrief,
        plannedAgentId,
        briefId:
          `brief_30000000-0000-7000-8000-${suffix(index)}` as typeof baseBrief.briefId,
        assignmentId:
          `assignment_40000000-0000-7000-8000-${suffix(index)}` as typeof baseBrief.assignmentId,
        ownedNodeIds: [plannedAgentId],
        relevantNodeIds: [plannedAgentId],
        dependencyFingerprints: fingerprintKinds.map((kind) => ({
          kind,
          digest: `sha256:${"a".repeat(64)}`,
          nodeIds: nodeIds.slice(0, BUILD_PLAN_IMPACT_REASON_ID_LIMIT),
          relationshipIds: relationshipIds.slice(
            0,
            BUILD_PLAN_IMPACT_REASON_ID_LIMIT,
          ),
          contractIds: contractIds.slice(
            0,
            BUILD_PLAN_IMPACT_REASON_ID_LIMIT,
          ) as never,
        })),
      }),
    );
    const nextBriefs: AgentBriefVersionRecord[] = briefs.map((brief) => ({
      ...brief,
      dependencyFingerprints: brief.dependencyFingerprints.map(
        (fingerprint) => ({
          ...fingerprint,
          digest: `sha256:${"b".repeat(64)}`,
        }),
      ),
    }));
    const impact = evaluateBuildPlanImpact({
      previousSource: base.plan.source,
      nextSource: base.plan.source,
      briefs,
      previousPlan: base.plan,
      nextPlan: base.plan,
      previousGraph,
      nextGraph,
      nextBriefs,
    });
    const diagnostics = Array.from({ length: 64 }, (_, index) => ({
      code: "brief-non-goals-suspicious" as const,
      severity: "warning" as const,
      path: `plan.assignments[${index}].scope.nonGoals`,
      message: "The assignment has no explicit non-goals",
      relatedIds: [nodeIds[index]!],
    }));
    const receipt = {
      operation: "rebase",
      briefChanges: impact.assignmentChanges.slice(0, 128).map((entry) => ({
        plannedAgentId: entry.plannedAgentId,
        change: "staled",
      })),
      idMappings: Array.from({ length: 128 }, (_, index) => ({
        kind: "criterion",
        clientRef: `client-${suffix(index)}${"c".repeat(493)}`.slice(0, 512),
        id: `id-${suffix(index)}${"i".repeat(497)}`.slice(0, 512),
      })),
      completeness: { status: "complete", issues: diagnostics },
      eligibility: {
        planningEligible: true,
        implementationEligible: false,
        reasons: ["source-not-confirmed"],
      },
      diagnostics,
      impact,
    };

    expect(impact.assignmentChanges).toHaveLength(
      BUILD_PLAN_IMPACT_ASSIGNMENT_LIMIT,
    );
    expect(
      impact.assignmentChanges.every(
        (entry) =>
          entry.reasons.length === fingerprintKinds.length &&
          entry.reasons.every(
            (reason) =>
              reason.affectedNodeIds.length <=
                BUILD_PLAN_IMPACT_REASON_ID_LIMIT &&
              reason.affectedRelationshipIds.length <=
                BUILD_PLAN_IMPACT_REASON_ID_LIMIT &&
              reason.affectedContractIds.length <=
                BUILD_PLAN_IMPACT_REASON_ID_LIMIT,
          ),
      ),
    ).toBe(true);
    expect(
      new Set(
        impact.assignmentChanges.flatMap((entry) =>
          entry.reasons.map((reason) => reason.code),
        ),
      ),
    ).toEqual(
      new Set([
        "ownership-changed",
        "relevant-node-changed",
        "contract-changed",
        "relationship-changed",
        "shared-plan-content-changed",
        "assignment-content-changed",
      ]),
    );
    expect(
      Buffer.byteLength(canonicalJson(impact), "utf8"),
    ).toBeLessThanOrEqual(BUILD_PLAN_MAX_IMPACT_BYTES);
    expect(Buffer.byteLength(canonicalJson(receipt), "utf8")).toBeLessThan(
      BUILD_PLAN_MAX_RESULT_BYTES,
    );
  });

  it("handles top-level add/remove while preserving unaffected brief identities", () => {
    const previous = initial();
    const addedId =
      "node_10000000-0000-7000-8000-000000000007" as typeof RESEARCH_ID;
    const addedGraph = structuredClone(previous.graph);
    addedGraph.nodes.push({
      id: addedId,
      kind: "agent",
      name: "Compliance",
      purpose: "Review publication compliance",
      ownerAgentId: null,
      contractRefs: [],
    });
    const addedPlan = reviseStockPlan(previous.plan, addedGraph, {
      assignments: [
        ...previous.plan.assignments,
        {
          plannedAgentId: addedId,
          mission: "Review campaign compliance",
          scope: { inScope: ["Compliance review"], nonGoals: ["Research"] },
          deliverables: [
            {
              deliverableId:
                "deliverable_10000000-0000-7000-8000-000000000004" as never,
              description: "Compliance decision",
              artifactNodeIds: [],
              acceptanceCriterionIds: [
                "criterion_10000000-0000-7000-8000-000000000004" as never,
              ],
            },
          ],
          constraints: [],
          acceptanceCriteria: [
            {
              criterionId:
                "criterion_10000000-0000-7000-8000-000000000004" as never,
              ordinal: 1,
              description: "Campaign is reviewed",
              verification: "Record the decision",
            },
          ],
          milestoneIds: [],
          unresolvedDecisions: [],
        },
      ],
    });
    const added = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: addedPlan.source,
      graph: addedGraph,
      plan: addedPlan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(added.impact.addedAgentIds).toEqual([addedId]);
    expect(
      added.impact.assignmentChanges
        .filter((entry) =>
          [RESEARCH_ID, MARKETING_ID].includes(entry.plannedAgentId),
        )
        .every((entry) => entry.disposition === "preserved"),
    ).toBe(true);

    const removedGraph = structuredClone(previous.graph);
    removedGraph.nodes = removedGraph.nodes.filter(
      (entry) => entry.id !== MARKETING_ID,
    );
    removedGraph.relationships = removedGraph.relationships.filter(
      (entry) =>
        entry.fromNodeId !== MARKETING_ID && entry.toNodeId !== MARKETING_ID,
    );
    const removedPlan = reviseStockPlan(previous.plan, removedGraph, {
      assignments: previous.plan.assignments.filter(
        (entry) => entry.plannedAgentId !== MARKETING_ID,
      ),
    });
    const removed = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: removedPlan.source,
      graph: removedGraph,
      plan: removedPlan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(removed.impact.removedAgentIds).toEqual([MARKETING_ID]);
    expect(
      removed.briefs.find((entry) => entry.plannedAgentId === MARKETING_ID)
        ?.disposition,
    ).toBe("retired");
  });

  it("stales old and new owners for an ownership transfer", () => {
    const previous = initial();
    const graph = structuredClone(previous.graph);
    graph.nodes.find((entry) => entry.id === ANALYST_ID)!.ownerAgentId =
      MARKETING_ID;
    const plan = reviseStockPlan(previous.plan, graph);
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
      previous: {
        plan: previous.plan,
        graph: previous.graph,
        briefs: previous.result.briefs.map((entry) => entry.brief),
      },
    });
    expect(
      result.impact.assignmentChanges
        .filter((entry) => entry.disposition === "stale")
        .map((entry) => entry.plannedAgentId),
    ).toEqual([RESEARCH_ID, MARKETING_ID].sort());
  });
});
