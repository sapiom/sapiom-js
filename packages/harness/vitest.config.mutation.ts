import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Dedicated Vitest config for Stryker mutation runs (`pnpm test:mutation`).
//
// It narrows the suite to ONLY the co-located unit tests of the pure functions
// listed in `stryker.conf.json`'s `mutate` set. Two reasons this is separate
// from the default `vitest.config.ts`:
//   1. Speed — Stryker re-runs the suite once per surviving mutant, so the
//      per-run set must be minimal (these three specs run in well under a
//      second) rather than the full ~964-test suite.
//   2. Isolation — the default suite includes tests that spawn a real pty
//      (`transcript-replay.test.ts`), which is irrelevant to these pure
//      functions and does not belong in a mutation run.
// Stryker sets `vitest.related=false` so this `include` is authoritative.
//
// Keep this `include` in lock-step with `stryker.conf.json`'s `mutate`: each
// mutated source file must have its covering spec listed here.
export default defineConfig({
  resolve: {
    alias: {
      // Mirror the "@shared/*" alias from web/tsconfig.json so the web unit
      // tests resolve shared types without a running server (same as the
      // default vitest.config.ts).
      "@shared": fileURLToPath(new URL("src/shared", import.meta.url)),
    },
  },
  test: {
    include: [
      "src/core/render-run-state.test.ts",
      "web/src/lib/generate-snippet.test.ts",
      "web/src/lib/extract-step-context.test.ts",
    ],
    // Same telemetry guard as the default config: analytics-core is
    // live-by-default, so the setup file disables delivery globally.
    setupFiles: ["src/test-setup.ts"],
  },
});
