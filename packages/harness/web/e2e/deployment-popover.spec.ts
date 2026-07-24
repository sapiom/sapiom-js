/**
 * Deployment popover — the chip is now a clickable button that reveals
 * deployment details. Three states:
 *
 *   Deployed  — heading, definition id, dashboard link, Redeploy button.
 *   Draft     — "Not deployed yet" + Deploy button.
 *   Error     — "Last deploy failed" + Retry button.
 *
 * All tests run in mock mode (VITE_MOCK=1 — see playwright.config.ts).
 * Fixture quick-reference (MOCK_WORKFLOWS / MOCK_SESSIONS in mock-data.ts):
 *   leasing  path=/Users/demo/acme-app/leasing  definitionId=4821 (deployed)
 *   rfq      path=/Users/demo/rfq-workflows      definitionId=null (draft)
 *   Boot session (sess-boot) is bound to leasing and running on load.
 */
import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared setup: clean load with the boot session on leasing
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("session-steps")).toBeVisible();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
});

// ---------------------------------------------------------------------------
// 1. Deployed state — the chip opens the "Deployed" popover
// ---------------------------------------------------------------------------

test.describe("Deployed chip — popover shows definition + dashboard link + Redeploy", () => {
  test("chip is a button (aria-haspopup) and opens the popover on click", async ({ page }) => {
    const chip = page.getByTestId("session-lifecycle-chip");
    await expect(chip).toContainText("Deployed");
    // The chip is now a button with aria-haspopup
    await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    await expect(chip).toHaveAttribute("aria-expanded", "false");

    // Click to open
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");

    const popover = page.getByTestId("deployment-popover");
    await expect(popover).toBeVisible();
  });

  test("deployed popover shows 'Deployed to production' heading", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    const popover = page.getByTestId("deployment-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Deployed to production");
  });

  test("deployed popover shows the definition id", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    const popover = page.getByTestId("deployment-popover");
    // leasing has definitionId=4821
    await expect(popover).toContainText("#4821");
  });

  test("deployed popover has an 'Open in dashboard' link pointing at the definition", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    const link = page.getByTestId("deployment-popover-dashboard-link");
    await expect(link).toBeVisible();
    await expect(link).toContainText("Open in dashboard");
    await expect(link).toHaveAttribute("href", /app\.sapiom\.ai\/workflows\/4821/);
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("deployed popover has a Redeploy button that fires the deploy action", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    const popover = page.getByTestId("deployment-popover");
    const redeployBtn = page.getByTestId("deployment-popover-redeploy");
    await expect(redeployBtn).toBeVisible();
    await expect(redeployBtn).toContainText("Redeploy");

    // Click Redeploy — popover should close and deploy toast should appear
    await redeployBtn.click();
    // Popover closes after delegating the deploy
    await expect(popover).not.toBeVisible();
    // Deploy toast fires
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Deploying", { timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// 2. Dismiss — Escape key and outside-click
// ---------------------------------------------------------------------------

test.describe("Popover dismiss", () => {
  test("Escape key dismisses the popover", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    await expect(page.getByTestId("deployment-popover")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("deployment-popover")).not.toBeVisible();
  });

  test("clicking outside the popover dismisses it", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    await expect(page.getByTestId("deployment-popover")).toBeVisible();

    // Click on the terminal slot (a safe area outside the popover)
    await page.locator(".terminal-slot").click({ position: { x: 100, y: 200 } });
    await expect(page.getByTestId("deployment-popover")).not.toBeVisible();
  });

  test("clicking the chip again (toggle) closes the popover", async ({ page }) => {
    const chip = page.getByTestId("session-lifecycle-chip");
    await chip.click();
    await expect(page.getByTestId("deployment-popover")).toBeVisible();

    await chip.click();
    await expect(page.getByTestId("deployment-popover")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. Draft state — chip opens "Not deployed yet" popover
// ---------------------------------------------------------------------------

test.describe("Draft chip — popover shows Deploy button", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to rfq (draft workflow) and start a session
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");
  });

  test("draft chip opens a popover saying 'Not deployed yet' with a Deploy button", async ({
    page,
  }) => {
    const chip = page.getByTestId("session-lifecycle-chip");
    await expect(chip).toContainText("Draft");
    await chip.click();

    const popover = page.getByTestId("deployment-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Not deployed yet");
    // Deploy hint text
    await expect(popover).toContainText("Deploy publishes this agent to Sapiom.");
    // The deploy button is present
    const deployBtn = page.getByTestId("deployment-popover-deploy");
    await expect(deployBtn).toBeVisible();
    await expect(deployBtn).toContainText("Deploy");
  });

  test("draft popover Deploy button fires the deploy action", async ({ page }) => {
    await page.getByTestId("session-lifecycle-chip").click();
    const deployBtn = page.getByTestId("deployment-popover-deploy");
    await expect(deployBtn).toBeVisible();

    // Click Deploy — popover closes and deploy toast should appear
    await deployBtn.click();
    await expect(page.getByTestId("deployment-popover")).not.toBeVisible();

    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Deploying", { timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// 4. Deploy-error state — chip opens "Last deploy failed" popover
// ---------------------------------------------------------------------------

test.describe("Deploy-failed chip — popover shows error + Retry", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to rfq on an error-injected load, deploy to produce the error state
    await page.goto("/?seed=0&mockError=deploy");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");
    // Trigger the deploy to produce the error state
    await page.getByTestId("session-step-deploy").click();
    // Wait for the deploy-failed chip to appear
    await expect(page.getByTestId("session-lifecycle-chip")).toContainText("Deploy failed", {
      timeout: 5_000,
    });
  });

  test("deploy-failed chip opens popover with error heading and Retry button", async ({ page }) => {
    const chip = page.getByTestId("session-lifecycle-chip");
    await chip.click();

    const popover = page.getByTestId("deployment-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Last deploy failed");
    // A Retry deploy button is present
    const retryBtn = page.getByTestId("deployment-popover-retry");
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toContainText("Retry deploy");
  });
});
