import { defineConfig } from "vitest/config";

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
  test: {
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    // Guard: analytics-core is live-by-default — an unconfigured emitter
    // delivers to the real production collector. The setup file sets
    // SAPIOM_TELEMETRY_DISABLED=1 globally; tests that assert delivery opt
    // back in via SAPIOM_ANALYTICS_ENDPOINT pointing at startMockCollector().
    setupFiles: ["src/test-setup.ts"],
  },
});
