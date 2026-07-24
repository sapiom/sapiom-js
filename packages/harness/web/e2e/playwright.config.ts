/**
 * Config for `pnpm --filter @sapiom/harness test:ui`.
 *
 * One-time setup (browsers aren't installed by `pnpm install`):
 *   npx playwright install chromium
 *
 * Runs against the Vite dev server in mock mode (VITE_MOCK=1) — no harness
 * server, backend, or real agent process needed. Opt-in only: this is not
 * part of the `test` script.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");

// Fixed default port, overridable via E2E_PORT so several checkouts/worktrees
// can run the suite side by side without colliding on one port (each run owns
// its own Vite dev server). CI leaves it unset and gets the stable default.
const PORT = Number(process.env.E2E_PORT) || 5299;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  // Keep artifacts (traces, the HTML report) next to the tests, not in the package
  // root — web/e2e/.gitignore covers this directory.
  outputDir: path.join(here, "test-results"),
  reporter: [["list"], ["html", { outputFolder: path.join(here, "playwright-report"), open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --config web/vite.config.ts --port ${PORT} --strictPort`,
    cwd: packageRoot,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { VITE_MOCK: "1" },
  },
});
