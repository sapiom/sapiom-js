/**
 * Canvas kit: a prewritten template — CSS (light + dark, following the
 * app's own theme) and a documented set of markup building blocks — that an
 * agent clones and fills in with real content, instead of hand-writing a
 * canvas from scratch every time. This is deliberately NOT a JSON-data +
 * JS-renderer scheme: the agent authors real HTML/SVG using the template's
 * classes, so it keeps full expressive freedom over the graph itself while
 * the CSS (and therefore the visual language: colors, glow, edge styling,
 * legend markers) is locked and can't drift.
 *
 * `renderCanvasDocument(bodyHtml)` is the single shared shell (CSS + theme
 * switch) — `TEMPLATE_HTML` (the pristine, empty-state document) and
 * `scripts/seed-example.mjs` (prefilled with real content) both wrap their
 * body through it, so the kit and the seed can't drift from each other.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CANVAS_DIR, CANVAS_INDEX } from "../shared/types.js";

/** Lives alongside index.html, in the same CANVAS_DIR — a pristine copy of
 *  the template, written once and never touched again, so "clone the
 *  template" always has a clean, un-filled-in source to clone from. */
export const CANVAS_TEMPLATE_FILE = `${CANVAS_DIR}/_template.html`;

function themeStyleBlock(): string {
  // Values ported 1:1 from web/src/styles.css's :root (light, default) and
  // [data-theme="dark"] tokens — kept in sync by eye; see this module's own
  // doc comment. Dark is also this canvas kit's own fallback default
  // (prefers-color-scheme: no-preference) since it's the app's own default
  // canvas look before per-theme passthrough landed for embedded iframes.
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

/* --- structural classes: keep these, and their names, untouched --- */
.canvas-panel { background: var(--canvas-panel); border: 1px solid var(--canvas-border); border-radius: 16px; padding: 20px; }
.canvas-header { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
.canvas-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.canvas-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.canvas-badge {
  font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--canvas-border-strong);
  color: var(--canvas-text-dim);
}
.canvas-badge--stale { color: var(--canvas-escalation); border-color: var(--canvas-escalation); }
.canvas-subtitle { margin: 0; color: var(--canvas-text-dim); font-size: 12.5px; }
.canvas-stats { display: flex; gap: 22px; margin-top: 2px; }
.canvas-stat { display: flex; flex-direction: column; }
.canvas-stat-value { font-size: 17px; font-weight: 600; }
.canvas-stat-label { font-size: 10px; color: var(--canvas-text-dim); text-transform: uppercase; letter-spacing: 0.06em; }
.canvas-diagram-panel { overflow-x: auto; }
.canvas-empty-note { color: var(--canvas-text-dim); font-size: 13px; text-align: center; padding: 60px 20px; margin: 0; }
.canvas-graph-svg { display: block; width: 100%; height: auto; }

/* --- node kinds: entry | step | pause | terminal-success | terminal-warn | launched-workflow --- */
.canvas-node .canvas-node-rect { fill: var(--canvas-panel); stroke-width: 1.5; stroke: var(--canvas-border-strong); }
.node--entry .canvas-node-rect { stroke: var(--canvas-accent); }
.node--pause .canvas-node-rect { stroke: var(--canvas-text-dim); stroke-dasharray: 5 4; }
.node--terminal-success .canvas-node-rect { stroke: var(--canvas-success); }
.node--terminal-warn .canvas-node-rect { stroke: var(--canvas-escalation); }
.node--launched-workflow .canvas-node-rect { stroke: var(--canvas-accent); stroke-dasharray: 5 4; }
.canvas-node-title { fill: var(--canvas-text); font-size: 13px; font-weight: 600; text-anchor: middle; dominant-baseline: middle; }
.canvas-node-sub { fill: var(--canvas-text-dim); font-size: 9.5px; text-anchor: middle; dominant-baseline: middle; }

/* --- enrichment layout hints: group bands sit behind edges and nodes --- */
.canvas-group-band { fill: var(--canvas-accent); fill-opacity: 0.06; stroke: var(--canvas-border); stroke-dasharray: 3 5; }
.canvas-group-label { fill: var(--canvas-text-dim); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }

/* --- edge kinds: sequential (base) | branching (--success/--warn) | cross-workflow signal/handoff (--cross) --- */
.canvas-edge { fill: none; stroke-width: 1.8; stroke: var(--canvas-border-strong); }
.canvas-edge--success { stroke: var(--canvas-success); }
.canvas-edge--warn { stroke: var(--canvas-escalation); }
.canvas-edge--cross { stroke: var(--canvas-text-dim); stroke-dasharray: 4 4; }
.canvas-edge--launch { stroke: var(--canvas-accent); stroke-dasharray: 4 4; }
.canvas-edge-label { fill: var(--canvas-text-dim); font-size: 9px; }
.canvas-arrow-fill { fill: var(--canvas-border-strong); }
.canvas-arrow-fill--success { fill: var(--canvas-success); }
.canvas-arrow-fill--warn { fill: var(--canvas-escalation); }

/* --- legend + interconnections --- */
.canvas-legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--canvas-text-dim); }
.canvas-legend-item { display: flex; align-items: center; gap: 6px; }
.canvas-legend-marker { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
.canvas-legend-marker--entry { background: var(--canvas-accent); }
.canvas-legend-marker--step { border: 1.5px solid var(--canvas-border-strong); background: transparent; }
.canvas-legend-marker--pause { border: 1.5px dashed var(--canvas-text-dim); background: transparent; }
.canvas-legend-marker--terminal-success { background: var(--canvas-success); border-radius: 3px; }
.canvas-legend-marker--terminal-warn { background: var(--canvas-escalation); border-radius: 3px; }
.canvas-legend-marker--cross { border: 1.5px dashed var(--canvas-text-dim); border-radius: 2px; background: transparent; }
.canvas-legend-marker--launched-workflow { border: 1.5px dashed var(--canvas-accent); border-radius: 3px; background: transparent; }
.canvas-interconnections { display: flex; flex-direction: column; gap: 12px; }
.canvas-panel-title { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--canvas-text-dim); }
.canvas-interconnection-row { display: grid; grid-template-columns: 12px 1fr auto; column-gap: 8px; row-gap: 2px; align-items: baseline; }
.canvas-interconnection-title { font-weight: 600; font-size: 13px; }
.canvas-interconnection-tag { font-size: 10px; color: var(--canvas-text-dim); border: 1px solid var(--canvas-border-strong); border-radius: 6px; padding: 1px 6px; }
.canvas-interconnection-desc { grid-column: 2 / -1; margin: 0; font-size: 11.5px; color: var(--canvas-text-dim); }
.canvas-footer { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 2px; }
.canvas-note { margin: 0; font-size: 11px; color: var(--canvas-text-dim); font-style: italic; }
.canvas-notes { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--canvas-text-dim); }
.canvas-cross-workflow { margin: 0; font-size: 11.5px; color: var(--canvas-text-dim); }
template { display: none; }
`.trim();
}

/** Reads the current theme from `?theme=light|dark`, falling back to
 *  `prefers-color-scheme` (the CSS `@media` block above) when the param is
 *  absent — the only script in the whole document. */
const THEME_SCRIPT = `
(function () {
  var params = new URLSearchParams(location.search);
  var theme = params.get("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-canvas-theme", theme);
  }
})();
`.trim();

/**
 * One example of every markup building block, inside an inert `<template>`
 * (never rendered, but real parsed DOM — not an HTML comment, so class names
 * with `--` in them are never at risk of being mistaken for a comment
 * terminator). An agent reads this once to learn the exact shape of a node,
 * an edge of each kind, a stat, a badge, a legend item, and an
 * interconnection row, then writes its own real ones using the same classes.
 */
const PATTERNS_TEMPLATE = `
<template id="canvas-patterns">
  <!-- copy the pattern you need; this whole block is never rendered -->
  <span class="canvas-badge">standalone workflow</span>
  <div class="canvas-stat"><span class="canvas-stat-value">5</span><span class="canvas-stat-label">steps</span></div>
  <svg>
    <g class="canvas-node node--entry" filter="url(#canvas-glow)" transform="translate(392,40)">
      <rect class="canvas-node-rect" width="176" height="56" rx="14" />
      <text class="canvas-node-title" x="88" y="24">step_name</text>
      <text class="canvas-node-sub" x="88" y="40">short description</text>
    </g>
    <g class="canvas-node node--step" filter="url(#canvas-glow)" transform="translate(392,150)">
      <rect class="canvas-node-rect" width="176" height="56" rx="14" />
      <text class="canvas-node-title" x="88" y="28">step_name</text>
    </g>
    <g class="canvas-node node--pause" filter="url(#canvas-glow)" transform="translate(392,260)">
      <rect class="canvas-node-rect" width="176" height="56" rx="14" />
      <text class="canvas-node-title" x="88" y="24">step_name</text>
      <text class="canvas-node-sub" x="88" y="40">waits for a human / event</text>
    </g>
    <g class="canvas-node node--terminal-success" filter="url(#canvas-glow)" transform="translate(200,410)">
      <rect class="canvas-node-rect" width="176" height="56" rx="14" />
      <text class="canvas-node-title" x="88" y="24">step_name</text>
      <text class="canvas-node-sub" x="88" y="40">terminate({ resolved: true })</text>
    </g>
    <g class="canvas-node node--terminal-warn" filter="url(#canvas-glow)" transform="translate(600,410)">
      <rect class="canvas-node-rect" width="176" height="56" rx="14" />
      <text class="canvas-node-title" x="88" y="24">step_name</text>
      <text class="canvas-node-sub" x="88" y="40">terminate({ escalated: true })</text>
    </g>
    <!-- sequential: a step with exactly one successor -> straight line -->
    <path class="canvas-edge" d="M480,96 L480,150" marker-end="url(#canvas-arrow)" />
    <!-- branching: a step with multiple successors -> curved, colored by the destination's outcome -->
    <path class="canvas-edge canvas-edge--success" d="M480,320 C480,365 288,365 288,410" marker-end="url(#canvas-arrow-success)" />
    <path class="canvas-edge canvas-edge--warn" d="M480,320 C480,365 688,365 688,410" marker-end="url(#canvas-arrow-warn)" />
    <!-- cross-workflow signal/handoff: dashed, always neutral -->
    <path class="canvas-edge canvas-edge--cross" d="M480,320 L480,410" marker-end="url(#canvas-arrow)" />
    <!-- edge label, positioned near the branch point, anchored toward its own destination -->
    <text class="canvas-edge-label" x="440" y="345" text-anchor="end">category == x</text>
  </svg>
  <div class="canvas-interconnection-row">
    <span class="canvas-legend-marker canvas-legend-marker--entry"></span>
    <span class="canvas-interconnection-title">external -&gt; intake</span>
    <span class="canvas-interconnection-tag">signal</span>
    <p class="canvas-interconnection-desc">an order object enters here</p>
  </div>
  <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--entry"></span>entry / active step</span>
  <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--step"></span>step</span>
  <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--pause"></span>pause / waits for input</span>
  <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--terminal-success"></span>terminal &middot; success</span>
  <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--terminal-warn"></span>terminal &middot; escalation</span>
  <span class="canvas-legend-item"><span class="canvas-legend-marker canvas-legend-marker--cross"></span>cross-workflow signal/handoff</span>
</template>
`.trim();

/** The `<defs>` every SVG graph needs — same glow filter and arrow markers
 *  (default/success/warn) referenced by every node/edge pattern above. */
const SVG_DEFS = `
<svg width="0" height="0" style="position: absolute;">
  <defs>
    <marker id="canvas-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="canvas-arrow-fill" d="M0,0 L10,5 L0,10 z" />
    </marker>
    <marker id="canvas-arrow-success" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="canvas-arrow-fill canvas-arrow-fill--success" d="M0,0 L10,5 L0,10 z" />
    </marker>
    <marker id="canvas-arrow-warn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path class="canvas-arrow-fill canvas-arrow-fill--warn" d="M0,0 L10,5 L0,10 z" />
    </marker>
    <filter id="canvas-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="var(--canvas-accent)" flood-opacity="0.18" />
    </filter>
  </defs>
</svg>
`.trim();

/**
 * Wraps `bodyHtml` in the shared canvas document shell: doctype, the theme
 * switch script, and every CSS class an agent's markup can use. This is the
 * single source both the pristine template and `scripts/seed-example.mjs`'s
 * prefilled instance render through, so they can't drift from each other.
 */
export function renderCanvasDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sapiom workflow canvas</title>
<script>
${THEME_SCRIPT}
</script>
<style>
${themeStyleBlock()}
</style>
</head>
<body>
${SVG_DEFS}
<div id="canvas-root">
${bodyHtml}
</div>
</body>
</html>
`;
}

const TEMPLATE_BODY = `
<!--
  ═══════════════════════════════════════════════════════════════════════
  SAPIOM CANVAS TEMPLATE — fill in the sections below to visualize a
  workflow. Keep the <style> block in <head> and the structural classes
  you see here untouched; only add markup using the patterns in the
  <template id="canvas-patterns"> block near the end of <body> (it is
  never rendered — read it, copy from it, don't edit it). Delete the
  empty-state note below and the patterns template once you're done
  authoring. For a single bound workflow, one canvas-panel is enough; for
  a workspace overview, add one canvas-panel per workflow plus an
  Interconnections panel (see the pattern for its row shape).
  ═══════════════════════════════════════════════════════════════════════
-->
<section class="canvas-panel">
  <header class="canvas-header">
    <div class="canvas-title-row">
      <h1 class="canvas-title">Untitled workflow</h1>
    </div>
    <p class="canvas-subtitle">One-line description of what this workflow does.</p>
    <div class="canvas-stats"></div>
  </header>
  <div class="canvas-diagram-panel">
    <p class="canvas-empty-note">Nothing visualized yet — run Visualize on a workflow.</p>
  </div>
</section>

${PATTERNS_TEMPLATE}
`.trim();

/** The exact document written to both `_template.html` and the initial
 *  `index.html` — a friendly empty state plus the patterns reference. */
export const TEMPLATE_HTML = renderCanvasDocument(TEMPLATE_BODY);

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
    return;
  } catch {
    // Doesn't exist yet — fall through and write it.
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  } catch (err) {
    console.error(`[harness] failed to write canvas file ${filePath}:`, err);
  }
}

/**
 * Backfill-only: ensures both `<cwd>/.sapiom/canvas/_template.html` (a
 * pristine copy, so "clone the template" always has a clean source — see
 * the visualize macro's prompt) and `<cwd>/.sapiom/canvas/index.html` (the
 * live canvas, seeded with the same empty-state content) exist. Never
 * clobbers either file if something's already there — an earlier session,
 * or the agent's own edits. Called from SessionManager's create()/resume()
 * (see its `ensureCanvasTemplate` option) so the canvas pane never opens to
 * a completely empty iframe. Best-effort, like the sibling
 * `workspace-context.ts` writer: a session's cwd could be unwritable, and
 * that must never fail session creation itself.
 */
export async function ensureCanvasTemplate(cwd: string): Promise<void> {
  await writeIfMissing(path.join(cwd, CANVAS_TEMPLATE_FILE), TEMPLATE_HTML);
  await writeIfMissing(path.join(cwd, CANVAS_INDEX), TEMPLATE_HTML);
}
