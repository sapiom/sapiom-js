/**
 * Canvas kit: a prewritten, self-contained `.sapiom/canvas/index.html` — CSS
 * (light + dark, following the app's own theme) and a vanilla-JS renderer
 * are baked in at render time; the only thing an agent (or the visualize
 * macro) ever needs to write is the small JSON data block describing the
 * workflow(s). This replaces asking an LLM to hand-write ~11KB of HTML per
 * visualization (slow, and free to drift from the style contract every
 * time) with a ~1-2KB data write against a fixed, already-correct renderer.
 *
 * `renderCanvasHtml()` is the single source of truth for the document —
 * `ensureCanvasTemplate()` (session create/resume backfill) and
 * `scripts/seed-example.mjs` (which imports this module's built output)
 * both call it, so the kit and the seed can't drift from each other the way
 * the seed's old hand-rolled HTML drifted from the style contract.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CANVAS_INDEX } from "../shared/types.js";

export type CanvasNodeKind = "entry" | "step" | "pause" | "terminal-success" | "terminal-warn";
export type CanvasEdgeKind = "sequential" | "branching" | "signal" | "handoff";

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  label: string;
  sublabel?: string;
}

export interface CanvasEdge {
  /** Within a graph's own `edges` (kind sequential/branching): a node id in
   *  that same graph. Within top-level `interconnections` (kind
   *  signal/handoff): `"graphId.nodeId"`, or the literal string `"external"`
   *  for something outside every tracked workflow (an upstream trigger, an
   *  out-of-band human handoff, etc). */
  from: string;
  to: string;
  kind: CanvasEdgeKind;
  label?: string;
}

export interface CanvasStat {
  label: string;
  value: string | number;
}

export interface CanvasGraph {
  id: string;
  title: string;
  subtitle?: string;
  badges?: string[];
  stats?: CanvasStat[];
  nodes: CanvasNode[];
  /** Structural edges only (kind sequential/branching) — cross-workflow
   *  edges belong in the top-level `interconnections`, not here. */
  edges: CanvasEdge[];
}

export interface CanvasData {
  version: 1;
  generatedAt?: string;
  graphs: CanvasGraph[];
  /** Cross-workflow edges (kind signal/handoff) and workspace-boundary notes
   *  (upstream triggers, out-of-band handoffs) — omit entirely for a single
   *  standalone workflow with nothing external to say. */
  interconnections?: CanvasEdge[];
  note?: string;
}

/** Terse enough to ride inline in the generated file (an LLM reading the
 *  file to update it sees this immediately above the data it's editing) —
 *  full prose lives only here and in this module's own doc comment above. */
const SCHEMA_COMMENT = `<!--
  canvas-data schema (edit ONLY the JSON below — never this comment, the
  CSS, or the renderer script):

  {
    "version": 1,
    "graphs": [{
      "id": "slug", "title": "...", "subtitle"?: "...", "badges"?: ["..."],
      "stats"?: [{ "label": "...", "value": "..."|0 }],
      "nodes": [{ "id": "...", "kind": entry|step|pause|terminal-success|terminal-warn,
                   "label": "...", "sublabel"?: "..." }],
      "edges": [{ "from": "nodeId", "to": "nodeId", "kind": sequential|branching, "label"?: "..." }]
    }],
    "interconnections"?: [{ "from": "graphId.nodeId"|"external", "to": "graphId.nodeId"|"external",
                             "kind": signal|handoff, "label": "..." }],
    "note"?: "..."
  }

  One graph per workflow. A single bound workflow -> one graph, no
  interconnections. Unbound / "visualize everything" -> one graph per
  workflow in .sapiom/harness-context.json, plus interconnections showing
  how they hand off/signal to each other (or omit interconnections if this
  is genuinely a standalone workflow with nothing external).
-->`;

/** Dropped in at session create/resume, before any agent has run the
 *  visualize macro — a friendly empty state, not an error. */
export const EMPTY_CANVAS_DATA: CanvasData = {
  version: 1,
  graphs: [],
  note: 'Nothing visualized yet — run the "Visualize" action on a workflow, or ask your agent to visualize one.',
};

const RENDERER_SCRIPT = `
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("canvas-data").textContent);
  var root = document.getElementById("canvas-root");

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs || {}) node.setAttribute(k, attrs[k]);
    return node;
  }

  var NODE_KIND_LABEL = {
    entry: "entry / active step",
    step: "step",
    pause: "pause / waits for input",
    "terminal-success": "terminal \\u00b7 success",
    "terminal-warn": "terminal \\u00b7 escalation",
  };

  // Layered top-to-bottom layout over the graph's own sequential/branching
  // edges. Longest-path-from-roots layering (Kahn's algorithm variant) —
  // robust to diamonds (reconverging branches) and defensively terminates
  // on a cycle instead of looping forever (rare for a workflow graph, but
  // an LLM-authored data file is not guaranteed acyclic).
  function computeLayers(nodes, edges) {
    var ids = nodes.map(function (n) { return n.id; });
    var indeg = {};
    var adj = {};
    ids.forEach(function (id) { indeg[id] = 0; adj[id] = []; });
    edges.forEach(function (e) {
      if (!(e.from in adj) || !(e.to in indeg)) return;
      adj[e.from].push(e.to);
      indeg[e.to] += 1;
    });
    var layer = {};
    var queue = ids.filter(function (id) { return indeg[id] === 0; });
    queue.forEach(function (id) { layer[id] = 0; });
    var seen = {};
    queue.forEach(function (id) { seen[id] = true; });
    var iterations = 0;
    var maxIterations = ids.length * 2 + 2;
    while (queue.length && iterations++ < maxIterations) {
      var next = [];
      queue.forEach(function (id) {
        (adj[id] || []).forEach(function (child) {
          var candidate = layer[id] + 1;
          if (!(child in layer) || candidate > layer[child]) layer[child] = candidate;
          if (!seen[child]) { seen[child] = true; next.push(child); }
        });
      });
      queue = next;
    }
    var maxLayer = 0;
    for (var id2 in layer) if (layer[id2] > maxLayer) maxLayer = layer[id2];
    ids.forEach(function (id3) { if (!(id3 in layer)) layer[id3] = maxLayer + 1; });
    return layer;
  }

  var NODE_W = 176, NODE_H = 56, LAYER_GAP = 96, COL_GAP = 32, MARGIN = 40;

  function layoutGraph(graph) {
    var layer = computeLayers(graph.nodes, graph.edges);
    var byLayer = {};
    graph.nodes.forEach(function (n) {
      var l = layer[n.id];
      (byLayer[l] = byLayer[l] || []).push(n.id);
    });
    var layers = Object.keys(byLayer).map(Number).sort(function (a, b) { return a - b; });
    var maxCols = layers.reduce(function (m, l) { return Math.max(m, byLayer[l].length); }, 1);
    var width = MARGIN * 2 + maxCols * NODE_W + (maxCols - 1) * COL_GAP;
    var pos = {};
    layers.forEach(function (l) {
      var idsInLayer = byLayer[l];
      var rowWidth = idsInLayer.length * NODE_W + (idsInLayer.length - 1) * COL_GAP;
      var startX = (width - rowWidth) / 2;
      idsInLayer.forEach(function (id, i) {
        pos[id] = {
          x: startX + i * (NODE_W + COL_GAP),
          y: MARGIN + l * (NODE_H + LAYER_GAP),
        };
      });
    });
    var height = MARGIN * 2 + (layers.length - 1) * (NODE_H + LAYER_GAP) + NODE_H;
    return { pos: pos, width: width, height: Math.max(height, MARGIN * 2 + NODE_H) };
  }

  function nodeStrokeVar(kind) {
    if (kind === "terminal-success") return "var(--canvas-success)";
    if (kind === "terminal-warn") return "var(--canvas-escalation)";
    if (kind === "entry") return "var(--canvas-accent)";
    if (kind === "pause") return "var(--canvas-text-dim)";
    return "var(--canvas-border-strong)";
  }

  function edgeColorForTarget(nodesById, edge) {
    var target = nodesById[edge.to];
    if (target && target.kind === "terminal-success") return "var(--canvas-success)";
    if (target && target.kind === "terminal-warn") return "var(--canvas-escalation)";
    return "var(--canvas-border-strong)";
  }

  function renderGraph(graph, defs) {
    var layout = layoutGraph(graph);
    var nodesById = {};
    graph.nodes.forEach(function (n) { nodesById[n.id] = n; });

    var svg = svgEl("svg", {
      viewBox: "0 0 " + layout.width + " " + layout.height,
      class: "canvas-graph-svg",
    });
    svg.appendChild(defs.cloneNode(true));

    var usedKinds = {};

    graph.edges.forEach(function (edge) {
      var from = layout.pos[edge.from], to = layout.pos[edge.to];
      if (!from || !to) return;
      usedKinds[edge.kind] = true;
      var x1 = from.x + NODE_W / 2, y1 = from.y + NODE_H;
      var x2 = to.x + NODE_W / 2, y2 = to.y;
      var d;
      if (edge.kind === "branching") {
        var midY = (y1 + y2) / 2;
        d = "M" + x1 + "," + y1 + " C" + x1 + "," + midY + " " + x2 + "," + midY + " " + x2 + "," + y2;
      } else {
        d = "M" + x1 + "," + y1 + " L" + x2 + "," + y2;
      }
      var color = edgeColorForTarget(nodesById, edge);
      svg.appendChild(svgEl("path", {
        d: d, class: "canvas-edge", stroke: color, "marker-end": "url(#canvas-arrow)",
      }));
      if (edge.label) {
        // Anchored near the branch point, not the path's geometric midpoint:
        // two diverging branches share the same origin and (usually) the
        // same destination row, so their midpoints can land close enough
        // together that long labels overlap. Placing each label just below
        // the origin, offset toward its own destination and anchored
        // outward (away from the other branch), keeps them apart as soon as
        // the paths start to diverge instead of waiting for their far ends.
        var dx = x2 - x1;
        var anchor = dx > 4 ? "start" : dx < -4 ? "end" : "middle";
        var labelX = x1 + (dx > 0 ? 10 : dx < 0 ? -10 : 0);
        svg.appendChild(svgEl("text", {
          x: labelX, y: y1 + 20, class: "canvas-edge-label", "text-anchor": anchor,
        })).textContent = edge.label;
      }
    });

    graph.nodes.forEach(function (node) {
      var p = layout.pos[node.id];
      if (!p) return;
      usedKinds[node.kind] = true;
      var g = svgEl("g", {
        transform: "translate(" + p.x + "," + p.y + ")", filter: "url(#canvas-glow)",
      });
      g.appendChild(svgEl("rect", {
        width: NODE_W, height: NODE_H, rx: 14, class: "canvas-node-rect",
        stroke: nodeStrokeVar(node.kind),
        "stroke-dasharray": node.kind === "pause" ? "5 4" : "none",
      }));
      var title = svgEl("text", { x: NODE_W / 2, y: node.sublabel ? 22 : NODE_H / 2, class: "canvas-node-title" });
      title.textContent = node.label;
      g.appendChild(title);
      if (node.sublabel) {
        var sub = svgEl("text", { x: NODE_W / 2, y: 40, class: "canvas-node-sub" });
        sub.textContent = node.sublabel;
        g.appendChild(sub);
      }
      svg.appendChild(g);
    });

    return { svg: svg, usedKinds: usedKinds };
  }

  function legendFor(usedNodeKinds, usedEdgeKinds) {
    var items = [];
    var kindOrder = ["entry", "step", "pause", "terminal-success", "terminal-warn"];
    kindOrder.forEach(function (k) {
      if (!usedNodeKinds[k]) return;
      var marker = el("span", { class: "canvas-legend-marker canvas-legend-marker-" + k });
      items.push(el("span", { class: "canvas-legend-item" }, [marker, document.createTextNode(NODE_KIND_LABEL[k])]));
    });
    if (usedEdgeKinds.signal || usedEdgeKinds.handoff) {
      var marker2 = el("span", { class: "canvas-legend-marker canvas-legend-marker-cross" });
      items.push(el("span", { class: "canvas-legend-item" }, [marker2, document.createTextNode("cross-workflow signal/handoff")]));
    }
    return el("div", { class: "canvas-legend" }, items);
  }

  function renderInterconnections(data) {
    var conns = data.interconnections || [];
    if (!conns.length) return null;
    var nodesById = {};
    (data.graphs || []).forEach(function (g) {
      g.nodes.forEach(function (n) { nodesById[g.id + "." + n.id] = n; });
    });
    function displayFor(ref) {
      if (ref === "external") return "external";
      var node = nodesById[ref];
      return node ? node.label : ref;
    }
    var rows = conns.map(function (c) {
      var dotClass = c.kind === "handoff" ? "canvas-legend-marker-terminal-warn" : "canvas-legend-marker-entry";
      return el("div", { class: "canvas-interconnection-row" }, [
        el("span", { class: "canvas-legend-marker " + dotClass }),
        el("span", { class: "canvas-interconnection-title", text: displayFor(c.from) + " \\u2192 " + displayFor(c.to) }),
        el("span", { class: "canvas-interconnection-tag", text: c.kind }),
        c.label ? el("p", { class: "canvas-interconnection-desc", text: c.label }) : null,
      ]);
    });
    return el("section", { class: "canvas-panel canvas-interconnections" }, [
      el("h2", { class: "canvas-panel-title", text: "Interconnections" }),
    ].concat(rows));
  }

  function buildDefs() {
    var defs = svgEl("defs", {});
    var arrow = svgEl("marker", {
      id: "canvas-arrow", viewBox: "0 0 10 10", refX: "8", refY: "5",
      markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse",
    });
    arrow.appendChild(svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "canvas-arrow-fill" }));
    defs.appendChild(arrow);
    var filter = svgEl("filter", { id: "canvas-glow", x: "-40%", y: "-40%", width: "180%", height: "180%" });
    filter.appendChild(svgEl("feDropShadow", {
      dx: "0", dy: "0", stdDeviation: "3", "flood-color": "var(--canvas-accent)", "flood-opacity": "0.18",
    }));
    defs.appendChild(filter);
    return defs;
  }

  function render() {
    root.textContent = "";
    var defs = buildDefs();

    if (!DATA.graphs || !DATA.graphs.length) {
      root.appendChild(el("div", { class: "canvas-empty" }, [
        el("p", { class: "canvas-empty-text", text: DATA.note || "Nothing visualized yet." }),
      ]));
      return;
    }

    var allUsedNodeKinds = {}, allUsedEdgeKinds = {};

    DATA.graphs.forEach(function (graph) {
      var header = el("header", { class: "canvas-header" }, [
        el("div", { class: "canvas-title-row" }, [
          el("h1", { class: "canvas-title", text: graph.title }),
        ].concat((graph.badges || []).map(function (b) {
          return el("span", { class: "canvas-badge", text: b });
        }))),
        graph.subtitle ? el("p", { class: "canvas-subtitle", text: graph.subtitle }) : null,
        (graph.stats && graph.stats.length) ? el("div", { class: "canvas-stats" },
          graph.stats.map(function (s) {
            return el("div", { class: "canvas-stat" }, [
              el("span", { class: "canvas-stat-value", text: String(s.value) }),
              el("span", { class: "canvas-stat-label", text: s.label }),
            ]);
          })) : null,
      ]);

      var rendered = renderGraph(graph, defs);
      for (var k in rendered.usedKinds) {
        if (["sequential", "branching", "signal", "handoff"].indexOf(k) !== -1) allUsedEdgeKinds[k] = true;
        else allUsedNodeKinds[k] = true;
      }

      var panel = el("section", { class: "canvas-panel" }, [
        header,
        el("div", { class: "canvas-diagram-panel" }, [rendered.svg]),
      ]);
      root.appendChild(panel);
    });

    (DATA.interconnections || []).forEach(function (c) { allUsedEdgeKinds[c.kind] = true; });

    var interconnections = renderInterconnections(DATA);
    if (interconnections) root.appendChild(interconnections);

    root.appendChild(el("footer", { class: "canvas-footer" }, [
      legendFor(allUsedNodeKinds, allUsedEdgeKinds),
      el("p", { class: "canvas-note", text: DATA.note || "Static preview \\u2014 regenerate after the workflow changes." }),
    ]));
  }

  render();
})();
`.trim();

function themeStyleBlock(): string {
  // Values ported 1:1 from web/src/styles.css's :root (light, default) and
  // [data-theme="dark"] tokens — kept in sync by eye; see this module's own
  // doc comment. "Dark" is also this canvas kit's own fallback default
  // (prefers-color-scheme: no-preference / light-unsupported browsers)
  // since it's the app's own default canvas look before per-theme passthrough
  // landed for embedded iframes.
  return `
:root {
  --canvas-bg: #f3f4f6;
  --canvas-panel: #f5f5f5;
  --canvas-border: #e5e5e5;
  --canvas-border-strong: #d4d4d8;
  --canvas-text: #1a1a1a;
  --canvas-text-dim: #737373;
  --canvas-accent: #05a9bc;
  --canvas-success: #05a9bc;
  --canvas-escalation: #b45309;
  --canvas-failure: #ef4444;
}
:root[data-canvas-theme="dark"] {
  --canvas-bg: #0f0f0f;
  --canvas-panel: #1a1a1a;
  --canvas-border: #2e2e2e;
  --canvas-border-strong: #3a3a3a;
  --canvas-text: #fafafa;
  --canvas-text-dim: #a1a1aa;
  --canvas-accent: #6be195;
  --canvas-success: #6be195;
  --canvas-escalation: #f59e0b;
  --canvas-failure: #f87171;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-canvas-theme]) {
    --canvas-bg: #0f0f0f;
    --canvas-panel: #1a1a1a;
    --canvas-border: #2e2e2e;
    --canvas-border-strong: #3a3a3a;
    --canvas-text: #fafafa;
    --canvas-text-dim: #a1a1aa;
    --canvas-accent: #6be195;
    --canvas-success: #6be195;
    --canvas-escalation: #f59e0b;
    --canvas-failure: #f87171;
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0; min-height: 100%; background: var(--canvas-bg); color: var(--canvas-text);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
#canvas-root { max-width: 1100px; margin: 0 auto; padding: 24px 20px; display: flex; flex-direction: column; gap: 18px; }
.canvas-panel { background: var(--canvas-panel); border: 1px solid var(--canvas-border); border-radius: 16px; padding: 20px; }
.canvas-header { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
.canvas-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.canvas-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.canvas-badge {
  font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--canvas-border-strong);
  color: var(--canvas-text-dim);
}
.canvas-subtitle { margin: 0; color: var(--canvas-text-dim); font-size: 12.5px; }
.canvas-stats { display: flex; gap: 22px; margin-top: 2px; }
.canvas-stat { display: flex; flex-direction: column; }
.canvas-stat-value { font-size: 17px; font-weight: 600; }
.canvas-stat-label { font-size: 10px; color: var(--canvas-text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
.canvas-diagram-panel { overflow-x: auto; }
.canvas-graph-svg { display: block; width: 100%; height: auto; }
.canvas-node-rect { fill: var(--canvas-panel); stroke-width: 1.5; }
.canvas-node-title { fill: var(--canvas-text); font-size: 13px; font-weight: 600; text-anchor: middle; dominant-baseline: middle; }
.canvas-node-sub { fill: var(--canvas-text-dim); font-size: 9.5px; text-anchor: middle; dominant-baseline: middle; }
.canvas-edge { fill: none; stroke-width: 1.8; }
.canvas-edge-label { fill: var(--canvas-text-dim); font-size: 9px; }
.canvas-arrow-fill { fill: var(--canvas-border-strong); }
.canvas-legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--canvas-text-dim); }
.canvas-legend-item { display: flex; align-items: center; gap: 6px; }
.canvas-legend-marker { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
.canvas-legend-marker-entry { background: var(--canvas-accent); }
.canvas-legend-marker-step { border: 1.5px solid var(--canvas-border-strong); background: transparent; }
.canvas-legend-marker-pause { border: 1.5px dashed var(--canvas-text-dim); background: transparent; }
.canvas-legend-marker-terminal-success { background: var(--canvas-success); border-radius: 3px; }
.canvas-legend-marker-terminal-warn { background: var(--canvas-escalation); border-radius: 3px; }
.canvas-legend-marker-cross { border: 1.5px dashed var(--canvas-text-dim); border-radius: 2px; background: transparent; }
.canvas-interconnections { display: flex; flex-direction: column; gap: 12px; }
.canvas-panel-title { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--canvas-text-dim); }
.canvas-interconnection-row { display: grid; grid-template-columns: 12px 1fr auto; column-gap: 8px; row-gap: 2px; align-items: baseline; }
.canvas-interconnection-title { font-weight: 600; font-size: 13px; }
.canvas-interconnection-tag { font-size: 10px; color: var(--canvas-text-dim); border: 1px solid var(--canvas-border-strong); border-radius: 6px; padding: 1px 6px; }
.canvas-interconnection-desc { grid-column: 2 / -1; margin: 0; font-size: 11.5px; color: var(--canvas-text-dim); }
.canvas-footer { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 2px; }
.canvas-note { margin: 0; font-size: 11px; color: var(--canvas-text-dim); font-style: italic; }
.canvas-empty { display: flex; align-items: center; justify-content: center; min-height: 40vh; text-align: center; }
.canvas-empty-text { color: var(--canvas-text-dim); font-size: 13px; max-width: 32em; }
`.trim();
}

/**
 * Renders the full self-contained canvas document for `data`. Theme is read
 * client-side from `?theme=light|dark` (falls back to `prefers-color-scheme`
 * when the query param is absent) — see `themeStyleBlock()`'s
 * `data-canvas-theme` attribute wiring below. No build step, no external
 * requests: every byte needed to render is in this one file.
 */
export function renderCanvasHtml(data: CanvasData): string {
  const json = JSON.stringify(data, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sapiom workflow canvas</title>
<script>
  (function () {
    var params = new URLSearchParams(location.search);
    var theme = params.get("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-canvas-theme", theme);
    }
  })();
</script>
<style>
${themeStyleBlock()}
</style>
</head>
<body>
<div id="canvas-root"></div>
${SCHEMA_COMMENT}
<script type="application/json" id="canvas-data">
${json}
</script>
<script>
${RENDERER_SCRIPT}
</script>
</body>
</html>
`;
}

/**
 * Backfill-only: writes the empty-state canvas template to
 * `<cwd>/.sapiom/canvas/index.html` if (and only if) nothing is there yet —
 * never clobbers a file an earlier session or the visualize macro already
 * populated. Called from SessionManager's create()/resume() (see its
 * `ensureCanvasTemplate` option) so the canvas pane never opens to a
 * completely empty iframe. Best-effort, like the sibling
 * `workspace-context.ts` writer: a session's cwd could be unwritable, and
 * that must never fail session creation itself.
 */
export async function ensureCanvasTemplate(cwd: string): Promise<void> {
  const filePath = path.join(cwd, CANVAS_INDEX);
  try {
    await fs.access(filePath);
    return;
  } catch {
    // Doesn't exist yet — fall through and write it.
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, renderCanvasHtml(EMPTY_CANVAS_DATA), "utf8");
  } catch (err) {
    console.error(`[harness] failed to write canvas template ${filePath}:`, err);
  }
}
