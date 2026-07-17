import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// web/e2e/*.spec.ts are Playwright tests (see web/e2e/playwright.config.ts,
// run via `pnpm test:ui`) — a different runner and API, and opt-in rather
// than part of the default `test` script. Vitest's default glob would
// otherwise try (and fail) to execute them here too.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the "@shared/*" path alias in web/tsconfig.json so that web
      // unit tests can import types from the shared contract without a server.
      "@shared": fileURLToPath(new URL("src/shared", import.meta.url)),
    },
  },
  test: {
    // web/src/**/*.test.ts are DOM-free unit tests (run under node, same as
    // src/**/*.test.ts). This glob may be de-duplicated when the feature
    // branches land on main.
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    // Guard: analytics-core is live-by-default — an unconfigured emitter
    // delivers to the real production collector. The setup file sets
    // SAPIOM_TELEMETRY_DISABLED=1 globally; tests that assert delivery opt
    // back in via SAPIOM_ANALYTICS_ENDPOINT pointing at startMockCollector().
    setupFiles: ["src/test-setup.ts"],
  },
});
