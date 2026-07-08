/**
 * Server-side SVG layout for a `CanvasGraph` (see core/canvas-graph.ts),
 * emitting markup against the classes `core/canvas-template.ts`'s CSS shell
 * already defines (node--entry/step/pause/terminal-success/terminal-warn,
 * canvas-edge/--success/--warn/--cross). No DOM, no client-side script — the
 * whole diagram is a static string built once, at render time.
 *
 * Layout: longest-path-from-roots layering (a Kahn's-algorithm variant),
 * robust to reconverging branches (diamonds) and defensively bounded against
 * a cycle (a malformed/adversarial manifest should degrade, not hang). Ported
 * from the layout math in an earlier client-side renderer (see git history of
 * canvas-template.ts, commit "canvas kit — LLM writes data, not HTML") — the
 * geometry is unchanged, only where it runs (server, not browser).
 */
import type { CanvasEdge, CanvasEdgeKind, CanvasGraph, CanvasNode, CanvasNodeKind } from "./canvas-graph.js";

export const NODE_W = 176;
export const NODE_H = 56;
const LAYER_GAP = 96;
const COL_GAP = 32;
const MARGIN = 40;

export interface GraphLayout {
  pos: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** Assigns each node the longest-path layer reachable from a root (an
 *  in-degree-0 node). Nodes never reached by a root (only possible on a
 *  disconnected/cyclic fragment) fall to the layer just past the deepest
 *  known one, so they still render instead of vanishing. */
export function computeLayers(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]): Map<string, number> {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  let queue = ids.filter((id) => indeg.get(id) === 0);
  const seen = new Set(queue);
  for (const id of queue) layer.set(id, 0);

  const maxIterations = ids.length * 2 + 2;
  let iterations = 0;
  while (queue.length > 0 && iterations++ < maxIterations) {
    const next: string[] = [];
    for (const id of queue) {
      for (const child of adj.get(id) ?? []) {
        const candidate = (layer.get(id) ?? 0) + 1;
        if (!layer.has(child) || candidate > layer.get(child)!) layer.set(child, candidate);
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }
    queue = next;
  }

  let maxLayer = 0;
  for (const l of layer.values()) if (l > maxLayer) maxLayer = l;
  for (const id of ids) if (!layer.has(id)) layer.set(id, maxLayer + 1);
  return layer;
}

/** Computes (x, y) for every node and the overall canvas size. Nodes in the
 *  same layer are centered as a row; layers stack top to bottom. */
export function layoutGraph(graph: CanvasGraph): GraphLayout {
  const layer = computeLayers(graph.nodes, graph.edges);
  const byLayer = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const l = layer.get(n.id) ?? 0;
    const arr = byLayer.get(l) ?? [];
    arr.push(n.id);
    byLayer.set(l, arr);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const maxCols = layers.reduce((m, l) => Math.max(m, byLayer.get(l)!.length), 1);
  const width = MARGIN * 2 + maxCols * NODE_W + (maxCols - 1) * COL_GAP;

  const pos: Record<string, { x: number; y: number }> = {};
  for (const l of layers) {
    const idsInLayer = byLayer.get(l)!;
    const rowWidth = idsInLayer.length * NODE_W + (idsInLayer.length - 1) * COL_GAP;
    const startX = (width - rowWidth) / 2;
    idsInLayer.forEach((id, i) => {
      pos[id] = { x: startX + i * (NODE_W + COL_GAP), y: MARGIN + l * (NODE_H + LAYER_GAP) };
    });
  }
  const height = MARGIN * 2 + (layers.length - 1) * (NODE_H + LAYER_GAP) + NODE_H;
  return { pos, width, height: Math.max(height, MARGIN * 2 + NODE_H) };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function edgeColorClass(nodesById: Map<string, CanvasNode>, edge: CanvasEdge): "" | "--success" | "--warn" {
  const target = nodesById.get(edge.to);
  if (target?.kind === "terminal-success") return "--success";
  if (target?.kind === "terminal-warn") return "--warn";
  return "";
}

function arrowMarker(colorSuffix: "" | "--success" | "--warn"): string {
  if (colorSuffix === "--success") return "url(#canvas-arrow-success)";
  if (colorSuffix === "--warn") return "url(#canvas-arrow-warn)";
  return "url(#canvas-arrow)";
}

function edgePath(kind: CanvasEdgeKind, x1: number, y1: number, x2: number, y2: number): string {
  if (kind === "branching") {
    const midY = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
  }
  return `M${x1},${y1} L${x2},${y2}`;
}

/** Renders one graph's `<svg>` diagram. Assumes the shared `<defs>` (glow
 *  filter + arrow markers) are already present once at the document level —
 *  see `renderCanvasDocument`'s `SVG_DEFS` — so this never emits its own. */
export function renderGraphSvg(graph: CanvasGraph): string {
  const layout = layoutGraph(graph);
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  const edgeMarkup = graph.edges
    .map((edge) => {
      const from = layout.pos[edge.from];
      const to = layout.pos[edge.to];
      if (!from || !to) return "";
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y;
      const isCross = edge.kind === "cross";
      const colorSuffix = isCross ? "" : edgeColorClass(nodesById, edge);
      const classes = ["canvas-edge", isCross ? "canvas-edge--cross" : colorSuffix && `canvas-edge${colorSuffix}`]
        .filter(Boolean)
        .join(" ");
      const d = edgePath(edge.kind, x1, y1, x2, y2);
      const marker = isCross ? "url(#canvas-arrow)" : arrowMarker(colorSuffix);
      const path = `<path class="${classes}" d="${d}" marker-end="${marker}" />`;
      if (!edge.label) return path;
      const dx = x2 - x1;
      const anchor = dx > 4 ? "start" : dx < -4 ? "end" : "middle";
      const labelX = x1 + (dx > 0 ? 10 : dx < 0 ? -10 : 0);
      const label = `<text class="canvas-edge-label" x="${labelX}" y="${y1 + 20}" text-anchor="${anchor}">${esc(edge.label)}</text>`;
      return path + label;
    })
    .join("\n");

  const nodeMarkup = graph.nodes
    .map((node) => {
      const p = layout.pos[node.id];
      if (!p) return "";
      const titleY = node.sublabel ? 22 : NODE_H / 2;
      const sub = node.sublabel
        ? `<text class="canvas-node-sub" x="${NODE_W / 2}" y="40">${esc(node.sublabel)}</text>`
        : "";
      return (
        `<g class="canvas-node node--${node.kind}" filter="url(#canvas-glow)" transform="translate(${p.x},${p.y})">` +
        `<rect class="canvas-node-rect" width="${NODE_W}" height="${NODE_H}" rx="14" />` +
        `<text class="canvas-node-title" x="${NODE_W / 2}" y="${titleY}">${esc(node.label)}</text>` +
        sub +
        `</g>`
      );
    })
    .join("\n");

  return (
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" class="canvas-graph-svg">\n` +
    edgeMarkup +
    "\n" +
    nodeMarkup +
    `\n</svg>`
  );
}

/** Every node/edge kind actually used, for the shared legend footer. */
export function usedKinds(graph: CanvasGraph): { nodeKinds: Set<CanvasNodeKind>; edgeKinds: Set<CanvasEdgeKind> } {
  return {
    nodeKinds: new Set(graph.nodes.map((n) => n.kind)),
    edgeKinds: new Set(graph.edges.map((e) => e.kind)),
  };
}
