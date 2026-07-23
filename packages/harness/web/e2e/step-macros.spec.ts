/**
 * Step-click debug macros e2e coverage (SAP-1900).
 *
 * Contract under test — the CanvasStepInspector (board bottom-panel) now
 * carries three debug-macro buttons and a free-form ask textarea, all
 * injecting into the active session's terminal via harness.injectInput.
 *
 * Coverage:
 *  - Picking a board node surfaces the macro bar in the inspector.
 *  - "Debug this step" calls injectInput with the step's context + question.
 *  - "Why is this step slow / stuck?" and "Explain this step" do the same.
 *  - Free-form textarea + Ask button inject a custom question.
 *  - Cmd+Enter in the free-form textarea also triggers inject.
 *  - The injected payload contains the step name (from extractStepContext).
 *  - A prod-run step (with run data) includes its status in the payload.
 *  - No macro bar is rendered when the inspector is absent (no node picked).
 *
 * All tests run in mock mode (VITE_MOCK=1) against the sess-boot session
 * whose canvas document is bundled at public/canvas/sess-boot/. The
 * window.__HARNESS_TEST__.lastInjectInput escape hatch (same pattern as
 * direct-actions.spec.ts and snippet-panel.spec.ts) lets Playwright read
 * the inject call without a real PTY.
 */
import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Navigate to a clean slate with the Canvas board visible. */
const loadBoard = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  // Trigger canvas load so the board document populates the iframe.
  await page.evaluate(() => {
    (
      window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }
    ).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
};

/** Click a board node through the gesture layer to populate the inspector. */
const pickNode = async (page: Page, nodeId: string): Promise<void> => {
  const node = page.frameLocator(".canvas-iframe").locator(`[data-node-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  // Wait for auto-fit so the zoom isn't still 100%.
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const box = await node.boundingBox();
  if (!box) throw new Error(`${nodeId} node has no bounding box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** Poll for the last inject recorded by MockApi.injectInput (mock delay is ~180ms). */
const lastInject = async (page: Page): Promise<{ id: string; req: { text: string; submit: boolean } }> => {
  let result: { id: string; req: { text: string; submit: boolean } } | null = null;
  await expect.poll(async () => {
    result = await page.evaluate(() => {
      const win = window as unknown as {
        __HARNESS_TEST__?: { lastInjectInput?: { id: string; req: { text: string; submit: boolean } } };
      };
      return win.__HARNESS_TEST__?.lastInjectInput ?? null;
    });
    return result;
  }, { timeout: 3000, message: "expected lastInjectInput to be set after mock delay" }).not.toBeNull();
  return result!;
};

/** Clear the lastInjectInput slot so the next assertion is unambiguous. */
const clearLastInject = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
    if (win.__HARNESS_TEST__) delete win.__HARNESS_TEST__["lastInjectInput"];
  });

/** Publish a bus message via the test hook. */
const publish = (page: Page, message: unknown): Promise<void> =>
  page.evaluate((msg) => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish(msg);
  }, message);

/** Seed a custom RunView for MockApi.getRunState to return once. */
const seedRunState = (page: Page, executionId: string, view: RunView): Promise<void> =>
  page.evaluate(
    ([id, v]) => {
      const win = window as unknown as { __MOCK_RUN_STATE__?: Record<string, unknown> };
      win.__MOCK_RUN_STATE__ = { ...(win.__MOCK_RUN_STATE__ ?? {}), [id]: v };
    },
    [executionId, view] as [string, RunView],
  );

// ---------------------------------------------------------------------------
// Macro bar visibility
// ---------------------------------------------------------------------------

test.describe("macro bar visibility", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("picking a board node shows the macro bar in the inspector", async ({ page }) => {
    // No inspector yet — macro bar absent.
    await expect(page.getByTestId("canvas-inspector-macros")).toHaveCount(0);

    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");

    // The macro bar should be visible inside the inspector.
    const macros = page.getByTestId("canvas-inspector-macros");
    await expect(macros).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-debug")).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-slow")).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-explain")).toBeVisible();
    await expect(macros.getByTestId("canvas-freeform-input")).toBeVisible();
  });

  test("closing the inspector hides the macro bar", async ({ page }) => {
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();

    await page.getByTestId("canvas-inspector-close").click();
    await expect(page.getByTestId("canvas-inspector-macros")).toHaveCount(0);
  });

  test("Esc also dismisses the inspector and the macro bar", async ({ page }) => {
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("canvas-inspector-macros")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Macro inject — no run data (graph-only / pre-run)
// ---------------------------------------------------------------------------

test.describe("debug macros — pre-run (no run data)", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();
    await clearLastInject(page);
  });

  test("'Debug this step' injects the step context + question", async ({ page }) => {
    await page.getByTestId("canvas-macro-debug").click();

    const inject = await lastInject(page);
    // The step name must appear in the context block.
    expect(inject.req.text).toContain("Step: intake");
    // The question must be appended.
    expect(inject.req.text).toContain("Debug this step");
    // Session id should be the active mock session.
    expect(inject.id).toBe("sess-boot");
  });

  test("'Why is this step slow / stuck?' injects the right question", async ({ page }) => {
    await page.getByTestId("canvas-macro-slow").click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("Why is this step slow / stuck?");
  });

  test("'Explain this step' injects the right question", async ({ page }) => {
    await page.getByTestId("canvas-macro-explain").click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("Explain this step");
  });

  test("free-form Ask injects the typed question", async ({ page }) => {
    const freeform = page.getByTestId("canvas-freeform-input");
    await freeform.fill("What does this step produce?");
    await clearLastInject(page);

    // Ask button should be enabled now.
    const askBtn = page.getByTestId("canvas-freeform-ask");
    await expect(askBtn).toBeEnabled();
    await askBtn.click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("What does this step produce?");
    // Textarea should clear after submit.
    await expect(freeform).toHaveValue("");
  });

  test("Cmd+Enter in the free-form textarea submits", async ({ page }) => {
    const freeform = page.getByTestId("canvas-freeform-input");
    await freeform.fill("Any edge cases?");
    await clearLastInject(page);

    await freeform.press("Meta+Enter");

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Any edge cases?");
    await expect(freeform).toHaveValue("");
  });

  test("Ask button is disabled when the freeform is empty", async ({ page }) => {
    const askBtn = page.getByTestId("canvas-freeform-ask");
    await expect(askBtn).toBeDisabled();
  });

  test("no $ cost appears in the injected context (cost-free contract)", async ({ page }) => {
    await page.getByTestId("canvas-macro-debug").click();
    const inject = await lastInject(page);
    // The injected text must contain no dollar signs (no spend/cost data).
    expect(inject.req.text).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// Macro inject — with run data (prod run)
// ---------------------------------------------------------------------------

test.describe("debug macros — prod run data enriches the context", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the step's run status appears in the injected context", async ({ page }) => {
    // Announce a prod run so the inspector carries run truth.
    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });

    // Navigate to the Steps tab to confirm the run landed (reliable chip location).
    await page.getByTestId("right-tab-steps").click();
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("prod run completed", { timeout: 8000 });

    // Back to the Canvas board and pick intake. No second loadBoard — the
    // board is already loaded from beforeEach; re-triggering canvas.reload
    // races with the node pick and clears the run from the inspector.
    await page.getByTestId("right-tab-canvas").click();
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();
    // Run data is in state (chip confirmed above); inspector must show it.
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });
    await clearLastInject(page);

    await page.getByTestId("canvas-macro-debug").click();

    const inject = await lastInject(page);
    // Run data from the prod run: status "passed" is in the context.
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("Status: passed");
    expect(inject.req.text).not.toContain("$");
  });

  test("the 'Debug this step' button is styled primary on a failed step", async ({ page }) => {
    await seedRunState(page, "exec-fail-intake", {
      executionId: "exec-fail-intake",
      status: "failed",
      steps: [
        { id: "intake", name: "intake", status: "failed" as const, error: "Validation error" },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-fail-intake",
      target: "prod",
    });

    // Navigate to steps tab to confirm the run landed (run chip is always
    // visible there regardless of canvas state).
    await page.getByTestId("right-tab-steps").click();
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("failed", { timeout: 8000 });

    // Back to the board to pick the failed step. No second loadBoard — the
    // board is already loaded from beforeEach; re-triggering canvas.reload
    // races with the node pick and clears the run from the inspector.
    await page.getByTestId("right-tab-canvas").click();
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();
    // Run data is in state (chip confirmed above); inspector must show it.
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    // "Debug this step" should be btn-primary on a failed step.
    await expect(page.getByTestId("canvas-macro-debug")).toHaveClass(/btn-primary/);
    // The other macros stay ghost.
    await expect(page.getByTestId("canvas-macro-slow")).toHaveClass(/btn-ghost/);
    await expect(page.getByTestId("canvas-macro-explain")).toHaveClass(/btn-ghost/);
  });
});

// ---------------------------------------------------------------------------
// Macro inject — offline stub run
// ---------------------------------------------------------------------------

test.describe("debug macros — offline stub run", () => {
  test("the macro bar appears after a local stub run and includes run status", async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-steps").click();

    // Trigger the local run via the run-input dialog.
    const btn = page.getByTestId("session-step-local");
    await expect(btn).toBeEnabled();
    await btn.click();
    // The run-input dialog opens; click Run to confirm with the default input.
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });
    await page.getByTestId("run-input-submit").click();

    // Wait for the run to complete.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("local run completed", { timeout: 8000 });

    // Switch to the Canvas tab. The board is already mounted (mock auto-shows
    // the frame for sess-boot); no need to re-trigger canvas.reload which would
    // race with the node pick and clear the run from the inspector.
    await page.getByTestId("right-tab-canvas").click();
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();
    // Run data is in state (chip confirmed above); inspector must show it.
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });
    await clearLastInject(page);

    await page.getByTestId("canvas-macro-debug").click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    // Local run sets status: "passed" for intake.
    expect(inject.req.text).toContain("Status: passed");
    expect(inject.req.text).not.toContain("$");
  });
});
