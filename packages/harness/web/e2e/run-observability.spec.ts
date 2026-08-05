/**
 * Observable Run / Test / Deploy: clicking an action reveals the right pane and
 * switches it to the Steps view, the acting button shows a running highlight
 * tied to the REAL run status, the run advances visibly (running → completed),
 * and the relevant final data (deployed dashboard link, result output) surfaces
 * up front — never with fabricated cost. All in mock mode (VITE_MOCK=1).
 *
 * Fixtures (mock-data.ts): leasing is deployed (definitionId=4821, path
 * /Users/demo/acme-app/leasing); the boot session is bound to leasing.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("session-steps")).toBeVisible();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
});

test.describe("Run/Test/Deploy observability", () => {
  test("Run reveals the Steps view, highlights the running button, then shows a completed summary", async ({
    page,
  }) => {
    // Collapse the pane first, to prove Run REVEALS it (not just switches tabs).
    await page.getByTestId("right-collapse").click();
    await expect(page.getByTestId("right-panel-canvas")).not.toBeVisible();

    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    // Auto-switched to Steps AND revealed the pane.
    await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
    await expect(page.getByTestId("canvas-steps-surface")).toBeVisible();

    // The run summary appears and reads as running; the acting button pulses.
    const summary = page.getByTestId("run-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Running");
    await expect(runBtn).toHaveAttribute("data-running", "true");

    // The deployed agent's dashboard link is the headline result CTA.
    await expect(page.getByTestId("run-summary-dashboard-link")).toBeVisible();

    // It advances to completed; the highlight clears; a total duration shows.
    await expect(summary).toContainText("Completed", { timeout: 12_000 });
    await expect(runBtn).not.toHaveAttribute("data-running", "true");
    await expect(page.getByTestId("run-summary-duration")).toBeVisible();
  });

  test("Test streams a local run into the Steps view with a copyable result", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.getByTestId("session-step-local").click();

    await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
    await expect(page.getByTestId("run-summary")).toBeVisible();

    // A local run carries per-step output, so the final Result renders
    // default-open with a Copy button that reuses the snippet-copy pattern.
    const result = page.getByTestId("run-summary-output");
    await expect(result).toBeVisible({ timeout: 6_000 });
    const copy = page.getByTestId("payload-copy-result");
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(copy).toContainText("Copied");
  });

  test("Deploy shows a live banner in the Steps view that jumps to the Code snippet", async ({
    page,
  }) => {
    await page.getByTestId("session-step-deploy").click();

    // Deploy lands in the same Steps activity surface.
    await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
    const banner = page.getByTestId("deploy-status-banner");
    await expect(banner).toBeVisible();

    // It reaches the ready phase with the dashboard + code CTAs.
    await expect(banner).toHaveAttribute("data-phase", "ready", { timeout: 6_000 });
    await expect(page.getByTestId("deploy-open-dashboard")).toBeVisible();

    // "Trigger from your code" jumps to the Code tab where the snippet lives.
    await page.getByTestId("deploy-open-code").click();
    await expect(page.getByTestId("right-panel-code")).toBeVisible();
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });

  test("no fabricated cost surfaces in the run summary or its result", async ({ page }) => {
    await page.getByTestId("session-step-local").click();
    const surface = page.getByTestId("canvas-steps-surface");
    await expect(page.getByTestId("run-summary")).toBeVisible();
    await expect(page.getByTestId("run-summary-output")).toBeVisible({ timeout: 6_000 });
    // Latency and logs, never money.
    await expect(surface).not.toContainText("$");
  });
});
