import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Wall-clock benchmarks (`*.perf.test.ts`), run on their own.
 *
 * Split out from vitest.config.ts because a timing assertion is only
 * meaningful when the machine isn't simultaneously running ~90 other test
 * files in parallel workers — under that contention the same read measured
 * 27 ms alone and 340 ms alongside the suite. So: no file parallelism, and
 * nothing else in the run. `pnpm test` chains this after the unit pass, so
 * these still gate every test run rather than becoming an opt-in nobody runs.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@shared/types": fileURLToPath(new URL("src/shared/types.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.perf.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    fileParallelism: false,
  },
});
