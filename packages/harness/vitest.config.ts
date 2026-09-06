import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// web/e2e/*.spec.ts are Playwright tests (see web/e2e/playwright.config.ts,
// run via `pnpm test:ui`) — a different runner and API, and opt-in rather
// than part of the default `test` script. Vitest's default glob would
// otherwise try (and fail) to execute them here too.
//
// web/src/**/*.test.ts ARE Vitest tests: unit tests for the SPA's pure,
// browser-agnostic logic (e.g. web/src/lib/generate-snippet.ts). Only
// framework-free logic belongs here; React components are covered by the
// Playwright e2e tier, not this Node-environment runner.
export default defineConfig({
  resolve: {
    alias: {
      "@shared/initial-prompt": fileURLToPath(
        new URL("src/shared/initial-prompt.ts", import.meta.url),
      ),
      // Resolve "@shared/types" to the package's canonical contract so web
      // unit tests and server tests always build against the same source of
      // truth. Mirrors the alias in web/vite.config.ts.
      "@shared/types": fileURLToPath(
        new URL("src/shared/types.ts", import.meta.url),
      ),
      "@shared/system-graph": fileURLToPath(
        new URL("src/shared/system-graph.ts", import.meta.url),
      ),
      "@shared/agent-map": fileURLToPath(
        new URL("src/shared/agent-map.ts", import.meta.url),
      ),
      "@shared/agent-map-codec": fileURLToPath(
        new URL("src/shared/agent-map-codec.ts", import.meta.url),
      ),
      "@shared/agent-name": fileURLToPath(
        new URL("src/shared/agent-name.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    // *.perf.test.ts are wall-clock benchmarks and are excluded HERE, not
    // skipped: this run executes ~90 test files in parallel workers, and a
    // timing assertion measured against that much CPU contention says nothing
    // about the thing it claims to measure. They run in their own sequential
    // pass instead — see vitest.perf.config.ts, which `pnpm test` chains after
    // this one, so they are still enforced on every test run and in CI.
    exclude: [...configDefaults.exclude, "src/**/*.perf.test.ts"],
    // Guard: analytics-core is live-by-default — an unconfigured emitter
    // delivers to the real production collector. The setup file sets
    // SAPIOM_TELEMETRY_DISABLED=1 globally; tests that assert delivery opt
    // back in via SAPIOM_ANALYTICS_ENDPOINT pointing at startMockCollector().
    setupFiles: ["src/test-setup.ts"],
  },
});
