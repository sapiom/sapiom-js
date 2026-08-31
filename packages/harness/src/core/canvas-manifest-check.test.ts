/**
 * The Canvas extraction's failure reason has to name the directory it bundled.
 * Every other caller of `check()` was handed its project directory by the user;
 * this one takes it from the bound workflow row, so "check/run_local/deploy
 * succeed but the Canvas doesn't" is indistinguishable from "the Canvas is
 * bundling a different directory" unless the reason says which.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runManifestCheck } from "./canvas-manifest-check.js";

describe("runManifestCheck", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "manifest-check-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the bundled project directory when the project has no entry file", async () => {
    const result = await runManifestCheck(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(dir);
  });

  it("names the bundled project directory when it doesn't exist", async () => {
    const missing = path.join(dir, "not-here");

    const result = await runManifestCheck(missing);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(missing);
  });

  it("doesn't repeat the directory when the reason already names it", async () => {
    writeFileSync(path.join(dir, "index.ts"), 'import "no-such-pkg";\n');

    const result = await runManifestCheck(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The deps-not-installed hint already names it; one mention, not two.
    expect(result.reason.split(dir).length - 1).toBe(1);
  });

  it("preserves the NO_DEFINITION code for a valid unnamed module", async () => {
    writeFileSync(path.join(dir, "index.ts"), "export const value = 1;\n");

    const result = await runManifestCheck(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_DEFINITION");
  });
});
