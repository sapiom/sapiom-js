import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkflowGraph } from "./canvas-graph.js";

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
});
