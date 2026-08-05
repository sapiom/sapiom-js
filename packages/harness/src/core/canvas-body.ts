/**
 * Assembles the `<div id="canvas-root">` body — the bound workflow's
 * `<section class="canvas-panel">` (title/summary header + SVG diagram),
 * entirely from the classes `core/canvas-template.ts`'s shell already defines.
 * This is the HTML half of the deterministic render; `core/canvas-render.ts`
 * wraps the result through `renderCanvasDocument()` and writes it to the
 * workflow's render file.
 *
 * The panel ends with the color/shape legend (only the node kinds actually
 * used, plus a cross-workflow row when relevant) so the diagram reads on its
 * own. It sits at the bottom of `#canvas-root` INSIDE the iframe — safe from
 * the SPA's floating zoom/fit controls because the pane reserves a strip below
 * the iframe for them (see `.canvas-visual { padding-bottom }` in
 * web/src/styles.css), so the two never sit "l'un sur l'autre". The only thing
 * deliberately dropped is the old prose footer note ("Static preview —
 * regenerate…"), which was pure noise.
 */
import type { CanvasEdgeKind, CanvasGraph, CanvasNodeKind } from "./canvas-graph.js";
import type { CanvasEnrichment } from "./canvas-enrichment.js";
import { renderGraphSvg, usedKinds } from "./canvas-svg.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface WorkflowPanelMeta {
  title: string;
  badges?: string[];
}

const NODE_KIND_LABEL: Record<CanvasNodeKind, string> = {
  entry: "entry / active step",
  step: "step",
  pause: "pause / waits for input",
  "terminal-success": "terminal · success",
  "terminal-warn": "terminal · escalation",
  "launched-workflow": "launches another agent",
};

const NODE_KIND_ORDER: CanvasNodeKind[] = [
  "entry",
  "step",
  "pause",
  "terminal-success",
  "terminal-warn",
  "launched-workflow",
];

/**
 * The color/shape key for one diagram: only the node kinds that actually appear
 * (in stable order), plus a cross-workflow row when the graph has cross edges.
 * Returns "" when nothing is worth keying, so the panel omits the footer.
 */
export function buildLegendHtml(nodeKinds: Set<CanvasNodeKind>, edgeKinds: Set<CanvasEdgeKind>): string {
  const items = NODE_KIND_ORDER.filter((k) => nodeKinds.has(k)).map(
    (k) =>
      `<span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--${k}"></span>${NODE_KIND_LABEL[k]}</span>`,
  );
  if (edgeKinds.has("cross")) {
    items.push(
      `<span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--cross"></span>cross-agent signal/handoff</span>`,
    );
  }
  if (items.length === 0) return "";
  return `<footer class="canvas-legend">${items.join("")}</footer>`;
}

/**
 * Serializes the graph (enrichment merged) into the JSON payload the app's
 * Steps tab / inspector consumes, embedded as a `<script id="sapiom-graph">`
 * data block that `bootCanvasGraph` (canvas-run-state.ts) posts to the parent.
 *
 * The projection mirrors `renderGraphSvg`'s merge EXACTLY so the Steps tab and
 * the drawn board never disagree: `role` = the node's sublabel (enrichment
 * override first), `description` = the enrichment hover text, and each edge's
 * `label` is keyed `from->to`. Web-only fields the server graph doesn't carry
 * (timeout / input schema / capabilities) are omitted — `parseCanvasGraph`
 * defaults them, so the drill-down degrades to names + roles + branch facts.
 *
 * `<` is escaped to `<` so a label containing `</script>` can't break out
 * of the JSON block; the result is still valid JSON.
 */
function buildGraphPayload(graph: CanvasGraph, enrichment?: CanvasEnrichment | null): string {
  const payload = {
    name: graph.manifestName,
    entry: graph.entry,
    nodes: graph.nodes.map((n) => {
      const details = enrichment?.nodeDetails?.[n.id];
      return {
        id: n.id,
        kind: n.kind,
        label: n.label,
        role: details?.sublabel ?? n.sublabel ?? "",
        // Manifest-authored description (Option A) wins; enrichment is the
        // legacy fallback (currently always undefined).
        description: details?.description ?? n.description ?? "",
        inputSchema: n.inputSchema ?? null,
        capabilities: n.capabilities ?? [],
        timeoutMs: n.timeoutMs ?? null,
      };
    }),
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: enrichment?.edgeLabels?.[`${e.from}->${e.to}`] ?? e.label ?? "",
    })),
    warnings: graph.warnings,
  };
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

/** The workflow-level overview the Canvas tab's bottom panel shows: a
 *  deterministic stats line ("N steps · M exits · <entry> entry"), the shape
 *  summary as the description, and the graph's validation notes. Embedded as a
 *  JSON data block (read by bootCanvasOverview), the same pattern as the step
 *  graph — everything here is derived from the graph, no LLM. */
function buildOverviewPayload(graph: CanvasGraph, enrichment?: CanvasEnrichment | null): string {
  const exits = graph.nodes.filter(
    (n) => n.kind === "terminal-success" || n.kind === "terminal-warn",
  ).length;
  const steps = graph.nodes.filter(
    (n) =>
      n.kind !== "terminal-success" &&
      n.kind !== "terminal-warn" &&
      n.kind !== "launched-workflow",
  ).length;
  const entryLabel = graph.nodes.find((n) => n.id === graph.entry)?.label ?? graph.entry;
  const parts = [`${steps} ${steps === 1 ? "step" : "steps"}`];
  if (exits > 0) parts.push(`${exits} ${exits === 1 ? "exit" : "exits"}`);
  if (entryLabel) parts.push(`${entryLabel} entry`);
  const overview = {
    // Human-authored workflow description from the manifest (Option A); "" when
    // the workflow declares none (the shape summary still renders on the board).
    description: graph.description ?? "",
    stats: parts.join(" · "),
    notes: enrichment?.notes ?? [],
  };
  // JSON in a <script> block: neutralize any "</script>"/"<" in derived text.
  return JSON.stringify(overview).replace(/</g, "\\u003c");
}

/** One workflow's full panel: title/badges + summary header and the SVG
 *  diagram, with the deterministic enrichment merged in (summary line and
 *  node/edge annotations), plus the embedded step-graph payload the Steps tab
 *  reads. */
export function buildWorkflowPanelHtml(
  graph: CanvasGraph,
  meta: WorkflowPanelMeta,
  enrichment?: CanvasEnrichment | null,
): string {
  const badges = (meta.badges ?? [])
    .map((b) => `<span class="canvas-badge">${esc(b)}</span>`)
    .join("");
  const warningBadge =
    graph.warnings.length > 0
      ? `<span class="canvas-badge">${graph.warnings.length} warning${graph.warnings.length === 1 ? "" : "s"}</span>`
      : "";
  const summary = enrichment?.summary ? `\n    <p class="canvas-subtitle">${esc(enrichment.summary)}</p>` : "";
  const used = usedKinds(graph);
  const legend = buildLegendHtml(used.nodeKinds, used.edgeKinds);
  const legendHtml = legend ? `\n  ${legend}` : "";
  const graphData = buildGraphPayload(graph, enrichment);
  const overviewData = buildOverviewPayload(graph, enrichment);
  return `<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">${esc(meta.title)}</h1>
      ${badges}${warningBadge}
    </div>${summary}
  </header>
  <div class="canvas-diagram-panel">
${renderGraphSvg(graph, enrichment)}
  </div>${legendHtml}
  <script type="application/json" id="sapiom-graph">${graphData}</script>
  <script type="application/json" id="sapiom-overview">${overviewData}</script>
</section>`;
}

/** A degraded panel for a workflow whose graph couldn't be extracted — never
 *  a crash, never a silent fallback to the LLM path, just an honest reason
 *  styled through the same shell. */
export function buildErrorPanelHtml(title: string, reason: string): string {
  const errorData = JSON.stringify({ title, reason }).replace(/</g, "\\u003c");
  return `<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">${esc(title)}</h1>
      <span class="canvas-badge">render failed</span>
    </div>
  </header>
  <div class="canvas-diagram-panel">
    <p class="canvas-empty-note">Could not extract this agent's step graph: ${esc(reason)}. Use the workbench actions to ask your coding agent to fix it or retry the deterministic render.</p>
  </div>
  <script type="application/json" id="sapiom-render-error">${errorData}</script>
</section>`;
}

/** A calm, transient panel for a workflow whose dependencies aren't installed
 *  yet (a freshly scaffolded project between `scaffold` and `npm install`).
 *  Extraction WOULD fail here with esbuild "Could not resolve …" noise, so we
 *  don't run it — we show this instead and let the install watcher re-render
 *  once `node_modules` lands. Crucially it emits NO `#sapiom-render-error`
 *  script, so the SPA shows no "render failed" card / Retry buttons: this is a
 *  normal setup state, not an error the user has to act on. */
export function buildPreparingPanelHtml(title: string): string {
  return `<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">${esc(title)}</h1>
      <span class="canvas-badge">preparing</span>
    </div>
  </header>
  <div class="canvas-diagram-panel">
    <p class="canvas-empty-note">Preparing your agent — installing dependencies. The step graph appears here automatically once setup finishes.</p>
  </div>
</section>`;
}

/** Joins the workflow panel(s) into the final `#canvas-root` body — the string
 *  `renderCanvasDocument()` wraps. Each panel already carries its own legend
 *  footer (see `buildWorkflowPanelHtml`); there is no document-level footer. */
export function assembleCanvasBody(input: { panels: string[] }): string {
  return input.panels.join("\n\n");
}
