/**
 * Assembles the `<div id="canvas-root">` body — the bound workflow's
 * `<section class="canvas-panel">` (header + stats + SVG diagram) and a
 * legend footer — entirely from the classes `core/canvas-template.ts`'s shell
 * already defines. This is the HTML half of the deterministic render;
 * `core/canvas-render.ts` wraps the result through `renderCanvasDocument()`
 * and writes it to the workflow's render file.
 */
import type { CanvasEdgeKind, CanvasGraph, CanvasNodeKind } from "./canvas-graph.js";
import { renderGraphSvg } from "./canvas-svg.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface WorkflowPanelMeta {
  title: string;
  badges?: string[];
}

/** One workflow's full panel: title/badges header, step/entry stats, SVG diagram. */
export function buildWorkflowPanelHtml(graph: CanvasGraph, meta: WorkflowPanelMeta): string {
  const badges = (meta.badges ?? [])
    .map((b) => `<span class="canvas-badge">${esc(b)}</span>`)
    .join("");
  const warningBadge =
    graph.warnings.length > 0
      ? `<span class="canvas-badge">${graph.warnings.length} warning${graph.warnings.length === 1 ? "" : "s"}</span>`
      : "";
  return `<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">${esc(meta.title)}</h1>
      ${badges}${warningBadge}
    </div>
    <div class="canvas-stats">
      <div class="canvas-stat"><span class="canvas-stat-value">${graph.nodes.length}</span><span class="canvas-stat-label">steps</span></div>
      <div class="canvas-stat"><span class="canvas-stat-value">${esc(graph.entry)}</span><span class="canvas-stat-label">entry</span></div>
    </div>
  </header>
  <div class="canvas-diagram-panel">
${renderGraphSvg(graph)}
  </div>
</section>`;
}

/** A degraded panel for a workflow whose graph couldn't be extracted — never
 *  a crash, never a silent fallback to the LLM path, just an honest reason
 *  styled through the same shell. */
export function buildErrorPanelHtml(title: string, reason: string): string {
  return `<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">${esc(title)}</h1>
      <span class="canvas-badge">render failed</span>
    </div>
  </header>
  <div class="canvas-diagram-panel">
    <p class="canvas-empty-note">Could not extract this workflow's step graph: ${esc(reason)}. Ask your agent to fix the issue (see the terminal for details) — this pane updates automatically once it builds cleanly.</p>
  </div>
</section>`;
}

const NODE_KIND_LABEL: Record<CanvasNodeKind, string> = {
  entry: "entry / active step",
  step: "step",
  pause: "pause / waits for input",
  "terminal-success": "terminal · success",
  "terminal-warn": "terminal · escalation",
  "launched-workflow": "launches another workflow",
};
const NODE_KIND_ORDER: CanvasNodeKind[] = [
  "entry",
  "step",
  "pause",
  "terminal-success",
  "terminal-warn",
  "launched-workflow",
];

/** Legend footer covering every node/edge kind actually used across every
 *  rendered panel (aggregate, not per-panel — matches the template's shape). */
export function buildLegendHtml(nodeKinds: Set<CanvasNodeKind>, edgeKinds: Set<CanvasEdgeKind>): string {
  const items = NODE_KIND_ORDER.filter((k) => nodeKinds.has(k)).map(
    (k) =>
      `<span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--${k}"></span>${NODE_KIND_LABEL[k]}</span>`,
  );
  if (edgeKinds.has("cross")) {
    items.push(
      `<span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--cross"></span>cross-workflow signal/handoff</span>`,
    );
  }
  return `<div class="canvas-legend">${items.join("")}</div>`;
}

/** Joins panels + a footer (legend + note) into the final `#canvas-root`
 *  body — the string `renderCanvasDocument()` wraps. */
export function assembleCanvasBody(input: { panels: string[]; legend: string; note: string }): string {
  const parts = [...input.panels];
  parts.push(`<footer class="canvas-footer">
${input.legend}
  <p class="canvas-note">${esc(input.note)}</p>
</footer>`);
  return parts.join("\n\n");
}
