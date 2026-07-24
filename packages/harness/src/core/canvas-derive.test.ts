import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ENRICHMENT_LIMITS } from "./canvas-enrichment.js";
import { extractWorkflowGraph, type CanvasGraph } from "./canvas-graph.js";
import {
  deriveCrossWorkflow,
  deriveEnrichment,
  deriveNotes,
  deriveSummary,
} from "./canvas-derive.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ORDER_TRIAGE_DIR = path.join(FIXTURES_DIR, "order-triage");

/** A CanvasGraph with sane defaults so each test states only what it exercises. */
function graph(partial: Partial<CanvasGraph>): CanvasGraph {
  return { manifestName: "wf", entry: "a", nodes: [], edges: [], warnings: [], ...partial };
}

describe("deriveSummary", () => {
  it("counts steps, branch points, and terminal outcomes", () => {
    const g = graph({
      nodes: [
        { id: "start", kind: "entry", label: "start" },
        { id: "decide", kind: "step", label: "decide" },
        { id: "ok", kind: "terminal-success", label: "ok" },
        { id: "warn", kind: "terminal-warn", label: "warn" },
      ],
      edges: [
        { from: "start", to: "decide", kind: "sequential" },
        { from: "decide", to: "ok", kind: "branching" },
        { from: "decide", to: "warn", kind: "branching" },
      ],
    });
    expect(deriveSummary(g)).toBe("4 steps · 1 branch point · 1 success / 1 escalation outcomes");
  });

  it("omits the outcomes clause when there are no terminals", () => {
    const g = graph({
      nodes: [
        { id: "start", kind: "entry", label: "start" },
        { id: "wait", kind: "pause", label: "wait" },
      ],
      edges: [{ from: "start", to: "wait", kind: "sequential" }],
    });
    expect(deriveSummary(g)).toBe("2 steps");
  });

  it("reads counts in the singular", () => {
    const g = graph({ nodes: [{ id: "only", kind: "terminal-success", label: "only" }] });
    expect(deriveSummary(g)).toBe("1 step · 1 success outcome");
  });

  it("excludes dashed launched-workflow placeholders from the step count", () => {
    const g = graph({
      nodes: [
        { id: "a", kind: "entry", label: "a" },
        { id: "launch:x", kind: "launched-workflow", label: "x" },
      ],
      edges: [{ from: "a", to: "launch:x", kind: "launch", label: "launch()" }],
    });
    expect(deriveSummary(g)).toBe("1 step");
  });
});

describe("deriveNotes", () => {
  it("returns the graph's own validation warnings, capped to the contract count", () => {
    expect(deriveNotes(graph({ warnings: ["w1", "w2", "w3", "w4"] }))).toEqual(["w1", "w2", "w3"]);
  });

  it("is undefined for a clean graph", () => {
    expect(deriveNotes(graph({ warnings: [] }))).toBeUndefined();
  });

  it("truncates an over-long warning to the note cap with an ellipsis", () => {
    const [note] = deriveNotes(graph({ warnings: ["x".repeat(ENRICHMENT_LIMITS.note + 20)] }))!;
    expect(note).toHaveLength(ENRICHMENT_LIMITS.note);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("deriveCrossWorkflow", () => {
  it("names the distinct launched workflows, sorted", () => {
    const g = graph({
      nodes: [
        { id: "a", kind: "entry", label: "a" },
        { id: "launch:zeta", kind: "launched-workflow", label: "zeta" },
        { id: "launch:alpha", kind: "launched-workflow", label: "alpha" },
      ],
    });
    expect(deriveCrossWorkflow(g)).toBe("Launches alpha, zeta.");
  });

  it("is undefined when the workflow launches nothing", () => {
    expect(deriveCrossWorkflow(graph({ nodes: [{ id: "a", kind: "entry", label: "a" }] }))).toBeUndefined();
  });
});

describe("deriveEnrichment", () => {
  it("sets only fields with real content — a clean linear workflow gets just a summary", () => {
    const g = graph({
      nodes: [
        { id: "a", kind: "entry", label: "a" },
        { id: "b", kind: "terminal-success", label: "b" },
      ],
      edges: [{ from: "a", to: "b", kind: "sequential" }],
    });
    expect(deriveEnrichment(g)).toEqual({ summary: "2 steps · 1 success outcome" });
  });

  it("includes notes and crossWorkflow when the graph warrants them", () => {
    const g = graph({
      nodes: [
        { id: "a", kind: "entry", label: "a" },
        { id: "done", kind: "terminal-success", label: "done" },
        { id: "launch:spoke", kind: "launched-workflow", label: "spoke" },
      ],
      edges: [
        { from: "a", to: "done", kind: "sequential" },
        { from: "a", to: "launch:spoke", kind: "launch", label: "launch()" },
      ],
      warnings: ["one warning"],
    });
    expect(deriveEnrichment(g)).toEqual({
      summary: "2 steps · 1 success outcome",
      notes: ["one warning"],
      crossWorkflow: "Launches spoke.",
    });
  });

  it("is pure — the same graph always yields an identical enrichment", () => {
    const g = graph({
      nodes: [
        { id: "a", kind: "entry", label: "a" },
        { id: "b", kind: "terminal-warn", label: "b" },
      ],
      edges: [{ from: "a", to: "b", kind: "sequential" }],
    });
    expect(deriveEnrichment(g)).toEqual(deriveEnrichment(g));
  });
});

describe("deriveEnrichment over a real extracted graph (order-triage)", () => {
  it("summarizes the real fixture deterministically, end to end", async () => {
    const result = await extractWorkflowGraph(ORDER_TRIAGE_DIR);
    if (!result.ok) throw new Error("expected extraction to succeed");
    expect(deriveEnrichment(result.graph)).toEqual({
      summary: "5 steps · 1 branch point · 2 success outcomes",
    });
  });
});
