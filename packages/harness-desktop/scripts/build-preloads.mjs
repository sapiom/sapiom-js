// A sandboxed preload's `require` loads only `electron`, so ipc.ts is inlined into one
// script per preload; IIFE, not `cjs`, so it needs no `module`/`exports` from the wrapper.
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist", "preload");

export const PRELOADS = ["desktop", "setup", "update"];

/** `write: false` lets preload-bundle.test.ts inspect the bundles without touching dist/. */
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

/** tsc still emits ESM preloads (it typechecks them); nothing loads them, so don't ship them. */
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
