/**
 * Classifies a `.sapiom/canvas/index.html` on disk as machine-generated
 * (a leftover the harness itself wrote) vs. an agent-authored custom canvas,
 * so the server can:
 *
 *   (a) refuse to serve a stale machine-generated file as the UNBOUND canvas
 *       fallback — showing the clean empty state instead of stale content; and
 *   (b) delete a legacy deterministic-overview file on session create so an
 *       old one can't keep resurfacing (see `ensureCanvasTemplate`).
 *
 * Two machine-generated shapes exist in the wild:
 *
 *   - The seeded pristine template (`canvas-template.ts`'s `TEMPLATE_HTML`) —
 *     benign (an empty state itself) but not a custom canvas either, so it
 *     shouldn't be served as one.
 *   - A LEGACY deterministic overview / single render. Before the
 *     per-workflow render split, the deterministic pipeline wrote its output
 *     straight to `index.html`; on a project first opened by one of those old
 *     servers, that file is a stacked all-workflows page with baked-in
 *     "render failed" panels that have nothing to do with the current session
 *     — the actual bug this guards against. The writer that produced it was
 *     removed when renders moved to `renders/<slug>.html`, so its signature is
 *     matched by literal markup here rather than an imported constant.
 *
 * Detection is by signature substrings that only this package's own writers
 * emit and that an agent authoring its own canvas would not reproduce.
 */

/**
 * The footer note the deterministic render pipeline emits via
 * `assembleCanvasBody` — `<p class="canvas-note">Static preview — …</p>`.
 * Stable across both the legacy overview and single-render variants (the exact
 * trailing text differed between versions; the "Static preview" prefix did
 * not). An agent-authored canvas writes its own copy, never this.
 */
const DETERMINISTIC_NOTE_SIGNATURE = 'class="canvas-note">Static preview';

/**
 * The inert patterns block the seeded template ships with, together with its
 * untouched empty-state note. Both present means the seed is still
 * un-customized — an agent is instructed to delete both once it authors real
 * content, so their joint presence never matches a finished custom canvas.
 */
const TEMPLATE_PATTERNS_SIGNATURE = 'id="canvas-patterns"';
const TEMPLATE_EMPTY_NOTE_SIGNATURE = "Nothing visualized yet";

/** True when `html` is a legacy deterministic overview/single render that was
 *  written directly to `index.html` by a pre-split server. This is the file
 *  worth deleting on session create — the harmful stale "render failed" wall. */
export function isLegacyDeterministicCanvas(html: string): boolean {
  return html.includes(DETERMINISTIC_NOTE_SIGNATURE);
}

/** True when `html` is the seeded pristine template, still un-customized. */
export function isSeededCanvasTemplate(html: string): boolean {
  return html.includes(TEMPLATE_PATTERNS_SIGNATURE) && html.includes(TEMPLATE_EMPTY_NOTE_SIGNATURE);
}

/**
 * True when `html` is machine-generated (the seeded template OR a legacy
 * deterministic overview) rather than an agent-authored custom canvas. Such a
 * file must not be served as the unbound canvas fallback — the clean empty
 * state is served instead.
 */
export function isMachineGeneratedCanvas(html: string): boolean {
  return isLegacyDeterministicCanvas(html) || isSeededCanvasTemplate(html);
}
