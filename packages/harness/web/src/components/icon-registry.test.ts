import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ICON_REGISTRY } from "./Icon";

/**
 * The registry is the only thing between a glyph name and the screen, and
 * `Icon` falls back to `HelpCircle` for a name it does not know — so a typo or
 * an unregistered glyph does not crash, it draws a QUESTION MARK where a real
 * icon belongs. That reads as a status the app is reporting, which is worse
 * than a blank.
 *
 * `Icon`'s `name` prop is deliberately `string` (palette entries, macro actions
 * and toasts carry names through config), so the compiler cannot catch this.
 * These two tests do.
 *
 * This branch shipped the failure three times before the tests existed:
 *   - `GitBranch`, on a new "checkouts not searched" row.
 *   - `EllipsisVertical`, minutes after being wired into three call sites.
 *   - `Minus`, in the canvas step inspector — live on `main`, drawing a
 *     question mark next to a step that had no change to report.
 */
describe("icon registry", () => {
  it("resolves every registered name to a real component", () => {
    // An import can resolve to `undefined` without the compiler noticing:
    // lucide renames and removes glyphs between versions, and a stale name
    // imports as undefined while its key stays in the map.
    const broken = Object.entries(ICON_REGISTRY)
      .filter(([, component]) => component == null)
      .map(([name]) => name);
    expect(broken).toEqual([]);
  });

  it("registers every icon name used as a literal in the source", () => {
    const root = path.resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);

    // Only LITERAL names — `<Icon name={x} />` is config-driven by design and is
    // what the runtime fallback exists for.
    const used = new Map<string, string>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<Icon\s+name="([A-Za-z0-9]+)"/g)) {
        used.set(match[1]!, path.relative(root, file));
      }
      // The ternary form, both branches: `name={cond ? "A" : "B"}`.
      for (const match of source.matchAll(/<Icon\s+name=\{[^}]*\?\s*"([A-Za-z0-9]+)"\s*:\s*"([A-Za-z0-9]+)"/g)) {
        used.set(match[1]!, path.relative(root, file));
        used.set(match[2]!, path.relative(root, file));
      }
    }

    // Guard the guard: if the scan finds nothing, it is broken, not clean.
    expect(used.size).toBeGreaterThan(20);

    const unregistered = [...used.entries()]
      .filter(([name]) => !(name in ICON_REGISTRY))
      .map(([name, file]) => `${name} (${file})`);
    expect(unregistered).toEqual([]);
  });

  it("offers exactly ONE overflow-menu glyph, and it is the vertical one", () => {
    // Two glyphs for one meaning is what this branch removed. The horizontal
    // ellipsis is also the app's own truncation marker — every clipped agent
    // name and elided directory chain renders one — so a CONTROL shaped like it
    // is the worse of the two. Leaving the alias unregistered is what makes the
    // rule enforceable rather than advisory.
    expect(ICON_REGISTRY).toHaveProperty("EllipsisVertical");
    expect(ICON_REGISTRY).not.toHaveProperty("MoreHorizontal");
    expect(ICON_REGISTRY).not.toHaveProperty("MoreVertical");
    expect(ICON_REGISTRY).not.toHaveProperty("Ellipsis");
  });
});
