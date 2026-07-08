/**
 * Deterministic workflow graph extraction (no LLM). Runs `@sapiom/agent-core`'s
 * `check()` pipeline (in an isolated child process — see
 * core/canvas-manifest-check.ts for why) against a workflow project on disk
 * — the same bundle+manifest+graph-validation path `sapiom agents check`
 * uses — and reshapes the resulting manifest into the small node/edge model
 * `canvas-svg.ts` renders. Never throws: extraction failure (missing
 * node_modules, a type error, an invalid graph) is returned as a typed
 * `ExtractionFailure` so the caller can render an honest degraded panel
 * instead of crashing or silently falling back to an LLM.
 */
import type { AgentManifest, AgentStepManifest } from "@sapiom/agent";
import { runManifestCheck } from "./canvas-manifest-check.js";
import { detectWorkflowLaunches, type DetectedLaunch } from "./canvas-interconnections.js";

export type CanvasNodeKind = "entry" | "step" | "pause" | "terminal-success" | "terminal-warn" | "launched-workflow";
export type CanvasEdgeKind = "sequential" | "branching" | "cross" | "launch";

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  label: string;
  sublabel?: string;
}

export interface CanvasEdge {
  from: string;
  to: string;
  kind: CanvasEdgeKind;
  label?: string;
}

/** One workflow's extracted, render-ready graph. */
export interface CanvasGraph {
  /** The manifest's own name — used both as a display title fallback and as
   *  the match key for cross-workflow interconnection detection. */
  manifestName: string;
  entry: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Non-fatal graph smells from `assertValidGraph` (unreachable steps, no
   *  path to a terminal) — surfaced as a badge, not an error. */
  warnings: string[];
}

export interface ExtractionSuccess {
  ok: true;
  graph: CanvasGraph;
}

export interface ExtractionFailure {
  ok: false;
  /** Human-readable, terminal-safe reason — shown verbatim in the degraded panel. */
  reason: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

/**
 * Classifies a step for node styling. Priority: the entry step always reads
 * as "entry" (the diagram's obvious starting point) even if it also happens
 * to declare a pause/terminal transition; next, a declared `pause` always
 * shows the dashed border regardless of what else the step declares; a step
 * that can `continue` somewhere is a mid-flow "step" even if it can also
 * terminate/fail from a different runtime branch; only a step with NO
 * `continue` targets left resolves to a terminal color, warn (fail) over
 * success (terminate) is not possible to prioritize both apply — success
 * wins as the more common single-outcome shape.
 */
function classifyNode(
  name: string,
  entry: string,
  step: AgentStepManifest,
): { kind: CanvasNodeKind; sublabel?: string } {
  const continueTargets = step.transitions.filter((t) => t.kind === "continue");
  const pause = step.transitions.find((t) => t.kind === "pause");
  const hasTerminate = step.transitions.some((t) => t.kind === "terminate");
  const hasFail = step.transitions.some((t) => t.kind === "fail");

  if (name === entry) return { kind: "entry" };
  if (pause) return { kind: "pause", sublabel: `waits for signal "${pause.signal}"` };
  if (continueTargets.length === 0 && hasFail && !hasTerminate) return { kind: "terminal-warn" };
  if (continueTargets.length === 0 && hasTerminate) return { kind: "terminal-success" };
  if (continueTargets.length > 0 && (hasTerminate || hasFail)) {
    return { kind: "step", sublabel: hasFail ? "can also fail" : "can also terminate" };
  }
  return { kind: "step" };
}

/** Builds every edge a step declares — one per `continue` target plus its
 *  `pause` edge, if any. Node kind (above) only decides border styling; every
 *  declared transition with a target still gets its own edge. */
function edgesForStep(name: string, step: AgentStepManifest): CanvasEdge[] {
  const continueTargets = step.transitions.filter((t) => t.kind === "continue");
  const edges: CanvasEdge[] = continueTargets.map((t) => ({
    from: name,
    to: t.target,
    kind: continueTargets.length > 1 ? "branching" : "sequential",
  }));
  const pause = step.transitions.find((t) => t.kind === "pause");
  if (pause) {
    edges.push({ from: name, to: pause.resumeStep, kind: "cross", label: pause.signal });
  }
  return edges;
}

/** Reshapes a validated `AgentManifest` into the render-ready graph model. */
export function graphFromManifest(manifest: AgentManifest, warnings: string[]): CanvasGraph {
  const nodes: CanvasNode[] = Object.entries(manifest.steps).map(([name, step]) => {
    const { kind, sublabel } = classifyNode(name, manifest.entry, step);
    return { id: name, kind, label: name, ...(sublabel ? { sublabel } : {}) };
  });
  const edges: CanvasEdge[] = Object.entries(manifest.steps).flatMap(([name, step]) =>
    edgesForStep(name, step),
  );
  return { manifestName: manifest.name, entry: manifest.entry, nodes, edges, warnings };
}

/**
 * Merges heuristically detected cross-workflow launches into the workflow's
 * own graph: one dashed `launched-workflow` node per distinct slug, with a
 * `launch`-kind edge from the step the call was attributed to (falling back
 * to the entry step — the launch definitely happens somewhere downstream of
 * it). Self-launches (a workflow re-launching itself) are skipped: the graph
 * already shows those steps. Pure — returns a new graph.
 */
export function mergeLaunchesIntoGraph(graph: CanvasGraph, launches: readonly DetectedLaunch[]): CanvasGraph {
  const stepIds = new Set(graph.nodes.map((n) => n.id));
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const seenEdges = new Set<string>();

  for (const launch of launches) {
    if (launch.slug === graph.manifestName) continue;
    // Prefixed id so a launched workflow can never collide with a step that
    // happens to share its name.
    const nodeId = `launch:${launch.slug}`;
    if (!nodes.some((n) => n.id === nodeId)) {
      nodes.push({ id: nodeId, kind: "launched-workflow", label: launch.slug });
    }
    const from = launch.fromStepId && stepIds.has(launch.fromStepId) ? launch.fromStepId : graph.entry;
    const edgeKey = `${from}->${nodeId}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    edges.push({ from, to: nodeId, kind: "launch", label: "launch()" });
  }
  return { ...graph, nodes, edges };
}

/**
 * Extracts a workflow's step graph from its project directory, with detected
 * cross-workflow launches merged in as dashed nodes. Never throws: any
 * failure (no node_modules, a bundle/type error, an invalid graph, a
 * check-process crash or timeout) comes back as `{ ok: false, reason }` for
 * the caller to render as a degraded panel — this is the only place
 * extraction failure is allowed to happen silently instead of crashing the
 * render.
 */
export async function extractWorkflowGraph(sourceDir: string): Promise<ExtractionResult> {
  const result = await runManifestCheck(sourceDir);
  if (!result.ok) return { ok: false, reason: result.reason };
  const graph = graphFromManifest(result.manifest as AgentManifest, result.warnings);
  const launches = await detectWorkflowLaunches(sourceDir, new Set(graph.nodes.map((n) => n.id)));
  return { ok: true, graph: mergeLaunchesIntoGraph(graph, launches) };
}
