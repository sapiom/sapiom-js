/**
 * Mock-mode e2e tests for the live canvas panel (C1).
 *
 * Uses `window.__HARNESS_TEST__.publish(message)` to inject bus messages
 * synchronously, same pattern as smoke.spec.ts. The mock API's getRunState
 * returns a scripted sequence: 1st call → running, 2nd+ call → failed.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("no panel before a run starts", async ({ page }) => {
  // On fresh load with no execution.started message, the panel must not appear.
  await expect(page.getByTestId("run-state-panel")).toHaveCount(0);
});

test("live run panel appears and shows step statuses", async ({ page }) => {
  // Trigger a prod execution for the active boot session.
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-e2e",
      target: "prod",
    });
  });

  // Panel must become visible.
  await expect(page.getByTestId("run-state-panel")).toBeVisible();

  // First frame: run is running — badge shows "Running".
  await expect(page.getByTestId("run-state-status")).toHaveText("Running");

  // A step with data-status="running" must be present.
  await expect(
    page.locator('[data-testid="run-step"][data-status="running"]'),
  ).toBeVisible();

  // The passed step (fetchData, 1400ms) shows latency.
  const passedStep = page
    .locator('[data-testid="run-step"][data-status="passed"]')
    .first();
  await expect(passedStep).toBeVisible();
  await expect(passedStep.locator(".run-step-latency")).toHaveText("1.4s");

  // Second frame: wait for the next poll (~2s) to see the failed state.
  await expect(page.getByTestId("run-state-status")).toHaveText("Failed", {
    timeout: 6000,
  });

  // A failed step with the error message must be visible.
  const failedStep = page.locator(
    '[data-testid="run-step"][data-status="failed"]',
  );
  await expect(failedStep).toBeVisible();
  await expect(failedStep.locator(".run-step-error")).toHaveText(
    "Upstream timed out",
  );

  await page.screenshot({ path: "web/e2e/screenshots/live-canvas.png" });
});
