import { defineConfig } from "vitest/config";

/** Wall-clock benchmarks (`*.perf.test.ts`), run with no file parallelism and nothing else in the run. */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.perf.test.ts"],
    env: { SAPIOM_TELEMETRY_DISABLED: "1" },
    fileParallelism: false,
  },
});
