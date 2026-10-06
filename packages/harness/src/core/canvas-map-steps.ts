/**
 * The agent modal's Canvas, drawn from the project map
 * (plans/agent-map-rebuild/design.md §3, §5, M6; design-eng agent-studio-v2
 * AGENT-MAP.md "Modal Canvas", D74).
 *
 * The browser sends what `sapiom_dev_map` returned for this agent at the ref
 * the map is drawn at: its steps, the agents it calls and the agents that call
 * it. The board's steps and transitions come from that; `agents check`'s richer
 * step details (description, input schema, capabilities, terminate/fail) are
 * joined by step id when the working copy has them. Every other agent this one
 * touches is a card at the board's border: an edge it makes leaves the step
 * that makes the call (`fromStep`), else the entry; an edge into it arrives at
 * the entry.
 */
import { z } from "zod";

import type { CanvasEdge, CanvasGraph, CanvasNode } from "./canvas-graph.js";

const label = z.string().trim().min(1).max(200);

const canvasMapInputSchema = z
  .object({
    steps: z
      .object({
        entry: label,
        steps: z
          .array(z.object({ id: label, file: z.string().max(1_000).optional(), line: z.number().int().optional() }))
          .max(500),
        transitions: z.array(z.object({ from: label, to: label, kind: z.string().max(50) })).max(2_000),
      })
      .nullable(),
    /** Why the map has no steps for this agent (`agents check` failed, a
     *  sandbox app). Shown on an empty board instead of a generic reason. */
    stepsUnavailable: z.string().trim().min(1).max(500).optional(),
    /** Agents this one calls, launches, signals or emits an event to. */
    calls: z
      .array(z.object({ to: label, kind: label, fromStep: label.optional(), label: label.optional() }))
      .max(500),
    /** Agents that call this one. */
    calledBy: z.array(z.object({ from: label, kind: label, label: label.optional() })).max(500),
  })
  .strict();

export type CanvasMapInput = z.infer<typeof canvasMapInputSchema>;

/** Parses the request body's `map`; null when it is absent or malformed. */
export function parseCanvasMapInput(value: unknown): CanvasMapInput | null {
  const parsed = canvasMapInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A border card's id: never a step id, which is a bare step name. */
export const borderNodeId = (slug: string) => `agent:${slug}`;

export function isBorderNode(node: Pick<CanvasNode, "id" | "kind">): boolean {
  return node.kind === "launched-workflow" && node.id.startsWith("agent:");
}

const isStepNode = (node: CanvasNode) => node.kind !== "launched-workflow";

/**
 * The board graph for one agent from its map entry. `details` is `agents
 * check`'s graph for the working copy when it could be extracted; its
 * launch nodes are dropped, because the map's edges replace them. With no map
 * steps (a sandbox app, or a ref whose agent has none) the details' steps stand.
 * Returns null when there is nothing to draw.
 */
export function graphFromMap(
  input: CanvasMapInput,
  details: CanvasGraph | null,
  fallback: { manifestName: string; description: string },
): CanvasGraph | null {
  const detailNodes = new Map((details?.nodes ?? []).filter(isStepNode).map((node) => [node.id, node]));
  const detailEdges = new Map(
    (details?.edges ?? []).filter((edge) => edge.kind !== "launch").map((edge) => [`${edge.from}\u0000${edge.to}`, edge]),
  );

  let nodes: CanvasNode[];
  let edges: CanvasEdge[];
  let entry: string;
  if (input.steps) {
    const steps = input.steps;
    entry = steps.entry;
    const declared = new Set(steps.steps.map((step) => step.id));
    // Only transitions that land on a declared step make a step non-terminal.
    const outgoing = new Set(
      steps.transitions
        .filter((t) => t.from !== t.to && declared.has(t.to))
        .map((t) => t.from),
    );
    nodes = steps.steps.map((step): CanvasNode => {
      const detail = detailNodes.get(step.id);
      const kind: CanvasNode["kind"] =
        step.id === steps.entry
          ? "entry"
          : detail && detail.kind !== "entry"
            ? detail.kind
            : outgoing.has(step.id)
              ? "step"
              : "terminal-success";
      return {
        ...(detail ?? {}),
        id: step.id,
        kind,
        label: detail?.label ?? step.id,
        ...(detail?.sublabel ? {} : step.file ? { sublabel: step.line ? `${step.file}:${step.line}` : step.file } : {}),
      };
    });
    // The entry anchors every border edge; keep it on the board even when the
    // manifest did not list it as a step.
    if (!declared.has(steps.entry)) nodes.unshift({ id: steps.entry, kind: "entry", label: steps.entry });
    const ids = new Set(nodes.map((node) => node.id));
    const seen = new Set<string>();
    edges = steps.transitions.flatMap((transition): CanvasEdge[] => {
      const key = `${transition.from}\u0000${transition.to}`;
      if (!ids.has(transition.from) || !ids.has(transition.to) || seen.has(key)) return [];
      seen.add(key);
      return [detailEdges.get(key) ?? { from: transition.from, to: transition.to, kind: "sequential" }];
    });
  } else if (details) {
    entry = details.entry;
    nodes = details.nodes.filter(isStepNode);
    edges = details.edges.filter((edge) => edge.kind !== "launch");
  } else {
    return null;
  }

  const stepIds = new Set(nodes.map((node) => node.id));
  const border = new Map<string, CanvasNode>();
  const borderEdges = new Map<string, CanvasEdge>();
  const card = (slug: string, sublabel: string) => {
    const id = borderNodeId(slug);
    const existing = border.get(id);
    if (!existing) border.set(id, { id, kind: "launched-workflow", label: slug, sublabel });
    // Called and calling: say both.
    else if (existing.sublabel !== sublabel) existing.sublabel = "agent · calls this agent";
    return id;
  };
  for (const call of input.calls) {
    if (call.to === fallback.manifestName) continue;
    const from = call.fromStep && stepIds.has(call.fromStep) ? call.fromStep : entry;
    const to = card(call.to, "agent");
    const key = `${from}\u0000${to}`;
    if (!borderEdges.has(key))
      borderEdges.set(key, { from, to, kind: "launch", ...(call.label ? { label: call.label } : {}) });
  }
  for (const caller of input.calledBy) {
    if (caller.from === fallback.manifestName) continue;
    const from = card(caller.from, "calls this agent");
    const key = `${from}\u0000${entry}`;
    if (!borderEdges.has(key))
      borderEdges.set(key, { from, to: entry, kind: "launch", ...(caller.label ? { label: caller.label } : {}) });
  }

  return {
    manifestName: details?.manifestName ?? fallback.manifestName,
    description: details?.description ?? fallback.description,
    entry,
    nodes: [...nodes, ...border.values()],
    edges: [...edges, ...borderEdges.values()],
    warnings: details?.warnings ?? [],
  };
}
