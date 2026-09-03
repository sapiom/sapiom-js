import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { PlanNodeId } from "../shared/agent-map.js";
import {
  AgentBriefCompilationError,
  compileAgentBriefs,
  AGENT_BRIEF_COMPILER_VERSION,
} from "./agent-brief-compiler.js";
import {
  ANALYST_ID,
  CHANNEL_ID,
  DATA_ID,
  MARKETING_ID,
  REPORT_CONTRACT,
  REPORT_ID,
  RESEARCH_ID,
  STOCK_PROJECT_ID,
  stockAssignments,
  stockResearchGraph,
  stockResearchPlan,
  stockResearchRelayFixture,
  reviseStockPlan,
} from "./agent-brief-compiler.test-support.js";
import {
  canonicalJson,
  computeArchitectureGraphDigest,
} from "./build-plan-canonicalization.js";
import {
  graph as simpleGraph,
  makeLegacyBrief,
  makePlan,
  PROJECT_ID,
} from "./build-plan.test-support.js";

const compileStock = () => {
  const graph = stockResearchGraph();
  const plan = stockResearchPlan(graph);
  return compileAgentBriefs({
    projectId: STOCK_PROJECT_ID,
    source: plan.source,
    graph,
    plan,
    assignments: stockAssignments(),
  });
};

describe("agent brief compiler", () => {
  it("matches the complete canonical stock-research compilation golden", async () => {
    const actual = canonicalJson(compileStock());
    const golden = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/stock-research-compile.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(actual).toBe(canonicalJson(golden));
  });

  it("produces distinct focused Research and Marketing briefs with one typed boundary", () => {
    const result = compileStock();
    expect(result.diagnostics).toEqual([]);
    expect(result.completeness.status).toBe("complete");
    expect(result.briefs.map((entry) => entry.plannedAgentId)).toEqual(
      [RESEARCH_ID, MARKETING_ID].sort(),
    );
    const research = result.briefs.find(
      (entry) => entry.plannedAgentId === RESEARCH_ID,
    )!;
    const marketing = result.briefs.find(
      (entry) => entry.plannedAgentId === MARKETING_ID,
    )!;
    if (research.brief.schemaVersion !== 2)
      throw new Error("expected v2 brief");
    expect(research.brief.ownedNodeIds).toEqual(
      [RESEARCH_ID, ANALYST_ID].sort(),
    );
    expect(research.brief.outputs).toEqual([
      expect.objectContaining({
        contractId: REPORT_CONTRACT,
        nodeId: ANALYST_ID,
      }),
    ]);
    expect(marketing.brief.inputs).toEqual([
      expect.objectContaining({
        contractId: REPORT_CONTRACT,
        nodeId: MARKETING_ID,
      }),
    ]);
    expect(research.brief.outputs[0]?.relationshipIds).toEqual([
      "rel_10000000-0000-7000-8000-000000000001",
    ]);
    expect(marketing.brief.inputs[0]?.relationshipIds).toEqual([
      "rel_10000000-0000-7000-8000-000000000002",
    ]);
    expect(research.brief.dependencies).toContainEqual(
      expect.objectContaining({
        kind: "provides-input",
        counterpartAgentId: MARKETING_ID,
        contractIds: [REPORT_CONTRACT],
      }),
    );
    expect(marketing.brief.dependencies).toContainEqual(
      expect.objectContaining({
        kind: "consumes-output",
        counterpartAgentId: RESEARCH_ID,
        contractIds: [REPORT_CONTRACT],
      }),
    );
    expect(research.brief.relevantNodeIds).toContain(REPORT_ID);
    expect(research.brief.relevantNodeIds).toContain(DATA_ID);
    expect(marketing.brief.relevantNodeIds).toEqual(
      expect.arrayContaining([REPORT_ID, DATA_ID, CHANNEL_ID]),
    );
    expect(research.brief.outputs[0]?.executionModes).toEqual(["asynchronous"]);
    expect(research.brief.dependencies).toContainEqual(
      expect.objectContaining({ kind: "shared-resource" }),
    );
    expect(research.brief.compilerVersion).toBe(AGENT_BRIEF_COMPILER_VERSION);
    expect(
      research.brief.dependencyFingerprints.map((entry) => entry.kind),
    ).toEqual([
      "owned-nodes",
      "relevant-nodes",
      "input-contracts",
      "output-contracts",
      "cross-agent-relationships",
      "shared-resources",
      "milestones",
      "shared-plan-content",
      "assignment-content",
    ]);
    expect({
      briefSemanticDigests: result.briefs.map(
        (entry) => entry.brief.semanticDigest,
      ),
      briefRecordDigests: result.briefs.map(
        (entry) => entry.brief.recordDigest,
      ),
      bootstrapDigests: result.briefs.map(
        (entry) => entry.bootstrap.contextDigest,
      ),
      impactDigest: result.impact.digest,
    }).toEqual({
      briefSemanticDigests: [
        "sha256:7a542ea3bc010f2613c387b8cd673550d9cb6ca7293f82ecf2b4d7ffd8a29541",
        "sha256:72251a62f1ce57781c6127566c7d54faa56f25337b2ba236f80b70ae2ec97376",
      ],
      briefRecordDigests: [
        "sha256:34d1b8b6c72ed32fc7a86e2a755fde1b7b1a9b71b4ca59ce643e97cc0c8bbb0c",
        "sha256:ea64d0d26ee91295f36ec9bad2cc22724c808ba0f9db5edc8c164038d9f44736",
      ],
      bootstrapDigests: [
        "sha256:d054723372496ce99a594bafe250dd2daef1484ccbf289045068554e99b16afc",
        "sha256:8d11e411bda6ad1e0b38c753af9dc352a8988d7714fbb6b9457a234df7956bc8",
      ],
      impactDigest:
        "sha256:e9c8e3b27102a5fb8f2b194bd6c4482d2f670949f0b40325eb39a022fc4795ab",
    });
  });

  it("is byte and digest deterministic across input ordering", () => {
    const first = compileStock();
    const graph = stockResearchGraph();
    graph.nodes.reverse();
    graph.relationships.reverse();
    const plan = stockResearchPlan(graph, {
      assignments: [...stockResearchPlan(graph).assignments].reverse(),
    });
    const second = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments().reverse(),
    });
    expect(second.briefs.map((entry) => entry.brief.semanticDigest)).toEqual(
      first.briefs.map((entry) => entry.brief.semanticDigest),
    );
    expect(canonicalJson(second.briefs)).toBe(canonicalJson(first.briefs));
  });

  it("reports malformed ownership, missing assignments, and ambiguous contracts", () => {
    const graph = stockResearchGraph();
    graph.nodes.find((entry) => entry.id === ANALYST_ID)!.ownerAgentId =
      "node_10000000-0000-7000-8000-000000000099" as PlanNodeId;
    graph.relationships[0] = {
      ...graph.relationships[0]!,
      kind: "uses",
    };
    const plan = stockResearchPlan(graph, {
      assignments: stockResearchPlan(graph).assignments.filter(
        (entry) => entry.plannedAgentId !== MARKETING_ID,
      ),
    });
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
    });
    expect(result.completeness.status).toBe("incomplete");
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "dangling-ownership",
        "missing-agent-assignment",
        "ambiguous-contract-direction",
      ]),
    );
    expect(result.diagnostics.every((entry) => entry.path.length > 0)).toBe(
      true,
    );
  });

  it("rejects disconnected carriers that merely share a contract reference", () => {
    const graph = stockResearchGraph();
    const disconnectedReportId =
      "node_10000000-0000-7000-8000-000000000008" as PlanNodeId;
    graph.nodes.push({
      id: disconnectedReportId,
      kind: "artifact",
      name: "DisconnectedResearchReport",
      purpose: "A different artifact with the same contract label",
      ownerAgentId: null,
      contractRefs: [REPORT_CONTRACT],
    });
    graph.relationships[1] = {
      ...graph.relationships[1]!,
      toNodeId: disconnectedReportId,
    };
    const plan = stockResearchPlan(graph);
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
    });

    expect(result.completeness.status).toBe("incomplete");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "incompatible-contract-direction",
        path: "graph.relationships.contractRef",
        relatedIds: expect.arrayContaining([
          REPORT_CONTRACT,
          RESEARCH_ID,
          MARKETING_ID,
        ]),
      }),
    );
    expect(
      result.briefs.flatMap((candidate) => candidate.brief.dependencies),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractIds: [REPORT_CONTRACT] }),
      ]),
    );
  });

  it("accepts a connected typed contract path through a third agent relay", () => {
    const { graph, plan, assignments } = stockResearchRelayFixture();
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.completeness.status).toBe("complete");
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "incompatible-contract-direction" }),
      ]),
    );
    expect(
      result.briefs.find(
        (candidate) => candidate.plannedAgentId === RESEARCH_ID,
      )!.brief.dependencies,
    ).toContainEqual(
      expect.objectContaining({
        kind: "provides-input",
        counterpartAgentId: MARKETING_ID,
        contractIds: [REPORT_CONTRACT],
        relationshipIds: [
          "rel_10000000-0000-7000-8000-000000000001",
          "rel_10000000-0000-7000-8000-000000000002",
        ],
      }),
    );
  });

  it("does not treat an owned non-agent endpoint as a contract actor", () => {
    const graph = stockResearchGraph();
    graph.nodes.find((node) => node.id === REPORT_ID)!.ownerAgentId =
      RESEARCH_ID;
    graph.relationships = graph.relationships.filter(
      (relationship) => relationship.fromNodeId !== ANALYST_ID,
    );
    const plan = stockResearchPlan(graph);
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
    });

    expect(result.completeness.status).toBe("incomplete");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "incompatible-contract-direction",
        path: "graph.relationships.contractRef",
        relatedIds: expect.arrayContaining([
          REPORT_CONTRACT,
          RESEARCH_ID,
          MARKETING_ID,
        ]),
      }),
    );
    expect(
      result.briefs.flatMap((candidate) => candidate.brief.dependencies),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractIds: [REPORT_CONTRACT] }),
      ]),
    );
  });

  it("returns a discriminable compiler error for legacy records on the public boundary", () => {
    const previousPlan = makePlan();
    const graph = { nodes: [], relationships: [] };
    const plan = makePlan({
      version: 2 as never,
      parentVersion: previousPlan.version,
      changeKind: "edited",
      source: {
        ...previousPlan.source,
        version:
          previousPlan.source.kind === "proposal"
            ? previousPlan.source.version + 1
            : undefined,
        graphDigest: computeArchitectureGraphDigest(graph),
      } as never,
      assignments: [],
    });
    let failure: unknown;

    try {
      compileAgentBriefs({
        projectId: PROJECT_ID,
        source: plan.source,
        graph,
        plan,
        assignments: [],
        previous: {
          plan: previousPlan,
          graph: simpleGraph,
          briefs: [makeLegacyBrief(previousPlan)] as never,
          allowedPlanRefs: [
            {
              planId: previousPlan.planId,
              version: previousPlan.version,
              semanticDigest: previousPlan.semanticDigest,
            },
          ],
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentBriefCompilationError);
    expect(failure).toMatchObject({
      code: "legacy-brief-result",
      diagnostics: [],
    });
  });

  it("does not create independent briefs for subagents, resources, connectors, or artifacts", () => {
    const result = compileStock();
    expect(result.briefs).toHaveLength(2);
    expect(
      result.briefs.some((entry) => entry.plannedAgentId === ANALYST_ID),
    ).toBe(false);
    expect(
      result.briefs.some((entry) => entry.plannedAgentId === REPORT_ID),
    ).toBe(false);
  });

  it("independently rejects tampered current and previous records", () => {
    const graph = stockResearchGraph();
    const plan = stockResearchPlan(graph);
    const current = compileStock();
    const tampered = structuredClone(
      current.briefs.map((entry) => entry.brief),
    );
    tampered[0]!.mission = "tampered without resealing";
    const result = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan: { ...plan, recordDigest: `sha256:${"f".repeat(64)}` as never },
      assignments: stockAssignments(),
      previous: { plan, graph, briefs: tampered },
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source-digest-mismatch",
          path: "plan.recordDigest",
        }),
        expect.objectContaining({
          code: "source-digest-mismatch",
          path: "previous.briefs[0]",
        }),
      ]),
    );
  });

  it("preserves exact identity/version on unchanged input and source-rebinds identical semantics", () => {
    const graph = stockResearchGraph();
    const plan = stockResearchPlan(graph);
    const first = compileStock();
    const unchanged = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: stockAssignments(),
      previous: {
        plan,
        graph,
        briefs: first.briefs.map((entry) => entry.brief),
      },
    });
    expect(
      unchanged.briefs.every((entry) => entry.disposition === "unchanged"),
    ).toBe(true);
    expect(unchanged.briefs.map((entry) => entry.brief)).toEqual(
      first.briefs.map((entry) => entry.brief),
    );

    const reboundPlan = stockResearchPlan(graph, {
      version: 2 as never,
      parentVersion: 1 as never,
      changeKind: "source-rebound",
      source: {
        kind: "revision",
        revisionId: "revision_10000000-0000-7000-8000-000000000001" as never,
        revisionNumber: 1,
        graphDigest: plan.source.graphDigest,
      },
    });
    const rebound = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: reboundPlan.source,
      graph,
      plan: reboundPlan,
      assignments: stockAssignments(),
      previous: {
        plan,
        graph,
        briefs: first.briefs.map((entry) => entry.brief),
      },
    });
    expect(
      rebound.briefs.every((entry) => entry.disposition === "source-rebound"),
    ).toBe(true);
    rebound.briefs.forEach((entry, index) => {
      expect(entry.brief.semanticDigest).toBe(
        first.briefs[index]!.brief.semanticDigest,
      );
      expect(entry.brief.version).toBe(2);
      expect(entry.brief.source.kind).toBe("revision");
    });
    expect(rebound.impact.semanticChange).toBe(false);
  });

  it("rejects duplicate previous briefs and conflicting supplied identities order-independently", () => {
    const graph = stockResearchGraph();
    const plan = stockResearchPlan(graph);
    const first = compileStock();
    const conflicting = [
      ...stockAssignments(),
      {
        ...stockAssignments()[0]!,
        assignmentId:
          "assignment_10000000-0000-7000-8000-000000000009" as never,
      },
    ];
    const request = {
      projectId: STOCK_PROJECT_ID,
      source: plan.source,
      graph,
      plan,
      assignments: conflicting,
      previous: {
        plan,
        graph,
        briefs: [
          ...first.briefs.map((entry) => entry.brief),
          first.briefs[0]!.brief,
        ],
      },
    };
    const forward = compileAgentBriefs(request);
    const reversed = compileAgentBriefs({
      ...request,
      assignments: [...request.assignments].reverse(),
      previous: {
        ...request.previous,
        briefs: [...request.previous.briefs].reverse(),
      },
    });
    expect(forward.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "previous.briefs[1].plannedAgentId" }),
        expect.objectContaining({ path: "assignments[1]" }),
      ]),
    );
    expect(canonicalJson(forward.briefs)).toBe(canonicalJson(reversed.briefs));
    expect(forward.diagnostics).toEqual(reversed.diagnostics);
  });

  it("accepts exact historical plan lineage and rejects forged or unknown brief refs", () => {
    const graph = stockResearchGraph();
    const planV1 = stockResearchPlan(graph);
    const first = compileStock();
    const planV2 = reviseStockPlan(planV1, graph, {
      source: planV1.source,
      assignments: planV1.assignments.map((entry) =>
        entry.plannedAgentId === MARKETING_ID
          ? { ...entry, mission: "Publish revised approved research" }
          : entry,
      ),
    });
    const second = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: planV2.source,
      graph,
      plan: planV2,
      assignments: stockAssignments(),
      previous: {
        plan: planV1,
        graph,
        briefs: first.briefs.map((entry) => entry.brief),
      },
    });
    const lineage = [
      {
        planId: planV1.planId,
        version: planV1.version,
        semanticDigest: planV1.semanticDigest,
      },
      {
        planId: planV2.planId,
        version: planV2.version,
        semanticDigest: planV2.semanticDigest,
      },
    ];
    const previousBriefs = second.briefs.map((entry) => entry.brief);
    const valid = compileAgentBriefs({
      projectId: STOCK_PROJECT_ID,
      source: planV2.source,
      graph,
      plan: planV2,
      assignments: stockAssignments(),
      previous: {
        plan: planV2,
        graph,
        briefs: previousBriefs,
        allowedPlanRefs: lineage,
      },
    });
    expect(valid.diagnostics).toEqual([]);
    expect(
      valid.briefs.every((entry) => entry.disposition === "unchanged"),
    ).toBe(true);

    for (const forgedPlan of [
      {
        ...previousBriefs[0]!.plan,
        semanticDigest: `sha256:${"a".repeat(64)}` as never,
      },
      { ...previousBriefs[0]!.plan, version: 99 as never },
    ]) {
      const forged = structuredClone(previousBriefs);
      forged[0] = { ...forged[0]!, plan: forgedPlan };
      const result = compileAgentBriefs({
        projectId: STOCK_PROJECT_ID,
        source: planV2.source,
        graph,
        plan: planV2,
        assignments: stockAssignments(),
        previous: {
          plan: planV2,
          graph,
          briefs: forged,
          allowedPlanRefs: lineage,
        },
      });
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "source-digest-mismatch",
          path: "previous.briefs[0]",
        }),
      );
    }
  });
});
