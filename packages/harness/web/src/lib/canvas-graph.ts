/**
 * The workflow graph the rendered canvas document posts to the app
 * ({type:"sapiom-canvas:graph"}) — a faithful projection of the server's
 * CanvasGraph (packages/harness/src/core/canvas-graph.ts), enrichment already
 * merged in. Everything here is ground truth extracted from the agent's
 * manifest; the drill-down renders only these fields, never guesses.
 */
export type CanvasNodeKind =
  | "entry"
  | "step"
  | "pause"
  | "terminal-success"
  | "terminal-warn"
  | "launched-workflow";

export type CanvasEdgeKind = "sequential" | "branching" | "cross" | "launch";

export interface CanvasGraphNode {
  id: string;
  kind: CanvasNodeKind;
  label: string;
  /** Deterministic role line ("entry", "step · can also fail", …). */
  role: string;
  /** Enrichment sentence, if the AI pass wrote one; else "". */
  description: string;
  /** The step's declared timeout from the manifest; null when unset. */
  timeoutMs: number | null;
  /** The step's declared input contract (JSON Schema) from the manifest. */
  inputSchema: CanvasInputSchema | null;
  /** Sapiom capabilities this step calls (the thing Sapiom bills for), when
   *  the rendering pipeline extracted them; [] when undeclared — the UI
   *  renders nothing rather than guessing. */
  capabilities: string[];
}

/** The subset of JSON Schema the manifest's inputSchema actually carries. */
export interface CanvasInputSchema {
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

export interface CanvasInputField {
  name: string;
  type: string;
  required: boolean;
}

/** The step's typed input fields, required first — [] when undeclared. */
export function stepInputFields(node: CanvasGraphNode): CanvasInputField[] {
  const props = node.inputSchema?.properties;
  if (!props) return [];
  const required = new Set(node.inputSchema?.required ?? []);
  return Object.entries(props)
    .map(([name, def]) => ({ name, type: def?.type ?? "unknown", required: required.has(name) }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/** Human timeout that never misstates the manifest: sub-second values stay
 *  in ms, seconds keep one decimal when fractional. */
export function formatTimeout(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  return `${s}s`;
}

/**
 * Structural facts a list row can honestly summarize: input contract size,
 * branch fan-out, timeout. Run data (status/cost/duration) does not reach
 * the app today and is never fabricated here.
 */
export function stepFacts(node: CanvasGraphNode, edges: CanvasGraphEdge[]): string[] {
  const facts: string[] = [];
  const inputs = stepInputFields(node).length;
  if (inputs > 0) facts.push(inputs === 1 ? "1 input" : `${inputs} inputs`);
  const branches = edges.filter((e) => e.from === node.id && e.kind === "branching").length;
  if (branches > 1) facts.push(`${branches} branches`);
  if (node.timeoutMs && node.timeoutMs > 0) facts.push(`${formatTimeout(node.timeoutMs)} limit`);
  return facts;
}

export interface CanvasGraphEdge {
  from: string;
  to: string;
  kind: CanvasEdgeKind;
  /** Branch condition / pause signal / "launch()"; else "". */
  label: string;
}

export interface CanvasGraphGroup {
  label: string;
  nodeIds: string[];
}

export interface CanvasGraph {
  name: string;
  entry: string;
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
  groups: CanvasGraphGroup[];
  warnings: string[];
}

/**
 * THE counting rule, shared by every surface that states a size (Steps tab
 * subheader, overview stats, demo chat copy): pipeline steps exclude
 * terminal exits, which are counted separately — so no two surfaces can
 * ever disagree about the same graph.
 */
export function graphCounts(graph: CanvasGraph): { steps: number; exits: number } {
  const exits = graph.nodes.filter(
    (n) => n.kind === "terminal-success" || n.kind === "terminal-warn",
  ).length;
  return { steps: graph.nodes.length - exits, exits };
}

/** "4 steps · 2 exits" (exits omitted when the graph has none). */
export function formatGraphCounts(graph: CanvasGraph): string {
  const { steps, exits } = graphCounts(graph);
  const parts = [`${steps} ${steps === 1 ? "step" : "steps"}`];
  if (exits > 0) parts.push(`${exits} ${exits === 1 ? "exit" : "exits"}`);
  return parts.join(" · ");
}

/** Human label for a node kind — the vocabulary the docs and legend use. */
export function nodeKindLabel(kind: CanvasNodeKind): string {
  switch (kind) {
    case "entry":
      return "Entry step";
    case "pause":
      return "Pause";
    case "terminal-success":
      return "Terminal · success";
    case "terminal-warn":
      return "Terminal · needs attention";
    case "launched-workflow":
      return "Launched workflow";
    default:
      return "Step";
  }
}

/** Normalize an untrusted inputSchema payload to the subset the UI renders. */
function parseInputSchema(raw: unknown): CanvasInputSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const schema = raw as Record<string, unknown>;
  if (!schema.properties || typeof schema.properties !== "object") return null;
  const properties: Record<string, { type?: string }> = {};
  for (const [name, def] of Object.entries(schema.properties as Record<string, unknown>)) {
    const type = def && typeof def === "object" ? (def as { type?: unknown }).type : undefined;
    properties[name] = typeof type === "string" ? { type } : {};
  }
  if (Object.keys(properties).length === 0) return null;
  return {
    properties,
    required: Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  };
}

/** Validate/normalize an untrusted posted payload into a CanvasGraph. */
export function parseCanvasGraph(raw: unknown): CanvasGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    name: str(g.name),
    entry: str(g.entry),
    nodes: (g.nodes as Record<string, unknown>[]).map((n) => ({
      id: str(n.id),
      kind: str(n.kind) as CanvasNodeKind,
      label: str(n.label),
      role: str(n.role),
      description: str(n.description),
      timeoutMs: typeof n.timeoutMs === "number" && n.timeoutMs > 0 ? n.timeoutMs : null,
      inputSchema: parseInputSchema(n.inputSchema),
      capabilities: Array.isArray(n.capabilities)
        ? (n.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
    })),
    edges: (g.edges as Record<string, unknown>[]).map((e) => ({
      from: str(e.from),
      to: str(e.to),
      kind: str(e.kind) as CanvasEdgeKind,
      label: str(e.label),
    })),
    groups: Array.isArray(g.groups)
      ? (g.groups as Record<string, unknown>[]).map((gr) => ({
          label: str(gr.label),
          nodeIds: Array.isArray(gr.nodeIds) ? gr.nodeIds.filter((id): id is string => typeof id === "string") : [],
        }))
      : [],
    warnings: Array.isArray(g.warnings) ? g.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}
