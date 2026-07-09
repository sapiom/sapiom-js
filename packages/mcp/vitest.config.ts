import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Telemetry defaults live; disable it globally so no test emits to the real
    // production collector. Tests that assert events ARE sent must opt in by
    // setting SAPIOM_ANALYTICS_ENDPOINT to the mock collector.
    env: { SAPIOM_TELEMETRY_DISABLED: "1" },
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
