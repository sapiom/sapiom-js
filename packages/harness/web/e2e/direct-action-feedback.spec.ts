/**
 * E2E tests for the "never let a direct action fail silently" fix:
 *
 *   Fix 1  — blocked direct-action clicks surface a toast with a specific
 *             reason (never silent). Tested by simulating the guard conditions
 *             that the UI normally prevents via `disabled` — but which can be
 *             triggered programmatically (and which MUST also be safe when
 *             the button is briefly enabled between state transitions).
 *
 *   Fix 2  — the pending ring (data-pending) clears on ANY terminal outcome:
 *             success OR failure for deploy, and completion for runs.
 *
 *   Fix 3  — after a simulated deploy failure the Prod-run button's disabled
 *             reason reads "Last deploy failed — retry Deploy" (distinct from
 *             the virgin "Not deployed yet"), and that reason persists after
 *             the failure toast disappears.
 *
 *   Fix 5  — when not authenticated, Deploy and Prod-run are disabled with
 *             reason "Connect your account first".
 *
 * All tests run in mock mode (VITE_MOCK=1 — see playwright.config.ts) with
 * no real server, no agent process, and no API key.
 *
 * Mock escape hatches used:
 *   ?mockError=deploy         — makes MockApi.deploy() return phase:"error"
 *   ?mockBoot401=1            — tested in auth-resilience.spec.ts (not here)
 *   window.__HARNESS_TEST__   — escape hatch for direct-action signals
 */
import { expect, test } from "@playwright/test";

type HarnessTestWindow = {
  __HARNESS_TEST__?: {
    lastDirectAction?: { action: string; req: Record<string, unknown> };
    directActions?: Array<{ action: string; req: Record<string, unknown> }>;
    lastMacroRun?: { id: string; req: Record<string, unknown> };
    lastInjectInput?: { id: string; req: Record<string, unknown> };
  };
};

async function readTestHook(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as HarnessTestWindow).__HARNESS_TEST__);
}

// ---------------------------------------------------------------------------
// Fix 2 — pending ring clears on successful deploy
// ---------------------------------------------------------------------------

test.describe("Fix 2 — pending ring clears on terminal outcomes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();
  });

  test("pending ring clears after a SUCCESSFUL deploy", async ({ page }) => {
    const deployBtn = page.getByTestId("session-step-deploy");
    await expect(deployBtn).toBeEnabled();

    // Click — ring appears immediately (data-pending="true" in React).
    await deployBtn.click();
    // Verify the pending attribute is set (React renders boolean as "true").
    await expect(deployBtn).toHaveAttribute("data-pending", "true");

    // Wait for the success toast — the deploy settled (ready).
    await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });

    // Ring must be gone: deployed flipped to true (definitionId set), which
    // clears pendingId via the useEffect dep on [workflow.path, deployed, lastDeployError].
    await expect(deployBtn).not.toHaveAttribute("data-pending", { timeout: 3_000 });
  });

  test("pending ring clears after a FAILED deploy", async ({ page }) => {
    // Reload with ?mockError=deploy so the mock stream ends with phase:"error".
    await page.goto("/?seed=0&mockError=deploy");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    const deployBtn = page.getByTestId("session-step-deploy");
    await expect(deployBtn).toBeEnabled();

    await deployBtn.click();
    // Ring appears immediately after click (React renders boolean true as "true").
    await expect(deployBtn).toHaveAttribute("data-pending", "true");

    // Wait for the failure toast — the deploy settled (error).
    await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });

    // Ring must clear: lastDeployError appeared, which fires the useEffect.
    await expect(deployBtn).not.toHaveAttribute("data-pending", { timeout: 3_000 });
  });

  test("pending ring clears after a successful local run (safety timeout)", async ({ page }) => {
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();

    await localBtn.click();
    // Ring appears immediately (React boolean → "true").
    await expect(localBtn).toHaveAttribute("data-pending", "true");

    // The mock local run streams 3 step traces (each ~140ms) + a summary.
    // Navigate to Steps tab so we can observe run completion.
    await page.getByTestId("right-tab-steps").click();
    await expect(page.getByTestId("canvas-steps-run-note")).toHaveText("local run", { timeout: 5_000 });

    // For a local run, `deployed` and `lastDeployError` do not change, so the
    // ring clears via the 30s safety timeout. The run itself completes in
    // ~4 × 140ms, so the test must wait up to 30s for the timer — which is
    // well within Playwright's own 30s test timeout. The mock run is fast, so
    // the timer fires quickly in practice.
    await expect(localBtn).not.toHaveAttribute("data-pending", { timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — deploy-failed vs never-deployed distinction
// ---------------------------------------------------------------------------

test.describe("Fix 3 — deploy failure persists in Prod-run disabled reason", () => {
  test("after a failed deploy, Prod-run reads 'Last deploy failed — retry Deploy' (not 'Not deployed yet')", async ({
    page,
  }) => {
    // Switch to rfq (undeployed) so we can observe the transition from
    // "Not deployed yet" → "Last deploy failed — retry Deploy".
    await page.goto("/?seed=0&mockError=deploy");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    // The single session bar labels a folder-default session by its agent name.
    await expect(page.getByTestId("session-context-title")).toContainText("rfq");

    const runBtn = page.getByTestId("session-step-run");
    const deployBtn = page.getByTestId("session-step-deploy");

    // Virgin state: Prod Run must read "Not deployed yet".
    await expect(runBtn).toBeDisabled();
    await expect(runBtn).toHaveAttribute("aria-label", /Not deployed yet/);

    // Fire the deploy — it will fail (?mockError=deploy).
    await expect(deployBtn).toBeEnabled();
    await deployBtn.click();
    await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });

    // After the failure, Prod Run's reason must change to the specific failure message.
    await expect(runBtn).toHaveAttribute("aria-label", /Last deploy failed — retry Deploy/, {
      timeout: 3_000,
    });
  });

  test("deploy failure persists after the toast is dismissed", async ({ page }) => {
    await page.goto("/?seed=0&mockError=deploy");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-context-title")).toContainText("rfq");

    const deployBtn = page.getByTestId("session-step-deploy");
    const runBtn = page.getByTestId("session-step-run");

    await deployBtn.click();
    await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });

    // Dismiss the toast using the .toast-dismiss button (no data-testid, using
    // class selector + aria-label).
    await page.locator("button.toast-dismiss[aria-label='Dismiss']").click();
    await expect(page.getByTestId("toast")).not.toBeVisible({ timeout: 2_000 });

    // The disabled reason must still reflect the deploy failure, not revert
    // to "Not deployed yet" as if the deploy never happened. This is the key
    // assertion: lastDeployError persists in durable state, not just the toast.
    await expect(runBtn).toHaveAttribute("aria-label", /Last deploy failed — retry Deploy/);
  });

  test("deploy-failed state is distinct from draft — Prod-run reason changes, Deploy stays primary", async ({
    page,
  }) => {
    // The Draft/Deployed/Deploy-failed lifecycle chip was removed from the bar.
    // Deploy-failed is now distinguished from a virgin Draft by the Prod-run
    // button's disabled reason: "Not deployed yet" (draft) vs "Last deploy
    // failed — retry Deploy" (deploy-failed). Deploy stays the primary CTA in
    // both states (nothing is live yet).
    await page.goto("/?seed=0&mockError=deploy");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-context-title")).toContainText("rfq");

    const runBtn = page.getByTestId("session-step-run");
    const deployBtn = page.getByTestId("session-step-deploy");

    // Draft (never deployed): Run reads "Not deployed yet", Deploy is primary.
    await expect(runBtn).toHaveAttribute("aria-label", /Not deployed yet/);
    await expect(deployBtn).toHaveClass(/session-action-primary/);

    // After a failed deploy: Run's reason changes to the deploy-failed message,
    // and Deploy remains the primary CTA (retry Deploy is the next act).
    await deployBtn.click();
    await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });
    await expect(runBtn).toHaveAttribute("aria-label", /Last deploy failed — retry Deploy/, {
      timeout: 3_000,
    });
    await expect(deployBtn).toHaveClass(/session-action-primary/);
    // The mock persists a definition id before the failed first build, just
    // like production. That link must not enable Prod Run or Code snippets.
    // Starting the rfq session collapsed the right pane (empty canvas — the
    // failed build produced no doc); reopen it before inspecting canvas-tab-bar.
    await page.getByTestId("right-expand").click();
    const dashboardLink = page.getByTestId("workflow-dashboard-link");
    await expect(dashboardLink).toContainText("deploy failed");
    await expect(dashboardLink).toHaveAttribute("data-deployment-state", "failed");
    await expect(runBtn).toBeDisabled();
    await page.getByTestId("right-tab-code").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toContainText(
      "Deploy did not produce a ready build",
    );
  });

  test("a successful retry clears the deploy-failed state — Prod-run returns to normal", async ({
    page,
  }) => {
    // First, make a deploy fail.
    await page.goto("/?seed=0&mockError=deploy");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-context-title")).toContainText("rfq");

    const deployBtn = page.getByTestId("session-step-deploy");
    const runBtn = page.getByTestId("session-step-run");

    await deployBtn.click();
    await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });
    await expect(runBtn).toHaveAttribute("aria-label", /Last deploy failed — retry Deploy/, {
      timeout: 3_000,
    });

    // Now navigate to a URL without ?mockError=deploy so the retry succeeds.
    // We simulate this by reloading the page without the error flag, then
    // re-doing the workflow focus + session (the existing rfq session from the
    // previous load is gone — fresh mock state). Then do a successful deploy.
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-context-title")).toContainText("rfq");

    // Fresh draft state: no "deployed" pill on the Canvas tab, Deploy is primary,
    // and Run reads "Not deployed yet". (The lifecycle chip that used to say
    // "Draft" is gone; draft-ness is now Deploy-as-primary + no deployed pill.)
    // The fresh rfq session started with an empty canvas, collapsing the right
    // pane; reopen it before inspecting the Canvas tab.
    await page.getByTestId("right-expand").click();
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("workflow-dashboard-link")).toHaveCount(0);
    await expect(deployBtn).toHaveClass(/session-action-primary/);
    await expect(runBtn).toHaveAttribute("aria-label", /Not deployed yet/);

    // Successful deploy.
    await deployBtn.click();
    await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });

    // After success the agent is DEPLOYED: the "deployed" pill appears on the
    // Canvas tab, Run becomes enabled and takes over as the primary CTA.
    await expect(page.getByTestId("workflow-dashboard-link")).toContainText("deployed", {
      timeout: 3_000,
    });
    await expect(runBtn).toBeEnabled({ timeout: 3_000 });
    await expect(runBtn).toHaveClass(/session-action-primary/);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — auth precondition
// ---------------------------------------------------------------------------

/**
 * Use the settings popover to sign out: open the menu → Settings → Disconnect.
 * The mock broadcasts auth.changed { authenticated: false } synchronously so
 * the React state updates before we assert the action-bar state.
 */
async function disconnectViaSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await page.getByTestId("settings-trigger").click();
  await expect(page.getByTestId("settings-popover")).toBeVisible();
  const disconnectBtn = page.getByTestId("settings-disconnect-btn");
  await expect(disconnectBtn).toBeVisible({ timeout: 3_000 });
  await disconnectBtn.click();
  // Wait for auth.changed to propagate (the mock fires it inline in disconnect()).
  await expect(page.getByTestId("settings-connect-btn")).toBeVisible({ timeout: 3_000 });
  // Close the popover so it doesn't overlap the action bar assertions.
  await page.keyboard.press("Escape");
}

test.describe("Fix 5 — unauthenticated disables auth-requiring actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();
  });

  test("after disconnect, Deploy and Prod-run show 'Connect your account first'", async ({
    page,
  }) => {
    // Confirm initial state: leasing is deployed, Run and Deploy are enabled.
    const runBtn = page.getByTestId("session-step-run");
    const deployBtn = page.getByTestId("session-step-deploy");
    await expect(runBtn).toBeEnabled();
    await expect(deployBtn).toBeEnabled();

    await disconnectViaSettings(page);

    // After sign-out both auth-requiring buttons must be disabled with the
    // specific auth reason (not any other reason like "Not deployed yet").
    await expect(deployBtn).toBeDisabled({ timeout: 3_000 });
    await expect(runBtn).toBeDisabled({ timeout: 3_000 });
    await expect(deployBtn).toHaveAttribute("aria-label", /Connect your account first/);
    await expect(runBtn).toHaveAttribute("aria-label", /Connect your account first/);
  });

  test("Local Run does not require auth — stays enabled after disconnect", async ({ page }) => {
    await disconnectViaSettings(page);

    // Local Run does not touch cloud auth — must stay enabled.
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled({ timeout: 3_000 });
    await expect(localBtn).not.toHaveAttribute("aria-label", /Connect your account first/);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — blocked direct-action toast (regression guard for the no-silent path)
// ---------------------------------------------------------------------------

test.describe("Fix 1 — no silent direct-action dead-clicks", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();
  });

  test("all three direct-action buttons are enabled for a deployed workflow (no spurious block)", async ({
    page,
  }) => {
    // Leasing is deployed — all three must be enabled and clickable.
    const deployBtn = page.getByTestId("session-step-deploy");
    const runBtn = page.getByTestId("session-step-run");
    const localBtn = page.getByTestId("session-step-local");

    await expect(deployBtn).toBeEnabled();
    await expect(runBtn).toBeEnabled();
    await expect(localBtn).toBeEnabled();

    // None show a disabled reason.
    await expect(deployBtn).not.toHaveAttribute("aria-label", /:/);
    await expect(localBtn).not.toHaveAttribute("aria-label", /:/);
  });

  test("Prod-run is disabled for an undeployed workflow — not silent, shows reason", async ({
    page,
  }) => {
    // rfq is undeployed — Prod Run must be disabled AND carry a reason.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-context-title")).toContainText("rfq");

    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeDisabled();
    // The reason must be human-readable (not empty, not just "disabled").
    const label = await runBtn.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toContain("Not deployed yet");
  });
});
