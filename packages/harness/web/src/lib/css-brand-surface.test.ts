import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `--accent` is `var(--brand)` — FULL brand green (#6be195 / #167e3a). It reads
 * like "a subtle accent surface" and is not one; `--accent-dim`
 * (`var(--brand-wash)`) is the wash.
 *
 * That misreading has produced the same bug four separate times in this file,
 * each shipped and each reported by a user as "green stuff that came out of
 * nowhere":
 *
 *   - `.workspace-row.is-drop-target` — painted solid brand while its own
 *     comment claimed it was "a wash".
 *   - `.workspace-row:hover .project-mark` — filled the stray-agents header's
 *     folder glyph, the one row with no project behind it.
 *   - `.rail-add-row:hover` — "New group" turned solid green on hover.
 *   - `.rail-reset-row.is-armed` — a DESTRUCTIVE confirmation rendered in the
 *     success colour, under red text.
 *
 * Fixing them one at a time as they were noticed is what let it recur, so this
 * is the guard: a full-strength brand background is allowed only where it is
 * genuinely a small indicator — a dot, a toggle, a spinner, a focus bar — and
 * every such place is named below. Anything new fails here and has to either
 * join the list deliberately or use a `color-mix` wash.
 *
 * This is a lint, not a design rule. If a new brand surface is right, add it and
 * say why in the same commit.
 */
const ALLOWED = new Set([
  // Small status indicators: the glyph IS the colour.
  '.identity-dot[data-authenticated="true"]',
  '.workflow-session-dot[data-live="true"]',
  ".workflow-dot",
  '.session-dot[data-status="running"]',
  '.terminal-statusbar[data-status="connected"] .terminal-status-dot',
  ".dot--entry",
  ".dot--terminal-success",
  // Controls whose ON state is the brand.
  ".toggle-switch.is-on",
  ".session-busy",
  ".canvas-task-spinner",
  ".run-workspace-pending",
  '.run-timeline-row[data-status="running"] .run-timeline-track > span',
  // A focus affordance drawn as a bar, not a surface.
  ".canvas-overview-resize:focus-visible::before",
  // The project MARK is a badge, not the row. Scoped away from
  // `project-mark-none`, which is the stray-agents header and has no project.
  ".workspace-row.is-selected .project-mark:not(.project-mark-none)",
  ".workspace-row:hover .project-mark:not(.project-mark-none)",
  ".workspace-row.is-focused .project-mark:not(.project-mark-none)",
]);

describe("brand-coloured surfaces", () => {
  it("uses a full-strength brand background only where it is an indicator", () => {
    const css = readFileSync(path.resolve(__dirname, "..", "styles.css"), "utf8");
    const lines = css.split("\n");

    // Track the nearest preceding selector line, which is how these rules are
    // written throughout the file (`selector {` on its own line).
    const offenders: string[] = [];
    let selector = "(top of file)";
    for (const raw of lines) {
      const line = raw.trim();
      const opens = /^([.:#a-zA-Z[][^{}]*?)\s*\{$/.exec(line);
      if (opens) selector = opens[1]!.trim();

      // Only FULL-strength: `var(--brand)`, `var(--accent)`, `var(--green)` with
      // no color-mix around them. A wash is exactly the correct fix, so it must
      // not trip this.
      if (!/^background:\s*var\(--(?:brand|accent|green)\)\s*;$/.test(line)) continue;
      // One-liner form: `.sel { background: var(--x); }` on a single line.
      if (ALLOWED.has(selector)) continue;
      offenders.push(`${selector} → ${line}`);
    }

    // Also catch the single-line rule form the file uses in a few places.
    for (const match of css.matchAll(
      /^\s*([.:#a-zA-Z[][^{}\n]*?)\s*\{\s*background:\s*var\(--(?:brand|accent|green)\)\s*;\s*\}/gm,
    )) {
      const sel = match[1]!.trim();
      if (!ALLOWED.has(sel)) offenders.push(`${sel} → single-line rule`);
    }

    // Guard the guard: if the scan matches nothing at all it is broken, not clean.
    const totalBrandBackgrounds = [
      ...css.matchAll(/background:\s*var\(--(?:brand|accent|green)\)\s*;/g),
    ].length;
    expect(totalBrandBackgrounds).toBeGreaterThan(8);

    expect(offenders).toEqual([]);
  });
});
