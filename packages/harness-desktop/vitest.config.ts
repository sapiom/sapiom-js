import { defineConfig } from "vitest/config";

// Only the main process's PURE helpers are unit-tested here — the modules that
// don't import `electron` (env.ts, paths.ts) — plus the static renderer assets,
// asserted as TEXT (no DOM, no electron; see renderer/setup.html.test.ts).
// boot.ts and friends are covered by the packaged `--smoke` launch instead (see
// src/main/smoke.ts): every bug this app has shipped came from the real
// environment differing from our assumptions, so mocking `electron` to unit-test
// boot would just re-assert the wrong ones.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
