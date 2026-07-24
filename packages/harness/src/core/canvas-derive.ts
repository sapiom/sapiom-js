/**
 * Deterministic canvas enrichment (no LLM, no user token, no file reads, no
 * cache). Given the already-extracted CanvasGraph (core/canvas-graph.ts), it
 * computes the same CanvasEnrichment shape the old AI task returned
 * (core/canvas-enrichment.ts) — a summary line, footer notes, and a
 * cross-workflow tie — entirely from the graph's own structure. Pure and
 * total: the same graph in always yields the same enrichment out, and every
 * string is kept within ENRICHMENT_LIMITS so the layout can't break.
 *
 * What it deliberately does NOT reproduce from the retired AI pass: free-prose
 * per-step descriptions and condition-named edge labels, which needed a reading
 * of the step bodies. The base render already conveys role (node border +
 * classify-derived sublabel) and outcome (edge color), so their absence
 * degrades to "less prose", never "less structure".
 */
import { ENRICHMENT_LIMITS, type CanvasEnrichment } from "./canvas-enrichment.js";
import type { CanvasGraph, CanvasNode, CanvasNodeKind } from "./canvas-graph.js";

/** Truncates to a hard cap with an ellipsis. The derivations below stay well
 *  under their caps; this just makes the same guarantee the contract does. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function countKind(nodes: readonly CanvasNode[], kind: CanvasNodeKind): number {
  return nodes.filter((n) => n.kind === kind).length;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * A one-line description of the workflow's shape — step count, branch points,
 * and terminal outcomes — the deterministic stand-in for the AI summary. Reads
 * the same graph the diagram is drawn from, so it can never disagree with it.
 */
export function deriveSummary(graph: CanvasGraph): string {
  // Real steps only — exclude the dashed launched-workflow placeholders.
  const stepCount = graph.nodes.filter((n) => n.kind !== "launched-workflow").length;

  // A branch point is a step that fans out to multiple successors; the graph
  // marks exactly those edges "branching" (core/canvas-graph.ts's edgesForStep).
  const branchPoints = new Set(
    graph.edges.filter((e) => e.kind === "branching").map((e) => e.from),
  ).size;

  const success = countKind(graph.nodes, "terminal-success");
  const warn = countKind(graph.nodes, "terminal-warn");

  const parts = [`${stepCount} ${plural(stepCount, "step")}`];
  if (branchPoints > 0) parts.push(`${branchPoints} ${plural(branchPoints, "branch point")}`);
  const outcomes: string[] = [];
  if (success > 0) outcomes.push(`${success} success`);
  if (warn > 0) outcomes.push(`${warn} escalation`);
  if (outcomes.length > 0) {
    parts.push(`${outcomes.join(" / ")} ${plural(success + warn, "outcome")}`);
  }

  return clamp(parts.join(" · "), ENRICHMENT_LIMITS.summary);
}

/**
 * Footer notes: the graph's own validation warnings (unreachable steps, no path
 * to a terminal) — facts worth surfacing that the diagram can't show on its own.
 * Undefined when the graph is clean, capped to the contract's count/length.
 */
export function deriveNotes(graph: CanvasGraph): string[] | undefined {
  if (graph.warnings.length === 0) return undefined;
  const notes = graph.warnings
    .slice(0, ENRICHMENT_LIMITS.noteCount)
    .map((w) => clamp(w, ENRICHMENT_LIMITS.note));
  return notes.length > 0 ? notes : undefined;
}

/**
 * The cross-workflow tie, derived from the dashed launched-workflow nodes the
 * extraction already merged in (core/canvas-graph.ts's mergeLaunchesIntoGraph,
 * fed by the grep in core/canvas-interconnections.ts). Undefined when this
 * workflow launches none.
 */
export function deriveCrossWorkflow(graph: CanvasGraph): string | undefined {
  const launched = graph.nodes.filter((n) => n.kind === "launched-workflow").map((n) => n.label);
  if (launched.length === 0) return undefined;
  const unique = [...new Set(launched)].sort();
  return clamp(`Launches ${unique.join(", ")}.`, ENRICHMENT_LIMITS.crossWorkflow);
}

/**
 * Builds the deterministic enrichment for a graph. Only sets a field when it
 * has real content, so an annotation-light but valid workflow renders its clean
 * base — matching the "every field optional" contract the AI enrichment had.
 */
export function deriveEnrichment(graph: CanvasGraph): CanvasEnrichment {
  const enrichment: CanvasEnrichment = { summary: deriveSummary(graph) };
  const notes = deriveNotes(graph);
  if (notes) enrichment.notes = notes;
  const crossWorkflow = deriveCrossWorkflow(graph);
  if (crossWorkflow) enrichment.crossWorkflow = crossWorkflow;
  return enrichment;
}
