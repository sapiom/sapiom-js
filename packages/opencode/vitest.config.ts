import { configDefaults, defineConfig } from "vitest/config";

// `*.native.test.ts` files spawn the pinned OpenCode binary. They are excluded
// HERE, not skipped: `pnpm test` at the repository root runs several packages'
// suites at once (pnpm's workspace concurrency) while Vitest also runs every
// file in this package in parallel workers, and on a GitHub-hosted runner that
// CPU contention pushed a cold native startup past its deadline often enough
// to turn unrelated pull requests red (SAP-3605). The native files run in
// their own sequential pass instead — see vitest.native.config.ts, wired to
// `pnpm test:native` and to .github/workflows/opencode-native.yml, which only
// runs when this package or its build inputs change.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/**/*.native.test.ts"],
  },
});
