/**
 * Every window that carries a preload runs sandboxed, with context isolation on
 * and Node integration off. windows.ts and update-window.ts import `electron`,
 * so their `webPreferences` are asserted as TEXT, like window-background.test.ts
 * (see vitest.config.ts). The packaged `--smoke` checks then prove the bundled
 * preloads actually load in those sandboxed windows.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sources = {
  "windows.ts": readFileSync(new URL("./windows.ts", import.meta.url), "utf8"),
  "update-window.ts": readFileSync(new URL("./update-window.ts", import.meta.url), "utf8"),
};

/** The body of every `webPreferences: { ... }` object literal, braces balanced. */
function webPreferenceBlocks(src: string): string[] {
  const blocks: string[] = [];
  for (const match of src.matchAll(/webPreferences:\s*\{/g)) {
    let depth = 0;
    const start = match.index! + match[0].length - 1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}" && --depth === 0) {
        blocks.push(src.slice(start, i + 1));
        break;
      }
    }
  }
  return blocks;
}

describe.each(Object.entries(sources))("%s", (_file, src) => {
  const blocks = webPreferenceBlocks(src);

  it("never turns the sandbox off", () => {
    expect(src).not.toMatch(/sandbox:\s*false/);
  });

  it("sandboxes every window that has a preload", () => {
    const withPreload = blocks.filter((b) => /\bpreload:/.test(b));
    expect(withPreload.length).toBeGreaterThan(0);
    for (const block of withPreload) {
      expect(block).toMatch(/sandbox:\s*true/);
      expect(block).toMatch(/contextIsolation:\s*true/);
      expect(block).toMatch(/nodeIntegration:\s*false/);
    }
  });
});

describe("windows.ts", () => {
  it("has three windows: setup and main with a preload, preview without", () => {
    const blocks = webPreferenceBlocks(sources["windows.ts"]);
    expect(blocks).toHaveLength(3);
    expect(blocks.filter((b) => /\bpreload:/.test(b))).toHaveLength(2);
    expect(blocks.every((b) => /sandbox:\s*true/.test(b))).toBe(true);
  });
});
