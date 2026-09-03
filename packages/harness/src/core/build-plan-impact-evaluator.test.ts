import { describe, expect, it } from "vitest";

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
