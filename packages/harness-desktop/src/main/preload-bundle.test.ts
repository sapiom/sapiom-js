/**
 * A sandboxed preload must be one classic script requiring only `electron`, or its bridge is
 * silently missing. Bundled in memory so these checks never touch dist/.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain .mjs build script, no type declarations.
import { PRELOADS, buildPreloads } from "../../scripts/build-preloads.mjs";

const bundles: { name: string; text: string }[] = await buildPreloads({ write: false });

describe("preload bundles", () => {
  it("emits one .cjs per preload", () => {
    expect(bundles.map((b) => b.name).sort()).toEqual(
      (PRELOADS as string[]).map((name) => `${name}.cjs`).sort(),
    );
  });

  it.each(bundles.map((b) => [b.name, b.text]))("%s requires only electron", (_name, text) => {
    const requires = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(requires.length).toBeGreaterThan(0);
    expect(new Set(requires)).toEqual(new Set(["electron"]));
  });

  it.each(bundles.map((b) => [b.name, b.text]))("%s has no ESM import/export left", (_name, text) => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/^\s*export\s/m);
    expect(text).not.toContain("import.meta");
  });

  it("inlines the ipc.ts channel names instead of requiring the module", () => {
    const desktop = bundles.find((b) => b.name === "desktop.cjs")!.text;
    expect(desktop).toContain('"update:check"');
    expect(desktop).not.toContain("ipc.js");
  });
});
