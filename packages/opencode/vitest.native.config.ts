import { defineConfig } from "vitest/config";

// The native pass: only the files that launch the real pinned OpenCode
// runtime. Files run one at a time so that a cold native startup never
// competes with another native launch (or the fixture servers in
// server.test.ts) for the runner's CPU; each file still owns its per-test
// deadlines. See vitest.config.ts for why these files are split out.
export default defineConfig({
  test: {
    include: ["src/**/*.native.test.ts"],
    fileParallelism: false,
  },
});
