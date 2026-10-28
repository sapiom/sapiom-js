// Bundles each preload into ONE classic script: dist/preload/<name>.cjs.
//
// Every window that carries a preload runs with `sandbox: true`, and a sandboxed
// preload is a non-ESM script whose `require` loads only `electron`, never a file.
// Our preloads import their channel names from `../main/ipc.ts`, so that module is
// inlined here and `electron` is left as the one external require. IIFE rather
// than `cjs` output: it needs no `module`/`exports` from the preload wrapper.
//
// tsc still compiles src/preload (it typechecks them, and the renderers import
// their bridge types), so its ESM output is removed afterwards: nothing loads it,
// and leaving it in dist/ would ship dead preloads that look like the real ones.
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist", "preload");

export const PRELOADS = ["desktop", "setup", "update"];

/**
 * Bundle the preloads. With `write: false` nothing touches disk and the bundles
 * come back as `{ name, text }` (what preload-bundle.test.ts asserts on).
 */
export async function buildPreloads({ write = true } = {}) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: PRELOADS.map((name) => join(root, "src", "preload", `${name}.mts`)),
    bundle: true,
    format: "iife",
    platform: "node",
    target: "es2022",
    external: ["electron"],
    outdir: outDir,
    outExtension: { ".js": ".cjs" },
    write,
    logLevel: "warning",
  });
  return (result.outputFiles ?? []).map((file) => ({
    name: file.path.slice(outDir.length + 1),
    text: file.text,
  }));
}

/** Drop tsc's ESM preload output so only the bundles remain in dist/preload. */
async function removeTscPreloadOutput() {
  for (const entry of await readdir(outDir)) {
    if (!entry.endsWith(".cjs")) await rm(join(outDir, entry));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildPreloads();
  await removeTscPreloadOutput();
  console.log(`bundled preloads (${PRELOADS.join(", ")}) → dist/preload/*.cjs`);
}
