/**
 * The entry point has ONE ordering contract, and it is invisible at runtime
 * until a user tries to deploy: `./esbuild-binary.js` must be imported before
 * anything that reaches `@sapiom/harness`, because esbuild snapshots
 * `ESBUILD_BINARY_PATH` when its module is evaluated and ignores it afterwards
 * (see esbuild-binary.ts). Getting this wrong is silent — the app boots, every
 * other smoke check passes, and only a deploy fails, with `spawn ENOTDIR`.
 *
 * The packaged `deploy-bundle` smoke check is the real guard; this one just fails
 * in seconds instead of after a 100 MB package, and names the reason.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
const imports = [...source.matchAll(/^import\s.*?["'](.+?)["'];$/gm)].map((m) => m[1]);

describe("main entry import order", () => {
  it("imports ./esbuild-binary.js before anything else", () => {
    expect(imports.length).toBeGreaterThan(1);
    expect(imports[0]).toBe("./esbuild-binary.js");
  });

  it("imports it ahead of every module that reaches @sapiom/harness", () => {
    // boot.ts and smoke.ts both import @sapiom/harness at their top level, so
    // either one evaluating first would load esbuild too early.
    for (const mod of ["./boot.js", "./smoke.js"]) {
      expect(imports).toContain(mod);
      expect(imports.indexOf(mod)).toBeGreaterThan(imports.indexOf("./esbuild-binary.js"));
    }
  });
});
