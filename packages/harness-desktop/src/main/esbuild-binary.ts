/**
 * Side-effect module — **must be the FIRST import in `index.ts`**, before
 * anything pulls in `@sapiom/harness`.
 *
 * `configureEsbuildBinary()` points `ESBUILD_BINARY_PATH` at an on-disk binary,
 * because esbuild cannot exec one from inside `app.asar` (see env.ts for the
 * full story). The catch is *when* it has to happen: esbuild snapshots the
 * variable into a module-level constant the first time its module is evaluated
 *
 *   var ESBUILD_BINARY_PATH = process.env.ESBUILD_BINARY_PATH || …   (lib/main.js)
 *
 * and `generateBinPath()` reads that constant, not `process.env`. So setting it
 * even one module too late is silently ignored — which is exactly what happened
 * on the first attempt at this fix: `boot()` set it correctly (the boot trace
 * showed the right unpacked path) and the packaged app still failed to bundle,
 * because `import { startServer } from "@sapiom/harness"` at the top of boot.ts
 * had already evaluated agent-core → esbuild.
 *
 * ESM evaluates a module's imports depth-first in declaration order, and the
 * importing module's own body runs after all of them. That leaves exactly one
 * place this can live: a module with no harness in its own import graph, pulled
 * in ahead of every other import of the entry point. Hence a file whose entire
 * job is one statement.
 *
 * Do not "tidy" this into a call inside `boot()` or `app.whenReady()`, and do not
 * let an import sorter move it down the list. Two things will catch you if you
 * do: `index.test.ts` asserts the import order, and the packaged `deploy-bundle`
 * smoke check fails with `spawn ENOTDIR`.
 */
import { configureEsbuildBinary } from "./env.js";

/** The binary we pinned, or null if we left esbuild to its own resolution. */
export const esbuildBinaryPath: string | null = configureEsbuildBinary();
