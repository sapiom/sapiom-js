/**
 * Canvas style contract: injected everywhere an agent is asked to write to
 * `.sapiom/canvas/index.html` (the Visualize macro's inject text, and the
 * system prompt's canvas paragraph for freeform "show me X" asks), so every
 * generated canvas looks Sapiom-native regardless of which prompt triggered
 * it. Kept prompt-sized on purpose — this rides in prompts, not docs.
 *
 * Colors are the harness's own dark-theme tokens (web/src/styles.css,
 * `[data-theme="dark"]`) — dark is the canonical canvas look. Structural
 * conventions (rounded nodes with a uniform glow, straight-then-curved
 * arrowed edges, stats header, legend footer) mirror what
 * scripts/seed-example.mjs's reference canvas already renders; this doesn't
 * change that seed, just documents its pattern for agents generating new
 * ones. Edge/glow/legend wording tightened after a live Visualize proof
 * (see PR history) surfaced ambiguities two different agent runs resolved
 * inconsistently — see git blame for the before/after if the wording here
 * ever seems oddly specific.
 */
export const CANVAS_STYLE_GUIDELINES = `
Canvas style contract (.sapiom/canvas/index.html):
- One self-contained HTML file: inline all CSS/JS, no external stylesheets/
  scripts or CDN fonts (the CSP blocks them) — no build step, no dependencies.
- Dark theme, Sapiom palette: background #0f0f0f, panel #1a1a1a, border
  #2e2e2e, text #fafafa, dim text #a1a1aa, accent/success #6be195, escalation
  #f59e0b, failure #f87171.
- Monospace throughout: ui-monospace, "SF Mono", Menlo, Consolas, monospace.
- Header: title + short status badge, one-line subtitle, and a stats row
  (e.g. step count, terminal-outcome count, branch count) as label/value pairs.
- Render the workflow as an inline SVG graph, top-to-bottom: rounded-rect
  nodes (12-16px radius). Every node gets the same subtle glow on its
  border — never reserve the glow for entry/terminal nodes only; role and
  outcome are conveyed by border/stroke color, not by which nodes glow.
- Edges: straight lines with arrowhead markers for a single-successor step,
  curved paths with arrowhead markers only where a step branches into
  multiple successors — don't curve every edge, that reads as noise on a
  simple linear chain.
- Color-code terminal outcomes by meaning: accent/green = success, amber =
  escalation/needs-attention, red = failure. Reserve those colors for actual
  terminal branches, not regular steps.
- Footer legend: one visually distinct marker per node kind used (shape
  and/or fill vs. outline — never reuse the identical marker for two
  different kinds just because they happen to share a color) + label, plus
  a short note that this is a static preview to regenerate after the
  workflow changes.
- Prefer clarity over decoration: no motion, gradients, or ornamentation that
  doesn't help someone understand the graph's structure in a few seconds.
`.trim();
