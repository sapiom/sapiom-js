import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkflowGraph, mergeLaunchesIntoGraph, type CanvasGraph } from "./canvas-graph.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ORDER_TRIAGE_DIR = path.join(FIXTURES_DIR, "order-triage");

describe("extractWorkflowGraph", () => {
  it("extracts order-triage's real step graph via @sapiom/agent-core's check()", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.graph.manifestName).toBe("order-triage");
    expect(result.graph.entry).toBe("intake");
    expect(result.graph.nodes).toHaveLength(5);
    expect(result.graph.nodes.map((n) => n.id).sort()).toEqual([
      "auto_resolve",
      "classify",
      "escalate",
      "intake",
      "route",
    ]);
  });

  it("classifies the entry step as 'entry' regardless of its other transitions", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");
    const intake = result.graph.nodes.find((n) => n.id === "intake")!;
    expect(intake.kind).toBe("entry");
  });

  it("classifies a step with no continue targets and a `terminate` transition as terminal-success", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");
    const autoResolve = result.graph.nodes.find((n) => n.id === "auto_resolve")!;
    expect(autoResolve.kind).toBe("terminal-success");
  });

  it("classifies a `terminate`-only step as terminal-success even when its payload implies an escalation — structural extraction reads declared transition kinds, never a runtime payload's meaning", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");
    const escalate = result.graph.nodes.find((n) => n.id === "escalate")!;
    expect(escalate.kind).toBe("terminal-success");
  });

  it("mid-flow steps with only continue targets classify as 'step'", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");
    expect(result.graph.nodes.find((n) => n.id === "classify")!.kind).toBe("step");
  });

  it("emits one sequential edge for a single-target continue, and branching edges for multi-target continue", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");

    const intakeToClassify = result.graph.edges.find((e) => e.from === "intake" && e.to === "classify");
    expect(intakeToClassify?.kind).toBe("sequential");

    const routeEdges = result.graph.edges.filter((e) => e.from === "route");
    expect(routeEdges).toHaveLength(2);
    expect(routeEdges.map((e) => e.to).sort()).toEqual(["auto_resolve", "escalate"]);
    for (const edge of routeEdges) expect(edge.kind).toBe("branching");
  });

  it("emits no edge for terminate/fail transitions — they have no target, only a node color", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");
    expect(result.graph.edges.some((e) => e.from === "auto_resolve")).toBe(false);
    expect(result.graph.edges.some((e) => e.from === "escalate")).toBe(false);
  });

  it("extracts a PRE-RENAME (@sapiom/orchestration) workflow via its legacy brand — old-SDK projects render without a dependency bump", async () => {
    const result = await extractWorkflowGraph(path.join(FIXTURES_DIR, "legacy-flow"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.graph.manifestName).toBe("legacy-flow");
    expect(result.graph.entry).toBe("receive");
    expect(result.graph.nodes.map((n) => n.id).sort()).toEqual(["award", "confirm", "receive"]);
    // The legacy step shape (next/terminal/canFail/pause) feeds buildManifest
    // unchanged: the pause edge and terminal classification both survive.
    const confirm = result.graph.nodes.find((n) => n.id === "confirm")!;
    expect(confirm.kind).toBe("pause");
    expect(result.graph.edges).toContainEqual({ from: "confirm", to: "award", kind: "cross", label: "vendor.confirm" });
    expect(result.graph.nodes.find((n) => n.id === "award")!.kind).toBe("terminal-success");
  });

  it("never throws: a missing project directory degrades to a typed failure", async () => {
    const result = await extractWorkflowGraph(path.join(FIXTURES_DIR, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/no index\.ts/i);
  });

  it("never throws: a project whose index.ts fails to bundle (unresolvable import) degrades to a typed failure", async () => {
    const result = await extractWorkflowGraph(path.join(FIXTURES_DIR, "broken-import"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("never throws: a project with no defineAgent export degrades to a typed failure", async () => {
    const result = await extractWorkflowGraph(path.join(FIXTURES_DIR, "no-definition"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no agent was exported/i);
  });

  it("merges a detected launch into the workflow's own graph as a dashed launched-workflow node", async () => {
    const result = await extractWorkflowGraph(path.join(FIXTURES_DIR, "hub"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const launched = result.graph.nodes.find((n) => n.kind === "launched-workflow");
    expect(launched).toEqual({ id: "launch:spoke-workflow", kind: "launched-workflow", label: "spoke-workflow" });
    expect(result.graph.edges).toContainEqual({
      from: "kickoff",
      to: "launch:spoke-workflow",
      kind: "launch",
      label: "launch()",
    });
  });
});

describe("mergeLaunchesIntoGraph", () => {
  const baseGraph: CanvasGraph = {
    manifestName: "self",
    entry: "start",
    nodes: [
      { id: "start", kind: "entry", label: "start" },
      { id: "finish", kind: "terminal-success", label: "finish" },
    ],
    edges: [{ from: "start", to: "finish", kind: "sequential" }],
    warnings: [],
  };

  it("adds one node per distinct slug and dedupes repeat launches from the same step", async () => {
    const merged = mergeLaunchesIntoGraph(baseGraph, [
      { slug: "other-flow", fromStepId: "finish" },
      { slug: "other-flow", fromStepId: "finish" },
    ]);
    expect(merged.nodes.filter((n) => n.kind === "launched-workflow")).toHaveLength(1);
    expect(merged.edges.filter((e) => e.kind === "launch")).toEqual([
      { from: "finish", to: "launch:other-flow", kind: "launch", label: "launch()" },
    ]);
  });

  it("falls back to the entry step when the launch couldn't be attributed", async () => {
    const merged = mergeLaunchesIntoGraph(baseGraph, [{ slug: "other-flow", fromStepId: null }]);
    expect(merged.edges).toContainEqual({ from: "start", to: "launch:other-flow", kind: "launch", label: "launch()" });
  });

  it("skips self-launches — the workflow's own steps are already the diagram", async () => {
    const merged = mergeLaunchesIntoGraph(baseGraph, [{ slug: "self", fromStepId: "finish" }]);
    expect(merged.nodes).toEqual(baseGraph.nodes);
    expect(merged.edges).toEqual(baseGraph.edges);
  });

  it("does not mutate the input graph", async () => {
    const nodesBefore = baseGraph.nodes.length;
    mergeLaunchesIntoGraph(baseGraph, [{ slug: "other-flow", fromStepId: null }]);
    expect(baseGraph.nodes).toHaveLength(nodesBefore);
  });
});
