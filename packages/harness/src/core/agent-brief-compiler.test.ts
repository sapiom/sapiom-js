import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { PlanNodeId } from "../shared/agent-map.js";
import {
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
  reviseStockPlan,
} from "./agent-brief-compiler.test-support.js";
import { canonicalJson } from "./build-plan-canonicalization.js";

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
        "sha256:7b3f71416d3441209162134fa85645866636d298785a4fa2ac753c0eb6c08a25",
        "sha256:c1bb5e745a4d8770c481185fd871c400d18da16c64bc010f953b20c02e68a285",
      ],
      briefRecordDigests: [
        "sha256:9afc89433a3bae3590c3a65f916acb636213d255a386ce444e5d2b6d316fae38",
        "sha256:ea608d0ea468aa5952cc0db91793abbf3a7621f49f0c29bdcd0996bbe6f86469",
      ],
      bootstrapDigests: [
        "sha256:bc66bf9db1260f15b4f0f091887178b899888a645b5bb535c602e46fd13c888b",
        "sha256:c3077bb88e615695b71f4d81f4b1d7d12571032d102ef941a345acc44eeaaeb1",
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
        expect.objectContaining({ path: "previous.briefs[2].plannedAgentId" }),
        expect.objectContaining({ path: "assignments[2]" }),
      ]),
    );
    expect(canonicalJson(forward.briefs)).toBe(canonicalJson(reversed.briefs));
    expect(forward.diagnostics.map((entry) => entry.code)).toEqual(
      reversed.diagnostics.map((entry) => entry.code),
    );
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
