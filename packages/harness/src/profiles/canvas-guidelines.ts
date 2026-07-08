/**
 * Canvas style contract: injected everywhere an agent is asked to write to
 * `.sapiom/canvas/index.html` (the Visualize macro's inject text, and the
 * system prompt's canvas paragraph for freeform "show me X" asks), so every
 * generated canvas looks Sapiom-native regardless of which prompt triggered
 * it. Kept prompt-sized on purpose — this rides in prompts, not docs.
 *
 * Colors are the harness's own dark-theme tokens (web/src/styles.css,
 * `[data-theme="dark"]`) — dark is the canonical canvas look. Structural
 * conventions (rounded nodes, curved arrowed edges, stats header, legend
 * footer) mirror what scripts/seed-example.mjs's reference canvas already
 * renders; this doesn't change that seed, just documents its pattern for
 * agents generating new ones.
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
- Render the workflow as an inline SVG graph: rounded-rect nodes (12-16px
  radius) in a top-to-bottom flow, curved connector paths with arrowhead
  markers, a subtle accent-colored glow on node borders.
- Color-code terminal outcomes by meaning: accent/green = success, amber =
  escalation/needs-attention, red = failure. Reserve those colors for actual
  terminal branches, not regular steps.
- Footer legend: one colored dot + label per node kind used, plus a short
  note that this is a static preview to regenerate after the workflow changes.
- Prefer clarity over decoration: no motion, gradients, or ornamentation that
  doesn't help someone understand the graph's structure in a few seconds.
`.trim();
