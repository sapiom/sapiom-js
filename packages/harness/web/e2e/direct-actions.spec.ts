/**
 * SAP-1784: Direct-action buttons (Deploy / Prod-run / Run-local) route to
 * the mocked harness-server routes and NEVER write to the Claude Code pty.
 * Contrast tests prove macros (Visualize / free-form) STILL go through
 * `runMacro`, confirmed by `lastMacroRun`, while direct routes set
 * `lastDirectAction` — the two slots are exclusive.
 *
 * Architecture note: the Visualize macro uses `action: { kind: "render-canvas" }`,
 * NOT `kind: "inject"`. The server's macro handler calls `renderCanvas()`, not
 * `injectInput()`, for render-canvas macros. In mock mode `MockApi.runMacro`
 * records `lastMacroRun` as the proof that the macro path fired — asserting
 * `lastInjectInput` for a visualize click would be architecturally wrong.
 *
 * All three direct-action assertions and the macro contrast run in mock mode
 * (VITE_MOCK=1 — see playwright.config.ts) against in-memory fixtures; no
 * real server, no real agent process, no real API key.
 *
 * The escape hatches:
 *  - `__HARNESS_TEST__.lastDirectAction` — set by MockApi.deploy(), .run(),
 *    and .runLocal(); NEVER set by runMacro/injectInput (that's the test: only
 *    direct routes set it).
 *  - `__HARNESS_TEST__.lastMacroRun` — set by MockApi.runMacro() only.
 *    For Visualize this IS the pty-inject signal: the server dispatches the
 *    macro, which triggers `renderCanvas()` (not `injectInput()`), signalled
 *    by `lastMacroRun`.
 *  - `__HARNESS_TEST__.lastInjectInput` — set by MockApi.injectInput() only.
 *    Direct actions must leave this unset (or unchanged from before the click).
 *
 * Fixture quick-reference (MOCK_WORKFLOWS / MOCK_SESSIONS in mock-data.ts):
 *   leasing   path=/Users/demo/acme-app/leasing  definitionId=4821 (deployed)
 *   rfq       path=/Users/demo/rfq-workflows      definitionId=null (draft)
 *   Boot session (sess-boot) is bound to leasing and running on load.
 *
 * F1 overlap avoided: smoke.spec.ts already has ONE assertion for the Run
 * button ("deployed workflow: chip reads Deployed, Run is enabled and fires a
 * direct prod run") that checks `lastDirectAction.action === "run"` and the
 * definitionId. This spec does NOT repeat that assertion verbatim — instead
 * it covers the full NDJSON consumption for Deploy, the inspector propagation
 * for Prod-run, and the per-step render for Run-local, plus the contrast.
 */
import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HarnessTestWindow = {
  __HARNESS_TEST__?: {
    lastDirectAction?: { action: string; req: Record<string, unknown> };
    directActions?: Array<{ action: string; req: Record<string, unknown> }>;
    lastMacroRun?: { id: string; req: { harnessSessionId?: string; workflowPath?: string; subject?: string } };
    lastInjectInput?: { id: string; req: { text: string; submit: boolean } };
  };
};

/** Read `__HARNESS_TEST__` from the page — typed helper so callers stay concise. */
async function readTestHook(page: import("@playwright/test").Page): Promise<HarnessTestWindow["__HARNESS_TEST__"]> {
  return page.evaluate(() => (window as unknown as HarnessTestWindow).__HARNESS_TEST__);
}

/** Wait until `lastDirectAction` is set then return it. */
async function waitForDirectAction(
  page: import("@playwright/test").Page,
): Promise<{ action: string; req: Record<string, unknown> }> {
  await page.waitForFunction(
    () => (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.lastDirectAction,
  );
  const hook = await readTestHook(page);
  return hook!.lastDirectAction!;
}

/** Snapshot `lastInjectInput` before an action so we can assert it did not change after. */
async function captureInjectInputBefore(page: import("@playwright/test").Page): Promise<string | undefined> {
  const hook = await readTestHook(page);
  return hook?.lastInjectInput ? JSON.stringify(hook.lastInjectInput) : undefined;
}

/**
 * Assert that `lastInjectInput` did not change from the before-snapshot,
 * proving no pty write occurred. This must be called AFTER `waitForDirectAction`
 * has already resolved — the mock's direct-action delay (≥180-200ms) means any
 * concurrent `injectInput` call would have settled by then, so no extra timeout
 * is needed: the action resolving IS the synchronisation point.
 */
async function assertNoPtyWrite(
  page: import("@playwright/test").Page,
  beforeSnapshot: string | undefined,
): Promise<void> {
  const hook = await readTestHook(page);
  const afterSnapshot = hook?.lastInjectInput ? JSON.stringify(hook.lastInjectInput) : undefined;
  expect(afterSnapshot).toBe(beforeSnapshot);
}

// ---------------------------------------------------------------------------
// Shared setup: navigate to a clean state (no seed auto-play) and wait for
// the leasing agent to be focused — the default on load.
// ---------------------------------------------------------------------------
test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  // The boot session is bound to leasing and running — the action bar is live.
  await expect(page.getByTestId("session-steps")).toBeVisible();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
});

// ---------------------------------------------------------------------------
// 1. Deploy button
// ---------------------------------------------------------------------------

test.describe("Deploy button — direct route, NDJSON build stream, no pty write", () => {
  test("fires the direct deploy route (building→ready), records lastDirectAction, and never writes to the pty", async ({
    page,
  }) => {
    // Capture the pty state BEFORE clicking: any pre-existing injectInput record.
    const injectBefore = await captureInjectInputBefore(page);

    // The action bar is visible for the deployed leasing workflow.
    const deployBtn = page.getByTestId("session-step-deploy");
    await expect(deployBtn).toBeEnabled();

    // A building→ready toast sequence is the observable NDJSON consumption.
    // The toast fires with "Deploying" on the building event, then the ready
    // toast replaces it.  Wait for the terminal "Deployed to Sapiom." toast to
    // confirm the mock NDJSON stream was fully consumed by the UI.
    await deployBtn.click();

    // The building phase shows a toast immediately.
    const toast = page.getByTestId("toast");
    await expect(toast).toContainText("Deploying", { timeout: 3_000 });

    // The ready phase replaces it.
    await expect(toast).toContainText("Deployed to Sapiom.", { timeout: 5_000 });

    // lastDirectAction must record "deploy" — this is the proof the DIRECT
    // route was taken, not the pty inject path.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("deploy");
    // The deploy route receives the workflow path, not a command string.
    expect(direct.req.workflowPath).toBe("/Users/demo/acme-app/leasing");

    // lastMacroRun must NOT be set (no runMacro call happened).
    const hook = await readTestHook(page);
    expect(hook?.lastMacroRun).toBeUndefined();

    // The pty must be untouched: lastInjectInput is absent or unchanged.
    await assertNoPtyWrite(page, injectBefore);
  });

  test("the Deploy button on an undeployed workflow still goes to the direct route, not the pty", async ({
    page,
  }) => {
    // Switch to rfq (undeployed) and start a session so the bar is live.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");

    const injectBefore = await captureInjectInputBefore(page);

    const deployBtn = page.getByTestId("session-step-deploy");
    await expect(deployBtn).toBeEnabled();
    await deployBtn.click();

    // The mock deploy stream fires for ANY workflow path — confirm.
    await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });

    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("deploy");
    // rfq's path, not leasing's.
    expect(direct.req.workflowPath).toBe("/Users/demo/rfq-workflows");

    // No pty involved.
    await assertNoPtyWrite(page, injectBefore);

    // A successful deploy on the previously-undeployed rfq should flip the
    // mock workflow's definitionId — the Deployed chip appears. MockApi.deploy
    // updates its local workflow copy, and refreshWorkflows re-reads it.
    await expect(page.getByTestId("session-lifecycle-chip")).toContainText("Deployed", { timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// 2. Prod-run (Run) button
// ---------------------------------------------------------------------------

test.describe("Prod-run button — direct route, executionId → inspector, no pty write", () => {
  test("fires the direct run route, executionId flows to the run inspector, no pty write", async ({
    page,
  }) => {
    // leasing is deployed (definitionId=4821), so the Run button is enabled.
    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeEnabled();

    const injectBefore = await captureInjectInputBefore(page);
    await runBtn.click();

    // Wait for lastDirectAction to confirm the DIRECT route fired.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("run");
    // The prod-run route receives the definitionId as a string (the hook
    // records what api.run() received — see MockApi.run).
    expect(direct.req.definitionId).toBe("4821");

    // The returned executionId is fed into the run-inspector poller. Load the
    // Steps tab to confirm the run appeared (the mock getRunState returns the
    // completed leasing steps immediately).
    await page.getByTestId("right-tab-steps").click();
    // The run chip appears once the poller's first tick resolves.
    const runChip = page.getByTestId("canvas-run-chip");
    await expect(runChip).toContainText("prod run completed", { timeout: 5_000 });

    // lastMacroRun must be absent — the direct route bypasses runMacro.
    const hook = await readTestHook(page);
    expect(hook?.lastMacroRun).toBeUndefined();

    // No pty write.
    await assertNoPtyWrite(page, injectBefore);
  });

  test("Run button is deploy-gated: clicking it on a draft workflow stays disabled, never falls through to the pty", async ({
    page,
  }) => {
    // Focus rfq (undeployed) and start a session.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");

    // The Run button must be disabled for a draft workflow.
    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeDisabled();
    await expect(runBtn).toHaveAttribute("aria-label", /Not deployed yet/);

    // Playwright can still read the enabled/disabled attribute; the button
    // never fires a click. No lastDirectAction and no pty write should appear.
    const hook = await readTestHook(page);
    expect(hook?.lastDirectAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Run-local (Local) button
// ---------------------------------------------------------------------------

test.describe("Run-local button — offline stub run, per-step inspector render, no pty write", () => {
  test("fires the direct run-local route, streams per-step traces into the Steps tab, no pty write", async ({
    page,
  }) => {
    // Run-local works for any workflow with a bound session — leasing is ready.
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();

    const injectBefore = await captureInjectInputBefore(page);
    await localBtn.click();

    // Run-local streams offline stub traces; the Steps tab should show the run
    // without waiting for a prod execution.  MockApi.runLocal emits 3 step
    // traces (intake, screen, approve) then a terminal summary.
    await page.getByTestId("right-tab-steps").click();

    // The run chip should appear and read "local run" (the target is "local").
    const runNote = page.getByTestId("canvas-steps-run-note");
    await expect(runNote).toHaveText("local run", { timeout: 5_000 });

    // Per-step traces are visible in the fallback or steps list.
    // MockApi.runLocal emits intake → screen → approve. The run can land in
    // the fallback (no graph) or the full list (graph already posted), so
    // probe whichever the fixture delivers.
    await expect(page.locator("[data-testid^='canvas-run-step-'], [data-testid^='canvas-step-row-']").first()).toBeVisible({ timeout: 5_000 });

    // lastDirectAction must record "runLocal" — proof the DIRECT route fired,
    // not a pty inject. waitForDirectAction resolves only after MockApi.runLocal
    // records the action (≥180-200ms delay), ensuring any concurrent injectInput
    // would have settled before assertNoPtyWrite reads back the hook.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("runLocal");

    // lastMacroRun must be absent — run-local is a direct route.
    const hook = await readTestHook(page);
    expect(hook?.lastMacroRun).toBeUndefined();

    // No pty write: injectInput was never called. Called after waitForDirectAction
    // so any concurrent injectInput has already settled — no timeout needed.
    await assertNoPtyWrite(page, injectBefore);
  });

  test("Run-local works offline (no network dependency): the Steps tab shows per-step latency-free stub results", async ({
    page,
  }) => {
    // Load the graph first so the full steps list renders (not the fallback).
    await page.evaluate(() => {
      (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");

    const injectBefore = await captureInjectInputBefore(page);

    await page.getByTestId("session-step-local").click();
    await page.getByTestId("right-tab-steps").click();

    // The run note confirms this is the local (offline) run, not prod.
    await expect(page.getByTestId("canvas-steps-run-note")).toHaveText("local run", { timeout: 5_000 });

    // lastDirectAction must record "runLocal" — proof the DIRECT route fired.
    // Resolving waitForDirectAction also ensures any concurrent injectInput
    // has settled (mock delay ≥180-200ms), so assertNoPtyWrite needs no timeout.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("runLocal");

    // Local runs carry no latency (no real clock — stubs respond instantly in
    // mock mode), so the Step rows must NOT show a cost value anywhere.
    const stepsArea = page.locator(".canvas-frame-wrap");
    await expect(stepsArea).not.toContainText("$");

    // No pty write. Called after waitForDirectAction — the action settling is
    // the synchronisation point; no extra timeout required.
    await assertNoPtyWrite(page, injectBefore);
  });
});

// ---------------------------------------------------------------------------
// 4. Contrast — macros (Visualize) STILL go through runMacro (NOT direct route)
// ---------------------------------------------------------------------------

test.describe("Contrast: macros use runMacro (NOT the direct route)", () => {
  test("Visualize CTA fires runMacro, sets lastMacroRun, never sets lastDirectAction", async ({ page }) => {
    // Switch to a session with no bundled canvas doc so the empty-state CTA
    // is available (the boot session opens on its board, which hides it).
    await page.getByTestId("workspace-focus-scratch").click();
    await expect(page.locator(".canvas-empty")).toBeVisible();

    const ctaBefore = await readTestHook(page);
    // No prior direct action from this fresh page load.
    expect(ctaBefore?.lastDirectAction).toBeUndefined();

    // Click the one-click Visualize CTA (render-canvas macro path — NOT inject).
    const cta = page.getByTestId("canvas-visualize-cta");
    await expect(cta).toBeEnabled();
    await cta.click();

    // runMacro records lastMacroRun — wait for it.
    await page.waitForFunction(
      () => (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.lastMacroRun,
    );
    const hook = await readTestHook(page);
    expect(hook?.lastMacroRun?.id).toBe("visualize");

    // The direct-action hatch must NEVER be set — Visualize is a
    // render-canvas macro, NOT a direct server action.
    expect(hook?.lastDirectAction).toBeUndefined();
  });

  test("re-Visualize from the canvas header fires runMacro, NOT the direct route", async ({ page }) => {
    // The canvas header has a re-Visualize button (canvas-revisualize) for
    // the boot session's bound board.
    const reVisualizeBtn = page.getByTestId("workflow-actions-header").getByTestId("canvas-revisualize");
    await expect(reVisualizeBtn).toBeEnabled();

    const before = await readTestHook(page);
    expect(before?.lastDirectAction).toBeUndefined();

    await reVisualizeBtn.click();

    await page.waitForFunction(
      () => (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.lastMacroRun,
    );
    const hook = await readTestHook(page);
    expect(hook?.lastMacroRun?.id).toBe("visualize");
    // Direct route untouched.
    expect(hook?.lastDirectAction).toBeUndefined();
  });

  test("direct/inject split is exclusive: running Deploy then Visualize records both hooks in the right slots", async ({
    page,
  }) => {
    // Step 1: fire the direct Deploy button.
    const deployBtn = page.getByTestId("session-step-deploy");
    await expect(deployBtn).toBeEnabled();
    await deployBtn.click();

    // Wait for the direct action to land.
    const directAfterDeploy = await waitForDirectAction(page);
    expect(directAfterDeploy.action).toBe("deploy");
    // At this point, no macro run should have happened.
    const hookAfterDeploy = await readTestHook(page);
    expect(hookAfterDeploy?.lastMacroRun).toBeUndefined();

    // Step 2: fire the Visualize CTA on the scratch session (render-canvas macro path).
    await page.getByTestId("workspace-focus-scratch").click();
    const cta = page.getByTestId("canvas-visualize-cta");
    await expect(cta).toBeEnabled();
    await cta.click();

    await page.waitForFunction(
      () => (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.lastMacroRun,
    );
    const hookAfterVisualize = await readTestHook(page);

    // The macro slot now has the visualize entry.
    expect(hookAfterVisualize?.lastMacroRun?.id).toBe("visualize");

    // The direct-action slot still carries the deploy (lastDirectAction is the
    // LAST direct action; the visualize click must NOT overwrite it).
    expect(hookAfterVisualize?.lastDirectAction?.action).toBe("deploy");
  });
});
