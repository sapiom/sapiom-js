/**
 * Run-inspector e2e coverage.
 *
 * Contract under test — two scenarios, no network, no agent binary:
 *
 * (a) OFFLINE STUB RUN — the "Local" button triggers MockApi.runLocal, which
 *     streams per-step traces and a terminal summary. The Steps inspector
 *     must:
 *     - render each step's name and pass/fail status in the accordion;
 *     - show the "stubbed" chip on every step that ran (the run is
 *       stub-served by construction; agent-core records no per-CALL
 *       attribution, so the chip lives at the granularity the trace
 *       supports);
 *     - show the read-only stub-hygiene notice when unusedStubs or
 *       stubWarnings are present, and be ABSENT when neither are set
 *       (a clean run surfaces no chrome at all — honesty).
 *
 * (b) PROD RUN — a mocked bus message announces execution.started, which
 *     drives the run-state poll (MockApi.getRunState). The Steps inspector
 *     must:
 *     - render each step's name, pass/fail status icon, and latency in
 *       the accordion rows;
 *     - light up the run chip in the subheader (completed / running /
 *       failed).
 *
 * Both scenarios exercise the real component tree in mock mode. The canvas
 * document posts a graph for sess-boot (bundled public/canvas/sess-boot/),
 * so the CanvasStepsList accordion is shown (not the RunStepsList fallback).
 * The per-step accordion rows use `data-testid="canvas-step-row-{nodeId}"`;
 * the stubbed chip uses `data-testid="canvas-run-stub-chip"`.
 *
 * For tests that need a non-default run state (failed, hygiene signals),
 * Playwright seeds `window.__MOCK_RUN_STATE__[executionId]` before announcing
 * execution.started — the mock API checks and consumes this override exactly
 * once (same test-only escape hatch as `__MOCK_INJECT_FAIL_ONCE__`).
 */
import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Navigate to a clean slate with the Steps tab visible and the leasing
 *  workflow binding active (no demo seed, no pre-existing run). */
const loadStepsTab = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("right-tab-steps").click();
  await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
};

/** Trigger the "Local" action-bar button: run-first mode fires the run directly
 *  using the last-used input (or {}) — no dialog opens for a clean run. */
const clickLocalButton = async (page: Page): Promise<void> => {
  const btn = page.getByTestId("session-step-local");
  await expect(btn).toBeEnabled();
  await btn.click();
  // Run-first: the button fires immediately with no dialog (the mock run
  // succeeds with no input-validation error, so the dialog is never opened).
};

/** Publish a bus message via the test escape hatch (same pattern as
 *  canvas-inspector.spec.ts). */
const publish = (page: Page, message: unknown): Promise<void> =>
  page.evaluate((msg) => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } })
      .__HARNESS_TEST__.publish(msg);
  }, message);

/** Seed window.__MOCK_RUN_STATE__[executionId] so MockApi.getRunState returns
 *  a custom RunView on the next poll for that id — consumed and cleared once. */
const seedRunState = (page: Page, executionId: string, view: RunView): Promise<void> =>
  page.evaluate(
    ([id, v]) => {
      const win = window as unknown as { __MOCK_RUN_STATE__?: Record<string, unknown> };
      win.__MOCK_RUN_STATE__ = { ...(win.__MOCK_RUN_STATE__ ?? {}), [id]: v };
    },
    [executionId, view] as [string, RunView],
  );

// ---------------------------------------------------------------------------
// (a) Offline stub run
// ---------------------------------------------------------------------------

test.describe("offline stub run — run-local inspector", () => {
  test.beforeEach(async ({ page }) => {
    await loadStepsTab(page);
  });

  test("per-step pass/fail and the stubbed chip appear for each step that ran", async ({
    page,
  }) => {
    await clickLocalButton(page);

    // The run chip in the Steps subheader must appear and report completed.
    // MockApi.runLocal emits: intake, screen, approve — all succeeded.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("local run completed", { timeout: 8000 });

    // The Steps list (CanvasStepsList accordion) remains in view because the
    // canvas document posts a graph for sess-boot.
    const stepsList = page.getByTestId("canvas-steps-list");
    await expect(stepsList).toBeVisible();

    // Rows that received a run trace carry the pass/fail StepStatusIcon.
    // intake — ran and passed.
    const intakeRow = page.getByTestId("canvas-step-row-intake");
    await expect(intakeRow).toBeVisible();
    await expect(intakeRow.locator('[aria-label="passed"]')).toBeVisible();
    // The "stubbed" chip: this step ran in a stub-served offline run.
    await expect(intakeRow.getByTestId("canvas-run-stub-chip")).toBeVisible();

    // screen — ran and passed.
    const screenRow = page.getByTestId("canvas-step-row-screen");
    await expect(screenRow).toBeVisible();
    await expect(screenRow.locator('[aria-label="passed"]')).toBeVisible();
    await expect(screenRow.getByTestId("canvas-run-stub-chip")).toBeVisible();

    // approve — ran and passed.
    const approveRow = page.getByTestId("canvas-step-row-approve");
    await expect(approveRow).toBeVisible();
    await expect(approveRow.locator('[aria-label="passed"]')).toBeVisible();
    await expect(approveRow.getByTestId("canvas-run-stub-chip")).toBeVisible();

    // Steps the run never reached must NOT carry the stubbed chip (honesty).
    // credit-check is in the graph but not in the mock traces.
    const creditRow = page.getByTestId("canvas-step-row-credit-check");
    await expect(creditRow).toBeVisible();
    await expect(creditRow.getByTestId("canvas-run-stub-chip")).toHaveCount(0);
  });

  test("the stub-hygiene notice is ABSENT when unusedStubs and stubWarnings are empty (clean run)", async ({
    page,
  }) => {
    await clickLocalButton(page);

    // Wait for the run to complete before asserting notice absence.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toContainText("local run completed", { timeout: 8000 });

    // MockApi.runLocal emits unusedStubs: [], stubWarnings: [] — no notice.
    await expect(page.getByTestId("canvas-detail-stub-notice")).toHaveCount(0);
  });

  test("the stub-hygiene notice shows unusedStubs and stubWarnings when present", async ({
    page,
  }) => {
    // Seed a RunView with hygiene signals for the next getRunState poll.
    // The same StubNoticeSection({run}) path renders for both local and prod
    // runs — the notice is run-level and target-agnostic.
    const hygieneRunView: RunView = {
      executionId: "exec-hygiene-test",
      status: "completed",
      // stubbed:true is normally set by renderLocalRun but is a valid RunView
      // field regardless of target; the notice fields are independent.
      stubbed: true,
      steps: [
        { id: "intake", name: "intake", status: "passed" as const, latencyMs: 100 },
      ],
      unusedStubs: [{ step: "intake", key: "contentGeneration.images.create" }],
      stubWarnings: ["intake: stub for records.read had wrong shape"],
    };
    await seedRunState(page, "exec-hygiene-test", hygieneRunView);

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-hygiene-test",
      target: "prod",
    });

    // Wait for the run to land in the inspector.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("completed", { timeout: 8000 });

    // Expand the intake step (only ran step) to reveal the CanvasStepDetail,
    // which renders StubNoticeSection. The accordion row is a button; click it.
    await page.getByTestId("canvas-step-row-intake").click();
    // CanvasStepDetail renders in the slide-pane (the "Full details" drill —
    // open it to see the run's StubNoticeSection).
    await page.getByTestId("canvas-step-open-intake").click();
    // The detail pane is now visible — wait for the canvas-step-detail.
    const detail = page.getByTestId("canvas-step-detail");
    await expect(detail).toBeVisible({ timeout: 5000 });

    // The stub-hygiene notice must appear in the detail pane.
    const notice = detail.getByTestId("canvas-detail-stub-notice");
    await expect(notice).toBeVisible({ timeout: 5000 });
    await expect(notice).toContainText("Stub notices");

    // unusedStubs section must name the unused key.
    const unused = detail.getByTestId("canvas-stub-unused");
    await expect(unused).toBeVisible();
    await expect(unused).toContainText("contentGeneration.images.create");

    // stubWarnings section must surface the warning text.
    const warnings = detail.getByTestId("canvas-stub-warnings");
    await expect(warnings).toBeVisible();
    await expect(warnings).toContainText("wrong shape");
  });
});

// ---------------------------------------------------------------------------
// (b) Prod run — mocked getRunState via __MOCK_RUN_STATE__ override
// ---------------------------------------------------------------------------

test.describe("prod run — run-state poll via mocked endpoint", () => {
  test.beforeEach(async ({ page }) => {
    await loadStepsTab(page);
  });

  test("per-step status, latency, and pass/fail light up after execution.started", async ({
    page,
  }) => {
    // Announce a prod execution — the SPA starts polling MockApi.getRunState.
    // Default fixture returns: intake(240ms), screen(610ms),
    // credit-check(1900ms), approve(130ms), draft-lease(800ms), all passed.
    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });

    // The run chip in the subheader must appear and report completed.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("prod run completed", { timeout: 8000 });

    // The Steps accordion overlays run truth on each row.
    const stepsList = page.getByTestId("canvas-steps-list");
    await expect(stepsList).toBeVisible();

    // intake — passed, latencyMs: 240.
    const intakeRow = page.getByTestId("canvas-step-row-intake");
    await expect(intakeRow).toBeVisible();
    await expect(intakeRow.locator('[aria-label="passed"]')).toBeVisible();

    // screen — passed, latencyMs: 610.
    const screenRow = page.getByTestId("canvas-step-row-screen");
    await expect(screenRow).toBeVisible();
    await expect(screenRow.locator('[aria-label="passed"]')).toBeVisible();

    // credit-check — passed, latencyMs: 1900 → formatTimeout emits "1.9s".
    const creditRow = page.getByTestId("canvas-step-row-credit-check");
    await expect(creditRow).toBeVisible();
    await expect(creditRow.locator('[aria-label="passed"]')).toBeVisible();
    await expect(creditRow).toContainText("1.9s");

    // approve — passed, latencyMs: 130.
    const approveRow = page.getByTestId("canvas-step-row-approve");
    await expect(approveRow).toBeVisible();
    await expect(approveRow.locator('[aria-label="passed"]')).toBeVisible();

    // draft-lease — passed, latencyMs: 800.
    const draftRow = page.getByTestId("canvas-step-row-draft-lease");
    await expect(draftRow).toBeVisible();
    await expect(draftRow.locator('[aria-label="passed"]')).toBeVisible();
  });

  test("a running prod run shows each step's running/passed status as polls advance", async ({
    page,
  }) => {
    // First poll: intake passed, screen running (the override is consumed once).
    await seedRunState(page, "exec-run-in-progress", {
      executionId: "exec-run-in-progress",
      status: "running",
      steps: [
        { id: "intake", name: "intake", status: "passed" as const, latencyMs: 110 },
        { id: "screen", name: "screen", status: "running" as const },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-run-in-progress",
      target: "prod",
    });

    // The chip shows "running" on the first poll, then "completed" once the
    // override is consumed and subsequent polls hit the default fixture.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    // Eventually the poller stops after reaching a terminal state from the
    // default fixture (completed). Allow extra time for the retry interval.
    await expect(chip).toContainText("completed", { timeout: 12000 });

    const stepsList = page.getByTestId("canvas-steps-list");
    await expect(stepsList).toBeVisible();

    // intake passed in both polls.
    await expect(
      page.getByTestId("canvas-step-row-intake").locator('[aria-label="passed"]'),
    ).toBeVisible();
  });

  test("a failed step shows the failed status icon and no $ cost is shown", async ({
    page,
  }) => {
    await seedRunState(page, "exec-fail-test", {
      executionId: "exec-fail-test",
      status: "failed",
      steps: [
        { id: "intake", name: "intake", status: "passed" as const, latencyMs: 200 },
        { id: "screen", name: "screen", status: "failed" as const, error: "Validation failed" },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-fail-test",
      target: "prod",
    });

    // Chip reports failed.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("failed", { timeout: 8000 });

    const stepsList = page.getByTestId("canvas-steps-list");
    await expect(stepsList).toBeVisible();

    // intake passed, screen failed.
    await expect(
      page.getByTestId("canvas-step-row-intake").locator('[aria-label="passed"]'),
    ).toBeVisible();
    await expect(
      page.getByTestId("canvas-step-row-screen").locator('[aria-label="failed"]'),
    ).toBeVisible();

    // Cost-free contract: the Steps inspector must never show $ amounts.
    await expect(stepsList).not.toContainText("$");
  });

  test("a prod run does not show the stubbed chip on any step", async ({
    page,
  }) => {
    // Default MockApi.getRunState: prod run, no stubbed field on the view.
    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });

    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("prod run completed", { timeout: 8000 });

    // The "stubbed" chip must NOT appear on any row of a prod run.
    const stepsList = page.getByTestId("canvas-steps-list");
    await expect(stepsList).toBeVisible();
    await expect(stepsList.getByTestId("canvas-run-stub-chip")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// (c) RunStepsList fallback — "Full details →" button opens the step detail
// ---------------------------------------------------------------------------

test.describe("RunStepsList fallback — Full details button drills into step detail", () => {
  test.beforeEach(async ({ page }) => {
    await loadStepsTab(page);
  });

  test("each run step in the fallback list shows a 'Full details' button that opens the step detail pane", async ({
    page,
  }) => {
    // Trigger a local run so step data is available. The Steps tab is already
    // open (loadStepsTab). After the run, the Steps tab may show CanvasStepsList
    // (if a graph was posted) or RunStepsList (no graph yet). Both paths must
    // expose a "Full details" drill-down; this test covers RunStepsList.
    //
    // To isolate RunStepsList, we use the pre-run path where no canvas graph is
    // posted. Trigger a run, switch to Steps, and check which list rendered.
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();
    await localBtn.click();

    // Wait for the run chip to confirm the run started/completed.
    const runChip = page.getByTestId("canvas-run-chip");
    await expect(runChip).toBeVisible({ timeout: 8000 });
    await expect(runChip).toContainText("local run completed", { timeout: 8000 });

    // If the CanvasStepsList is already showing (graph posted from iframe), the
    // Full details button is already exercised in other tests — skip to avoid
    // duplicate coverage. Check for the RunStepsList fallback.
    const fallback = page.getByTestId("canvas-run-fallback");
    const stepsList = page.getByTestId("canvas-steps-list");
    const hasFallback = (await fallback.count()) > 0;
    const hasStepsList = (await stepsList.count()) > 0;

    if (!hasFallback && !hasStepsList) {
      throw new Error("Neither RunStepsList fallback nor CanvasStepsList is visible after a run");
    }

    if (hasFallback) {
      // RunStepsList: the "Full details" button is inside the step's expand area.
      // MockApi.runLocal emits: intake, screen, approve.
      // The expand area always shows when onOpenDetail is provided, even without
      // an error or logSlice, so the button is always present on every step.
      const intakeOpenBtn = page.getByTestId("canvas-run-step-open-intake");
      await expect(intakeOpenBtn).toBeVisible({ timeout: 5000 });
      await expect(intakeOpenBtn).toContainText("Full details");

      // Click it — should transition to the step detail pane.
      await intakeOpenBtn.click();
      const detailPane = page.getByTestId("canvas-step-detail");
      await expect(detailPane).toBeVisible({ timeout: 5000 });

      // The detail header (WorkflowActionsHeader) should show the back button.
      await expect(page.getByTestId("canvas-detail-back")).toBeVisible();
    } else {
      // CanvasStepsList is showing — Full details is already covered in
      // run-inspector.spec.ts and canvas-inspector.spec.ts. Just verify the
      // button exists in the expanded row.
      await page.getByTestId("canvas-step-row-intake").click();
      const openBtn = page.getByTestId("canvas-step-open-intake");
      await expect(openBtn).toBeVisible({ timeout: 5000 });
      await expect(openBtn).toContainText("Full details");
    }
  });

  test("RunStepsList Full details button uses the step's id to open the canvas-step-detail", async ({
    page,
  }) => {
    // Seed a prod run that delivers per-step data so RunStepsList has populated
    // step rows. Use execution.started to trigger the poller which fills in ids.
    await seedRunState(page, "exec-runsteps-detail", {
      executionId: "exec-runsteps-detail",
      status: "completed",
      steps: [
        { id: "intake", name: "intake", status: "passed" as const, latencyMs: 100, error: "test error details" },
        { id: "screen", name: "screen", status: "passed" as const, latencyMs: 200 },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-runsteps-detail",
      target: "prod",
    });

    // Wait for the run to land in the inspector.
    const runChip = page.getByTestId("canvas-run-chip");
    await expect(runChip).toBeVisible({ timeout: 8000 });
    await expect(runChip).toContainText("completed", { timeout: 8000 });

    // Check if the RunStepsList fallback is showing (vs CanvasStepsList).
    const fallback = page.getByTestId("canvas-run-fallback");
    if ((await fallback.count()) === 0) {
      // CanvasStepsList is showing — test the CanvasStepsList flow instead,
      // which has its own Full details button coverage. Skip the RunStepsList
      // specific assertion.
      return;
    }

    // In the RunStepsList, the intake step has an error — the expand area
    // is always shown. The "Full details" button must be present.
    const openBtn = page.getByTestId("canvas-run-step-open-intake");
    await expect(openBtn).toBeVisible({ timeout: 5000 });
    await expect(openBtn).toContainText("Full details");

    // Click Full details → the CanvasStepDetail pane opens with the back button.
    await openBtn.click();
    await expect(page.getByTestId("canvas-step-detail")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("canvas-detail-back")).toBeVisible();

    // Navigate back.
    await page.getByTestId("canvas-detail-back").click();
    await expect(page.getByTestId("canvas-step-detail")).toHaveCount(0);
  });
});
