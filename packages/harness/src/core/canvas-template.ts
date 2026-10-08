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
 * switch) every board document is wrapped in, so the boards can't drift from
 * each other.
 */

import {
  applyRunStateToCanvas,
  bootCanvasError,
  bootCanvasGraph,
  bootCanvasOverview,
  bootCanvasNodeClicks,
  bootCanvasRunState,
  bootCanvasSelection,
  bootCanvasView,
  runStateNodeClass,
} from "./canvas-run-state.js";

function themeStyleBlock(): string {
  // Values ported 1:1 from web/src/styles.css's :root (light, default) and
  // [data-theme="dark"] tokens — kept in sync by eye; see this module's own
  // doc comment. With no explicit theme, the canvas uses the same light product
  // default as the Studio shell; embedded canvases still receive the shell's
  // current theme explicitly.
  return `
:root {
  /* The whole graph column is the raised "lighter white" (--surface-raised in
     the app) — the dotted board included, so it never reads darker than the
     rail/terminal shell it's meant to sit in front of. */
  --canvas-bg: #ffffff;
  --canvas-panel: #f5f5f5;
  --canvas-border: #e5e5e5;
  --canvas-border-strong: #d4d4d8;
  --canvas-text: #1a1a1a;
  --canvas-text-dim: #737373;
  /* Brand green (Studio light --brand), matching the dark theme's #6be195 — the
     graph accent/success were an off-brand cyan (#05a9bc) in light only. */
  --canvas-accent: #167e3a;
  --canvas-success: #167e3a;
  --canvas-running: #2563eb;
  --canvas-passed: #16a34a;
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
  --canvas-running: #60a5fa;
  --canvas-passed: #4ade80;
  --canvas-escalation: #f59e0b;
  --canvas-failure: #f87171;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; min-height: 100%; background: var(--canvas-bg); color: var(--canvas-text);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
/* Center the rendered card in the pane. The harness posts pan/zoom as a
   transform on #canvas-root (transform-origin: center — see canvas-run-state.ts),
   so a flex-centered body keeps it centered at rest and while scaling: fit-to-view
   (pan 0,0) lands it dead center, and zooming grows from the middle. The body is
   pinned to the viewport (height:100vh, NOT min-height) so a card taller than the
   pane centers within the VISIBLE area — with min-height the body would grow and
   push the card off-screen — and overflow is clipped (pan/zoom navigates instead
   of scrollbars). */
body {
  display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden;
  /* Dotted grid behind the board — matches the studio's demo canvas. */
  background-image: radial-gradient(var(--canvas-border-strong) 1px, transparent 1px);
  background-size: 16px 16px;
}
#canvas-root { max-width: 1100px; padding: 24px 20px; display: flex; flex-direction: column; gap: 18px; }

/* --- structural classes: keep these, and their names, untouched --- */
.canvas-panel { background: transparent; border: 0; padding: 20px; }.canvas-header { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
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
/* Visible, not scrolled: the parent's pan and zoom move the whole card, and a
   board wider than the frame (a column of other agents at its border) must be
   inside what fit-to-view measures (canvas-run-state.ts reports scrollWidth). */
.canvas-diagram-panel { overflow-x: visible; }
.canvas-empty-note { color: var(--canvas-text-dim); font-size: 13px; text-align: center; padding: 60px 20px; margin: 0; }
/* The <svg> carries explicit width/height, so it always renders at its
   NATURAL (1×) size — a narrow single-column graph can never stretch to fill
   the pane (the old width:100% did that, ballooning nodes ~4×). Centered when
   it fits; a graph wider than the pane keeps full size and the parent's
   fit-to-view scales the whole card, staying legible instead of squeezing. */
.canvas-graph-svg { display: block; margin: 0 auto; }

/* --- node kinds: entry | step | pause | terminal-success | terminal-warn | launched-workflow --- */
/* Nodes are clickable — pointer cursor signals this, and a subtle stroke-width bump on hover
   makes the affordance visible without requiring external JS to track hover state. */
.canvas-node { cursor: pointer; }
.canvas-node:hover .canvas-node-rect { stroke-width: 2.5; }
.canvas-node .canvas-node-rect { fill: var(--canvas-panel); stroke-width: 1.5; stroke: var(--canvas-border-strong); }
/* Entry is a POSITION in the graph, not a state: it reads from the card's own
   "entry" caption and from sitting at the top. It carries no accent, so the
   only accented card on the board is the one the inspector is describing. */
.node--entry .canvas-node-rect { stroke: var(--canvas-border-strong); }
.node--pause .canvas-node-rect { stroke: var(--canvas-text-dim); stroke-dasharray: 5 4; }
.node--terminal-success .canvas-node-rect { stroke: var(--canvas-success); }
.node--terminal-warn .canvas-node-rect { stroke: var(--canvas-escalation); }
.node--launched-workflow .canvas-node-rect { stroke: var(--canvas-accent); stroke-dasharray: 5 4; }
.canvas-node-title { fill: var(--canvas-text); font-size: 13px; font-weight: 600; text-anchor: middle; dominant-baseline: middle; }
.canvas-node-sub { fill: var(--canvas-text-dim); font-size: 9.5px; text-anchor: middle; dominant-baseline: middle; }

/* --- enrichment layout hints: group bands sit behind edges and nodes --- */
.canvas-group-band { fill: var(--canvas-accent); fill-opacity: 0.06; stroke: var(--canvas-border); stroke-dasharray: 3 5; }
.canvas-group-label { fill: var(--canvas-text-dim); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; }

/* --- edge kinds: sequential (base) | branching (--success/--warn) | cross-agent signal/handoff (--cross) --- */
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
.canvas-legend-marker--entry { border: 1.5px solid var(--canvas-border-strong); background: transparent; }
.canvas-legend-marker--step { border: 1.5px solid var(--canvas-border-strong); background: transparent; }
.canvas-legend-marker--pause { border: 1.5px dashed var(--canvas-text-dim); background: transparent; }
.canvas-legend-marker--terminal-success { background: var(--canvas-success); border-radius: 3px; }
.canvas-legend-marker--terminal-warn { background: var(--canvas-escalation); border-radius: 3px; }
.canvas-legend-marker--cross { border: 1.5px dashed var(--canvas-text-dim); border-radius: 2px; background: transparent; }
.canvas-legend-marker--launched-workflow { border: 1.5px dashed var(--canvas-accent); border-radius: 3px; background: transparent; }
/* The board is ONLY the graph. Title, badges, summary line, stats and the
   node-kind key are app chrome: the SPA renders them in the overview panel
   around this iframe (canvas-body.ts posts them), so floating a second copy
   over the board would just crowd the diagram. Kept in the markup — hidden,
   not deleted — so the classes stay a stable contract for hand-authored
   documents and the run-state badge still has something to update. */
.canvas-header,
.canvas-legend {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; margin: 0; padding: 0;
}
/* Same reason as the header above, for the failed render. The SPA paints its
   own Render-failed card (short claim, one-line reason, actions, full reason
   behind Details) as a transparent layer directly over this document, so the
   document's copy of the reason drew straight through it (SAP-3199). Embedded,
   the card is the one message and this prose steps aside; opened standalone,
   or embedded in a frame that never took the message over, it stays and is the
   only message. See EMBED_SCRIPT for how the flag is withdrawn in that case. */
:root[data-canvas-embedded] .canvas-render-error-note { display: none; }
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

/* --- live run-state node lighting ---------------------------------------- */
/* Applied by the postMessage listener (canvas-run-state.ts) while a run is
   active. Each step's <g class="canvas-node"> gains one of is-running /
   is-passed / is-failed / is-pending, lighting up its rect in place. */

@keyframes canvas-node-pulse {
  0%, 100% { stroke-opacity: 1; }
  50%       { stroke-opacity: 0.45; }
}

/* running/in-flight: blue, tinted fill, and a pulse so you SEE it working. */
.canvas-node.is-running .canvas-node-rect {
  fill: var(--canvas-running);
  fill-opacity: 0.12;
  stroke: var(--canvas-running);
  stroke-width: 2.5;
  animation: canvas-node-pulse 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .canvas-node.is-running .canvas-node-rect {
    animation: none;
  }
}

/* passed: green box. */
.canvas-node.is-passed .canvas-node-rect {
  fill: var(--canvas-passed);
  fill-opacity: 0.14;
  stroke: var(--canvas-passed);
  stroke-width: 2.5;
}

/* failed: red box. */
.canvas-node.is-failed .canvas-node-rect {
  fill: var(--canvas-failure);
  fill-opacity: 0.14;
  stroke: var(--canvas-failure);
  stroke-width: 2.5;
}

/* pending: dim, so not-yet-run steps read as inactive. */
.canvas-node.is-pending {
  opacity: 0.5;
}

/* --- selection ----------------------------------------------------------- */
/* The card the bottom inspector is describing (canvas-run-state.ts's
   bootCanvasSelection, driven by the parent). A ring plus a faint accent wash,
   so the pick reads at a glance without repainting the node: run-state fill
   still wins on the same rect, and a selected pending node comes back to full
   opacity so the thing you just clicked is never the dimmest card on the
   board. */
.canvas-node.is-selected .canvas-node-rect {
  stroke: var(--canvas-accent);
  stroke-width: 3;
}

.canvas-node.is-selected:not(.is-running):not(.is-passed):not(.is-failed) .canvas-node-rect {
  fill: var(--canvas-accent);
  fill-opacity: 0.1;
}

.canvas-node.is-selected.is-pending {
  opacity: 1;
}

/* Active-run header badge — accent background signals a live run. */
.canvas-badge.canvas-badge--active {
  color: var(--canvas-bg);
  background: var(--canvas-accent);
  border-color: var(--canvas-accent);
}
`.trim();
}

/** Marks the document as embedded so the stylesheet can stand down the chrome
 *  the SPA already draws around the iframe. In the head, so the flag is on the
 *  root element before the body paints and the prose never flashes.
 *
 *  The flag is OPTIMISTIC, and withdrawn if it turns out to be wrong. The prose
 *  may only stand down if something stands up in its place, and the thing that
 *  stands up is the SPA's card, which only appears if `bootCanvasError` posts
 *  the reason to the parent. That runs from the much larger run-state script,
 *  which can fail to post (a hand-authored document with a malformed
 *  `#sapiom-render-error` payload, or no payload at all) or abort as a whole
 *  before it is ever called. So `bootCanvasError` marks a successful post, and
 *  at load, with the DOM and every deferred boot done, an unmarked document
 *  takes its flag back and shows its own prose. Hiding it in that case would
 *  leave an empty board and no message anywhere, which is worse than the
 *  overlap SAP-3199 fixed.
 *
 *  `window.parent` is readable from a sandboxed frame and comparing the two
 *  references is not a cross-origin access, so this is safe under the
 *  `allow-scripts`-only sandbox the SPA loads the board with. */
const EMBED_SCRIPT = `
(function () {
  if (window.parent === window) return;
  var root = document.documentElement;
  root.setAttribute("data-canvas-embedded", "");
  function withdrawUnlessTaken() {
    if (!root.hasAttribute("data-canvas-error-posted")) root.removeAttribute("data-canvas-embedded");
  }
  if (document.readyState === "complete") withdrawUnlessTaken();
  else window.addEventListener("load", withdrawUnlessTaken);
})();
`.trim();

/** Reads the current theme from `?theme=light|dark`, falling back to the
 *  Studio's light product default when the param is absent. */
const THEME_SCRIPT = `
(function () {
  var params = new URLSearchParams(location.search);
  var theme = params.get("theme");
  theme = theme === "light" || theme === "dark" ? theme : "light";
  document.documentElement.setAttribute("data-canvas-theme", theme);
})();
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
 * A no-op `__name` shim, prepended to the injected script.
 *
 * esbuild's `keepNames` — which `tsx` enables in `dev`, and any `--keep-names`
 * build — rewrites NESTED function declarations inside the boot functions below
 * to `__name(fn, "fn")` calls, and defines the `__name` helper at MODULE scope:
 * scope that `Function.prototype.toString()` does NOT capture. Injected raw into
 * the sandboxed iframe, those calls throw `ReferenceError: __name is not
 * defined`, which aborts the whole <script> and kills the node-click AND
 * pan/zoom channels (run-state only survives because it has no nested
 * functions). A trivial in-scope shim makes the stringified output run verbatim
 * regardless of how it was compiled — `tsc` emits no such calls, so the shim is
 * simply unused there. Without this, canvas gestures work in a `tsc`/dist build
 * but silently break under `tsx`/esbuild.
 */
const NAME_SHIM = "function __name(fn){return fn;}";

/** Stringified run-state listener, node-click channel, and pan/zoom view
 *  channel injected into every canvas document. The run-state functions must
 *  all be in scope together because `bootCanvasRunState` calls
 *  `applyRunStateToCanvas`, which calls `runStateNodeClass`.
 *  `bootCanvasNodeClicks` adds the reverse click channel (iframe → parent), and
 *  `bootCanvasView` applies the parent's pan/zoom (transforming `#canvas-root`)
 *  and reports the graph size for fit-to-view; `bootCanvasGraph` posts the
 *  embedded step graph so the Steps tab can project it — all via the same
 *  stringify pattern. `NAME_SHIM` MUST come first (see its doc — without it,
 *  esbuild/tsx output throws in the iframe). */
const RUN_STATE_SCRIPT = `${NAME_SHIM}\n${runStateNodeClass.toString()}\n${applyRunStateToCanvas.toString()}\n${bootCanvasRunState.toString()}\nbootCanvasRunState();\n${bootCanvasNodeClicks.toString()}\nbootCanvasNodeClicks();\n${bootCanvasSelection.toString()}\nbootCanvasSelection();\n${bootCanvasView.toString()}\nbootCanvasView();\n${bootCanvasGraph.toString()}\nbootCanvasGraph();\n${bootCanvasOverview.toString()}\nbootCanvasOverview();\n${bootCanvasError.toString()}\nbootCanvasError();`;

/**
 * Wraps `bodyHtml` in the shared canvas document shell: doctype, the theme
 * switch script, the run-state listener, and every CSS class an agent's markup
 * can use. This is the single source both the pristine template and
 * `scripts/seed-example.mjs`'s prefilled instance render through, so they
 * can't drift from each other.
 */
export function renderCanvasDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Studio canvas</title>
<script>
${EMBED_SCRIPT}
</script>
<script>
${THEME_SCRIPT}
</script>
<script>
${RUN_STATE_SCRIPT}
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

/**
 * A minimal, THEME-AWARE document for the canvas pane's non-graph states —
 * the empty state and the "rendering…" placeholder the server serves for a
 * session with nothing (yet) to draw. It reuses the SAME theme mechanism as
 * `renderCanvasDocument` (the `?theme` reader + the ported token block), so
 * these pages follow the app's light/dark theme instead of always painting a
 * white panel inside a dark app. No graph, so it deliberately omits the
 * run-state/pan-zoom script and SVG defs — just a centered title + subtitle on
 * the themed canvas backdrop. `title`/`subtitle` are trusted, static server
 * copy (never user input), so they're inlined without escaping.
 */
export function renderCanvasMessageDocument(title: string, subtitle: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Studio canvas</title>
<script>
${THEME_SCRIPT}
</script>
<style>
${themeStyleBlock()}
.canvas-message { text-align: center; padding: 0 2rem; max-width: 520px; }
.canvas-message h1 { margin: 0 0 0.5rem; font-size: 1.1rem; font-weight: 600; color: var(--canvas-text); }
.canvas-message p { margin: 0; font-size: 13px; color: var(--canvas-text-dim); }
</style>
</head>
<body>
<div class="canvas-message">
  <h1>${title}</h1>
  <p>${subtitle}</p>
</div>
</body>
</html>
`;
}
