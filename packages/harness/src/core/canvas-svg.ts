/**
 * Server-side SVG layout for a `CanvasGraph` (see core/canvas-graph.ts),
 * emitting markup against the classes `core/canvas-template.ts`'s CSS shell
 * already defines (node--entry/step/pause/terminal-success/terminal-warn/
 * launched-workflow, canvas-edge/--success/--warn/--cross/--launch). No DOM,
 * no client-side script — the
 * whole diagram is a static string built once, at render time.
 *
 * Layout: longest-path-from-roots layering (a Kahn's-algorithm variant),
 * robust to reconverging branches (diamonds) and defensively bounded against
 * a cycle (a malformed/adversarial manifest should degrade, not hang). Ported
 * from the layout math in an earlier client-side renderer (see git history of
 * canvas-template.ts, commit "canvas kit — LLM writes data, not HTML") — the
 * geometry is unchanged, only where it runs (server, not browser).
 */
import type {
  CanvasEdge,
  CanvasEdgeKind,
  CanvasGraph,
  CanvasNode,
  CanvasNodeKind,
} from "./canvas-graph.js";
import type {
  CanvasEnrichment,
  CanvasLayoutHints,
} from "./canvas-enrichment.js";

export const NODE_W = 176;
export const NODE_H = 64;
const LAYER_GAP = 72;
const COL_GAP = 32;
const MARGIN = 40;
/** How far a group band extends past its member nodes' boxes. */
const GROUP_PAD = 10;

export interface GraphLayout {
  pos: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** Assigns each node the longest-path layer reachable from a root (an
 *  in-degree-0 node). Nodes never reached by a root (only possible on a
 *  disconnected/cyclic fragment) fall to the layer just past the deepest
 *  known one, so they still render instead of vanishing. */
export function computeLayers(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): Map<string, number> {
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
        if (!layer.has(child) || candidate > layer.get(child)!)
          layer.set(child, candidate);
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

/** Computes (x, y) for every node and the overall canvas size. Each node is
 *  placed at the BARYCENTRE of its already-placed parents (so a single-child
 *  step sits directly under its parent's lane, and a merge node centres between
 *  the branches that feed it — the two paths converge symmetrically instead of
 *  a straight chain being forced dead-centre while a side branch has to detour
 *  around it). Within a layer, order follows the (laneOrder-applied) sequence
 *  and nodes are spread to a minimum spacing, then re-balanced onto the parent
 *  barycentre. Layers stack top to bottom; layer assignment stays purely
 *  structural (computeLayers). */
export function layoutGraph(
  graph: CanvasGraph,
  laneOrder?: CanvasLayoutHints["laneOrder"],
): GraphLayout {
  const layer = computeLayers(graph.nodes, graph.edges);
  const byLayer = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const l = layer.get(n.id) ?? 0;
    const arr = byLayer.get(l) ?? [];
    arr.push(n.id);
    byLayer.set(l, arr);
  }
  applyLaneOrder(byLayer, graph, laneOrder);
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  const idSet = new Set(graph.nodes.map((n) => n.id));
  const parentsOf = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (idSet.has(e.from) && idSet.has(e.to)) parentsOf.get(e.to)!.push(e.from);
  }

  const SLOT = NODE_W + COL_GAP;
  // Provisional node-CENTRE x, filled top-down so a node's parents are placed
  // before it. Normalised to the left margin afterwards.
  const cx = new Map<string, number>();
  for (const l of layers) {
    const ids = byLayer.get(l)!;
    const desired = ids.map((id) => {
      const placed = parentsOf.get(id)!.filter((p) => cx.has(p));
      return placed.length ? placed.reduce((s, p) => s + cx.get(p)!, 0) / placed.length : null;
    });
    const known = desired.filter((v): v is number => v != null);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
    const centers = desired.map((d) => (d == null ? fallback : d));
    // Enforce the row's left-to-right order and a minimum gap between boxes.
    for (let i = 1; i < centers.length; i++) {
      if (centers[i]! < centers[i - 1]! + SLOT) centers[i] = centers[i - 1]! + SLOT;
    }
    // Spreading may have pushed the row off its parents' centre — slide it back
    // so the group stays balanced under what feeds it.
    if (known.length) {
      const assigned = centers.reduce((a, b) => a + b, 0) / centers.length;
      const shift = known.reduce((a, b) => a + b, 0) / known.length - assigned;
      for (let i = 0; i < centers.length; i++) centers[i]! += shift;
    }
    ids.forEach((id, i) => cx.set(id, centers[i]!));
  }

  const centersAll = [...cx.values()];
  const minLeft = Math.min(...centersAll) - NODE_W / 2;
  const shiftX = MARGIN - minLeft;
  const pos: Record<string, { x: number; y: number }> = {};
  for (const l of layers) {
    for (const id of byLayer.get(l)!) {
      pos[id] = {
        x: cx.get(id)! + shiftX - NODE_W / 2,
        y: MARGIN + l * (NODE_H + LAYER_GAP),
      };
    }
  }
  const width = Math.max(...centersAll) + shiftX + NODE_W / 2 + MARGIN;
  const height =
    MARGIN * 2 + (layers.length - 1) * (NODE_H + LAYER_GAP) + NODE_H;
  return { pos, width, height: Math.max(height, MARGIN * 2 + NODE_H) };
}

/**
 * Reorders each hinted layer's nodes in place. A hint entry is applied only
 * when every node id it lists exists in the graph (the schema's contract —
 * a stale enrichment must degrade to "no hint", never to a broken layout);
 * listed ids that live in a DIFFERENT layer are simply not in this layer's
 * row and are ignored, since laneOrder can never move a node between layers.
 */
function applyLaneOrder(
  byLayer: Map<number, string[]>,
  graph: CanvasGraph,
  laneOrder: CanvasLayoutHints["laneOrder"],
): void {
  if (!laneOrder) return;
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  for (const [layerKey, order] of Object.entries(laneOrder)) {
    const layerIndex = Number(layerKey);
    const row = byLayer.get(layerIndex);
    if (!row || !order.every((id) => nodeIds.has(id))) continue;
    const inRow = new Set(row);
    const ordered = order.filter((id) => inRow.has(id));
    const rest = row.filter((id) => !ordered.includes(id));
    byLayer.set(layerIndex, [...ordered, ...rest]);
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function edgeColorClass(
  nodesById: Map<string, CanvasNode>,
  edge: CanvasEdge,
): "" | "--success" | "--warn" {
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

function edgePath(
  kind: CanvasEdgeKind,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  if (kind === "branching") {
    const midY = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
  }
  return `M${x1},${y1} L${x2},${y2}`;
}

/**
 * Group-hint background bands: one subtle rect per group whose member nodes
 * ALL exist, sized to their bounding box, labeled at its top-left. Rendered
 * before edges/nodes so it sits behind everything.
 */
function groupBandMarkup(
  groups: CanvasLayoutHints["groups"],
  graph: CanvasGraph,
  layout: GraphLayout,
): string {
  if (!groups || groups.length === 0) return "";
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  return groups
    .map((group) => {
      if (!group.nodeIds.every((id) => nodeIds.has(id))) return "";
      const positions = group.nodeIds
        .map((id) => layout.pos[id])
        .filter(Boolean);
      if (positions.length === 0) return "";
      const minX = Math.min(...positions.map((p) => p.x)) - GROUP_PAD;
      const minY = Math.min(...positions.map((p) => p.y)) - GROUP_PAD;
      const maxX = Math.max(...positions.map((p) => p.x + NODE_W)) + GROUP_PAD;
      const maxY = Math.max(...positions.map((p) => p.y + NODE_H)) + GROUP_PAD;
      return (
        `<rect class="canvas-group-band" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="18" />` +
        `<text class="canvas-group-label" x="${minX + 8}" y="${minY - 4}">${esc(group.label)}</text>`
      );
    })
    .filter(Boolean)
    .join("\n");
}

/** Renders one graph's `<svg>` diagram, merging in any enrichment content
 *  (node sublabels/descriptions, edge labels, group bands, lane order) — all
 *  of it pre-bounded plain strings (core/canvas-enrichment.ts), escaped here
 *  like every other text. Assumes the shared `<defs>` (glow filter + arrow
 *  markers) are already present once at the document level — see
 *  `renderCanvasDocument`'s `SVG_DEFS` — so this never emits its own. */
export function renderGraphSvg(
  graph: CanvasGraph,
  enrichment?: CanvasEnrichment | null,
): string {
  const layout = layoutGraph(graph, enrichment?.layoutHints?.laneOrder);
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  const bandMarkup = groupBandMarkup(
    enrichment?.layoutHints?.groups,
    graph,
    layout,
  );

  const edgeMarkup = graph.edges
    .map((edge) => {
      const from = layout.pos[edge.from];
      const to = layout.pos[edge.to];
      if (!from || !to) return "";
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y;
      // Cross (signal/handoff) and launch edges are always dashed-neutral,
      // never colored by their destination.
      const dashedClass =
        edge.kind === "cross"
          ? "canvas-edge--cross"
          : edge.kind === "launch"
            ? "canvas-edge--launch"
            : null;
      const colorSuffix = dashedClass ? "" : edgeColorClass(nodesById, edge);
      const classes = [
        "canvas-edge",
        dashedClass ?? (colorSuffix && `canvas-edge${colorSuffix}`),
      ]
        .filter(Boolean)
        .join(" ");
      const fromLayer = Math.round((from.y - MARGIN) / (NODE_H + LAYER_GAP));
      const toLayer = Math.round((to.y - MARGIN) / (NODE_H + LAYER_GAP));
      // In-between nodes a long edge might cross (empty for adjacent edges).
      const between =
        toLayer - fromLayer > 1
          ? graph.nodes.filter((n) => {
              const l = Math.round((layout.pos[n.id].y - MARGIN) / (NODE_H + LAYER_GAP));
              return l > fromLayer && l < toLayer;
            })
          : [];
      // Only re-route when the straight line would actually run UNDER one of
      // them — with the barycentre layout most long edges pass through clear
      // space and stay a plain line/curve.
      const collides = between.some((n) => {
        const np = layout.pos[n.id];
        const t = (np.y + NODE_H / 2 - y1) / (y2 - y1);
        const lineX = x1 + (x2 - x1) * t;
        return lineX > np.x - COL_GAP / 2 && lineX < np.x + NODE_W + COL_GAP / 2;
      });
      let d: string;
      if (collides) {
        // Route down a clear SIDE LANE past the blocking node(s) — the lane
        // clears the widest one on the bow side — then curve into the target,
        // nudging the entry x so a stacked arrowhead doesn't overlap another.
        const bowRight = x1 >= x2;
        const laneX = bowRight
          ? Math.min(
              layout.width - MARGIN / 2,
              Math.max(x1, x2, ...between.map((n) => layout.pos[n.id].x + NODE_W)) + COL_GAP,
            )
          : Math.max(MARGIN / 2, Math.min(x1, x2, ...between.map((n) => layout.pos[n.id].x)) - COL_GAP);
        const enterX = x2 + (bowRight ? NODE_W * 0.18 : -NODE_W * 0.18);
        const dy = y2 - y1;
        d = `M${x1},${y1} C ${laneX},${y1 + dy * 0.25} ${laneX},${y2 - dy * 0.25} ${enterX},${y2}`;
      } else {
        d = edgePath(edge.kind, x1, y1, x2, y2);
      }
      const marker = dashedClass
        ? "url(#canvas-arrow)"
        : arrowMarker(colorSuffix);
      const path = `<path class="${classes}" d="${d}" marker-end="${marker}" />`;
      // An enriched label (an intent/condition name the AI read out of the
      // step body) wins over the structural default (e.g. "launch()").
      const labelText =
        enrichment?.edgeLabels?.[`${edge.from}->${edge.to}`] ?? edge.label;
      if (!labelText) return path;
      const dx = x2 - x1;
      const anchor = dx > 4 ? "start" : dx < -4 ? "end" : "middle";
      const labelX = x1 + (dx > 0 ? 10 : dx < 0 ? -10 : 0);
      const label = `<text class="canvas-edge-label" x="${labelX}" y="${y1 + 20}" text-anchor="${anchor}">${esc(labelText)}</text>`;
      return path + label;
    })
    .join("\n");

  const nodeMarkup = graph.nodes
    .map((node) => {
      const p = layout.pos[node.id];
      if (!p) return "";
      const details = enrichment?.nodeDetails?.[node.id];
      const sublabel = details?.sublabel ?? node.sublabel;
      const titleY = sublabel ? 26 : NODE_H / 2;
      const sub = sublabel
        ? `<text class="canvas-node-sub" x="${NODE_W / 2}" y="44">${esc(sublabel)}</text>`
        : "";
      // SVG <title> = native hover tooltip; the only enrichment slot with
      // room for a full sentence.
      const description = details?.description
        ? `<title>${esc(details.description)}</title>`
        : "";
      return (
        `<g class="canvas-node node--${node.kind}" filter="url(#canvas-glow)" transform="translate(${p.x},${p.y})" data-step-name="${esc(node.label)}" data-step-id="${esc(node.id)}">` +
        description +
        `<rect class="canvas-node-rect" width="${NODE_W}" height="${NODE_H}" rx="14" />` +
        `<text class="canvas-node-title" x="${NODE_W / 2}" y="${titleY}">${esc(node.label)}</text>` +
        sub +
        `</g>`
      );
    })
    .join("\n");

  // Explicit width/height pin the diagram to its NATURAL (1×) size. Without
  // them, the CSS `width:100%` used to stretch a single-column workflow's
  // tiny viewBox to fill the pane, ballooning every node and its font (~4×).
  // The CSS now only centers the svg (`margin: 0 auto`); a graph wider than
  // the pane keeps full size and scrolls (`.canvas-diagram-panel`'s
  // overflow-x) rather than shrinking to an illegible size.
  return (
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" class="canvas-graph-svg">\n` +
    (bandMarkup ? bandMarkup + "\n" : "") +
    edgeMarkup +
    "\n" +
    nodeMarkup +
    `\n</svg>`
  );
}

/** Every node/edge kind actually used, for the shared legend footer. */
export function usedKinds(graph: CanvasGraph): {
  nodeKinds: Set<CanvasNodeKind>;
  edgeKinds: Set<CanvasEdgeKind>;
} {
  return {
    nodeKinds: new Set(graph.nodes.map((n) => n.kind)),
    edgeKinds: new Set(graph.edges.map((e) => e.kind)),
  };
}
