/**
 * Config for `pnpm --filter @sapiom/harness test:canvas`.
 *
 * One-time setup (browsers aren't installed by `pnpm install`):
 *   npx playwright install chromium
 *
 * No dev server, no backend: the canvas template is a fully self-contained
 * document (all CSS/JS inline, no external requests), so `page.setContent()`
 * renders it directly — unlike web/e2e/smoke.spec.ts, there's nothing here
 * to boot.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  outputDir: path.join(here, "test-results"),
  reporter: [["list"], ["html", { outputFolder: path.join(here, "playwright-report"), open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
