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
  /* The 2px resize grabber, in all four of its states. Only the last of these
     was listed before, because the scanner credited a one-per-line selector
     group to its final member: the other three were carrying a full-brand
     background this file could not see. They are the same 2px line and the
     same indicator; listing them is the honest bookkeeping, and the scanner
     now reads the whole group. */
  ".canvas-overview-resize:hover::before",
  ".canvas-overview-resize:active::before",
  ".canvas-overview.is-resizing .canvas-overview-resize::before",
  ".canvas-overview-resize:focus-visible::before",
  /* A 7px status dot, the same kind of glyph as `.session-busy` above, and
     invisible to the scanner for the same grouping reason. */
  ".run-workspace-pulse",
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

    /* EVERY MEMBER OF A SELECTOR GROUP, not just the last one.
       This used to keep the nearest line ending in `{`, so a group written one
       selector per line recorded only its final member. `.run-workspace-pulse,`
       / `.run-workspace-pending {` was credited entirely to the allowlisted
       second name, which means the first already carried a full-brand
       background this lint could not see, and adding a fifth offender was a
       one-line insertion above an allowlisted selector. A lint that a one-line
       edit walks around lets bug five ship the way the first four did. */
    const offenders: string[] = [];
    let group: string[] = ["(top of file)"];
    let pending: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      const continues = /^([.:#a-zA-Z[][^{}]*?),$/.exec(line);
      if (continues) {
        pending.push(continues[1]!.trim());
        continue;
      }
      const opens = /^([.:#a-zA-Z[][^{}]*?)\s*\{$/.exec(line);
      if (opens) {
        group = [...pending, opens[1]!.trim()];
        pending = [];
      } else if (line !== "" && !line.startsWith("/*") && !line.startsWith("*")) {
        // Anything that is neither a continuation nor an opening brace ends a
        // half-collected group, so a stray comma cannot leak into the next rule.
        if (pending.length > 0) pending = [];
      }

      /* FULL-STRENGTH ONLY, and in every form the file writes it.
         `background` and `background-color` are the same visual bug, and
         `var(--brand) no-repeat` is still a solid brand fill, so the shorthand
         may carry trailing tokens. A `color-mix(...)` wash never matches,
         because it is the correct fix and must not trip this. */
      if (
        !/^background(?:-color)?:\s*var\(--(?:brand|accent|green)\)(?:\s+[^;]*)?;$/.test(line)
      ) {
        continue;
      }
      const unlisted = group.filter((sel) => !ALLOWED.has(sel));
      if (unlisted.length === 0) continue;
      offenders.push(`${unlisted.join(", ")} → ${line}`);
    }

    // The single-line rule form the file uses in a few places:
    // `.sel { background: var(--x); }` all on one line.
    for (const match of css.matchAll(
      /^\s*([.:#a-zA-Z[][^{}\n]*?)\s*\{\s*background(?:-color)?:\s*var\(--(?:brand|accent|green)\)(?:\s+[^;}]*)?;\s*\}/gm,
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
