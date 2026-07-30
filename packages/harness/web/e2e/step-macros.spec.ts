/**
 * Step debug macros e2e coverage.
 *
 * Contract under test — the Steps tab carries three debug-macro buttons and a
 * free-form ask textarea per run step, visible in the step's expanded area.
 * In `CanvasStepsList` (graph present), clicking a step row expands it and
 * shows the macros when a run has been observed and a live session exists.
 * In `RunStepsList` (no-graph fallback), the macros appear in the always-shown
 * expand area below the Logs block.
 *
 * Coverage:
 *  - Expanding a step row in the Steps tab shows the macro block.
 *  - "Debug this step" calls injectInput with the step's context + question.
 *  - "Why is this step slow / stuck?" and "Explain this step" do the same.
 *  - Free-form textarea + Ask button inject a custom question.
 *  - Cmd+Enter in the free-form textarea also triggers inject.
 *  - The injected payload contains the step name (from extractStepContext).
 *  - A prod-run step includes its status in the payload.
 *  - "Debug this step" is primary-styled on a failed step, ghost otherwise.
 *
 * All tests run in mock mode (VITE_MOCK=1) against the sess-boot session whose
 * canvas document is bundled at public/canvas/sess-boot/. The
 * window.__HARNESS_TEST__.lastInjectInput escape hatch lets Playwright read the
 * inject call without a real PTY.
 */
import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Navigate to a clean slate and wait for the rail to appear. */
const loadApp = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
};

/**
 * Navigate to a clean slate, trigger a canvas.reload so the board mounts,
 * and wait for the iframe. The chat panel and board-pick tests need a live
 * board with a posted graph before they can interact.
 */
const loadBoard = async (page: Page): Promise<void> => {
  await loadApp(page);
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-iframe")).toBeVisible();
};

/**
 * Click the board node with the given id via the gesture layer's pick message,
 * then wait for the inspector to show (canvas-inspector-title matches the label).
 */
const pickNode = async (page: Page, nodeId: string): Promise<void> => {
  const boardFrame = page.frameLocator(".canvas-frame-wrap iframe");
  const node = boardFrame.locator(`[data-node-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  const box = await node.boundingBox();
  if (!box) throw new Error(`node ${nodeId} has no bounding box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText(new RegExp(nodeId));
};

/** Switch to the Steps tab. */
const openStepsTab = async (page: Page): Promise<void> => {
  await page.getByTestId("right-tab-steps").click();
  await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
};

/** Open the standalone chat panel (macros + ask) via the 💬 toggle — closed by
 *  default now, independent of the step inspector. */
const openChat = async (page: Page): Promise<void> => {
  await page.getByTestId("canvas-chat-toggle").click();
  await expect(page.getByTestId("canvas-chat-panel")).toBeVisible();
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

/**
 * Trigger a local run, wait for completion chip. Starts on the Steps tab so
 * the chip is always visible.
 */
const triggerLocalRunAndWait = async (page: Page): Promise<void> => {
  await openStepsTab(page);
  const btn = page.getByTestId("session-step-local");
  await expect(btn).toBeEnabled();
  await btn.click();
  const chip = page.getByTestId("canvas-run-chip");
  await expect(chip).toBeVisible({ timeout: 8000 });
  await expect(chip).toContainText("local run completed", { timeout: 8000 });
};

/**
 * Expand the first step row in the Steps tab (works for both CanvasStepsList
 * and RunStepsList). In CanvasStepsList, rows need to be clicked to expand.
 * In RunStepsList, the expand area is always shown when macros are present.
 */
const expandFirstStep = async (page: Page): Promise<void> => {
  // Try CanvasStepsList row click first (row-intake is the first step in the
  // mock canvas graph). Fall back gracefully if not present.
  const stepRow = page.getByTestId("canvas-step-row-intake");
  if (await stepRow.count() > 0) {
    await stepRow.click();
    await expect(page.getByTestId("canvas-step-expand-intake")).toBeVisible();
  }
  // RunStepsList expand area is always visible — no click needed.
};

// ---------------------------------------------------------------------------
// Macro bar visibility in Steps tab
// ---------------------------------------------------------------------------

test.describe("macro bar visibility in Steps tab", () => {
  test("macros appear in a step's expanded area after a run", async ({ page }) => {
    await loadApp(page);
    await triggerLocalRunAndWait(page);
    await expandFirstStep(page);

    // The macro block should be present in the expanded area.
    const macros = page.getByTestId("step-macros").first();
    await expect(macros).toBeVisible();
    await expect(macros.getByTestId("step-macro-debug")).toBeVisible();
    await expect(macros.getByTestId("step-macro-slow")).toBeVisible();
    await expect(macros.getByTestId("step-macro-explain")).toBeVisible();
    await expect(macros.getByTestId("step-freeform-input")).toBeVisible();
  });

  test("macros appear on step expand even without a run (per-step, not run-gated)", async ({ page }) => {
    await loadApp(page);
    await openStepsTab(page);
    // No run yet — expanding a step STILL shows the debug macros. A not-yet-run
    // step injects its name/structure (Explain / free-form work); run data
    // enriches them once it exists. The macros live per step, not behind a run.
    const stepRow = page.getByTestId("canvas-step-row-intake");
    await expect(stepRow).toBeVisible();
    await stepRow.click();
    await expect(page.getByTestId("canvas-step-expand-intake")).toBeVisible();
    const macros = page.getByTestId("step-macros").first();
    await expect(macros).toBeVisible();
    await expect(macros.getByTestId("step-macro-explain")).toBeVisible();
    await expect(macros.getByTestId("step-freeform-input")).toBeVisible();
  });
});

test.describe("chat panel visibility", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the chat is closed by default and opens via the 💬 toggle", async ({ page }) => {
    // Closed by default — no chat/macros on load.
    await expect(page.getByTestId("canvas-chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("canvas-inspector-macros")).toHaveCount(0);

    await openChat(page);
    // With no step selected the chat is a general ask — freeform only, no
    // step-specific macros.
    await expect(page.getByTestId("canvas-freeform-input")).toBeVisible();
    await expect(page.getByTestId("canvas-macro-debug")).toHaveCount(0);
  });

  test("picking a step surfaces the step macros in the chat", async ({ page }) => {
    await openChat(page);
    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");

    const macros = page.getByTestId("canvas-inspector-macros");
    await expect(macros.getByTestId("canvas-macro-debug")).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-slow")).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-explain")).toBeVisible();
    await expect(macros.getByTestId("canvas-freeform-input")).toBeVisible();
  });

  test("the chat closes on its own X — independent of the step inspector", async ({ page }) => {
    await pickNode(page, "intake");
    await openChat(page);
    // Both open at once: the step inspector (info) AND the chat.
    await expect(page.getByTestId("canvas-step-inspector")).toBeVisible();
    await expect(page.getByTestId("canvas-chat-panel")).toBeVisible();

    // Closing the chat leaves the inspector untouched.
    await page.getByTestId("canvas-chat-close").click();
    await expect(page.getByTestId("canvas-chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("canvas-step-inspector")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Macro inject — local stub run
// ---------------------------------------------------------------------------

test.describe("debug macros — local stub run", () => {
  test.beforeEach(async ({ page }) => {
    await loadApp(page);
    await triggerLocalRunAndWait(page);
    await expandFirstStep(page);
    // Confirm macros are visible.
    await expect(page.getByTestId("step-macros").first()).toBeVisible();
    await clearLastInject(page);
  });

  test("'Debug this step' injects the step context + question", async ({ page }) => {
    await page.getByTestId("step-macro-debug").first().click();

    const inject = await lastInject(page);
    // The step name must appear in the context block.
    expect(inject.req.text).toContain("Step: intake");
    // The question must be appended after double newline.
    expect(inject.req.text).toContain("\n\nDebug this step");
    // Session id should be the active mock session.
    expect(inject.id).toBe("sess-boot");
  });

  test("'Why is this step slow / stuck?' injects the right question", async ({ page }) => {
    await page.getByTestId("step-macro-slow").first().click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("Why is this step slow / stuck?");
  });

  test("'Explain this step' injects the right question", async ({ page }) => {
    await page.getByTestId("step-macro-explain").first().click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("Explain this step");
  });

  test("free-form Ask injects the typed question", async ({ page }) => {
    const freeform = page.getByTestId("step-freeform-input").first();
    await freeform.fill("What does this step produce?");
    await clearLastInject(page);

    const askBtn = page.getByTestId("step-freeform-ask").first();
    await expect(askBtn).toBeEnabled();
    await askBtn.click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("What does this step produce?");
    // Textarea should clear after submit.
    await expect(freeform).toHaveValue("");
  });

  test("Cmd+Enter in the free-form textarea submits", async ({ page }) => {
    const freeform = page.getByTestId("step-freeform-input").first();
    await freeform.fill("Any edge cases?");
    await clearLastInject(page);

    await freeform.press("Meta+Enter");

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Any edge cases?");
    await expect(freeform).toHaveValue("");
  });

  test("Ask button is disabled when the freeform is empty", async ({ page }) => {
    const askBtn = page.getByTestId("step-freeform-ask").first();
    await expect(askBtn).toBeDisabled();
  });

  test("no $ cost appears in the injected context (cost-free contract)", async ({ page }) => {
    await page.getByTestId("step-macro-debug").first().click();
    const inject = await lastInject(page);
    // The injected text must contain no dollar signs (no spend/cost data).
    expect(inject.req.text).not.toContain("$");
  });

  test("run status appears in the injected context", async ({ page }) => {
    await page.getByTestId("step-macro-debug").first().click();

    const inject = await lastInject(page);
    // Local run sets status: "passed" for intake.
    expect(inject.req.text).toContain("Status: passed");
  });
});

// ---------------------------------------------------------------------------
// Macro inject — prod run data enriches the context
// ---------------------------------------------------------------------------

test.describe("debug macros — prod run data enriches the context", () => {
  test("the step's run status appears in the injected context", async ({ page }) => {
    await loadApp(page);

    // Announce a prod run.
    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });

    await openStepsTab(page);
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("prod run completed", { timeout: 8000 });

    await expandFirstStep(page);
    await expect(page.getByTestId("step-macros").first()).toBeVisible();
    await clearLastInject(page);

    await page.getByTestId("step-macro-debug").first().click();

    const inject = await lastInject(page);
    expect(inject.req.text).toContain("Step: intake");
    expect(inject.req.text).toContain("Status: passed");
    expect(inject.req.text).not.toContain("$");
  });

  test("'Debug this step' button is styled primary on a failed step", async ({ page }) => {
    await loadApp(page);

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

    await openStepsTab(page);
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("failed", { timeout: 8000 });

    await expandFirstStep(page);
    await expect(page.getByTestId("step-macros").first()).toBeVisible();

    // "Debug this step" for the failed step should be btn-primary.
    const debugBtn = page.getByTestId("step-macro-debug").first();
    await expect(debugBtn).toHaveClass(/btn-primary/);
    // The other macros stay ghost.
    await expect(page.getByTestId("step-macro-slow").first()).toHaveClass(/btn-ghost/);
    await expect(page.getByTestId("step-macro-explain").first()).toHaveClass(/btn-ghost/);
  });
});

// ---------------------------------------------------------------------------
// Macro inject — offline stub run (canvas chat panel path)
// ---------------------------------------------------------------------------

test.describe("debug macros — offline stub run", () => {
  test("the macro bar appears after a local stub run and includes run status", async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-steps").click();

    // Trigger the local run.
    const btn = page.getByTestId("session-step-local");
    await expect(btn).toBeEnabled();
    await btn.click();

    // Wait for the run to complete.
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("local run completed", { timeout: 8000 });

    // Switch to the Canvas tab. The board is already mounted (mock auto-shows
    // the frame for sess-boot); no need to re-trigger canvas.reload which would
    // race with the node pick and clear the run from the inspector.
    await page.getByTestId("right-tab-canvas").click();
    await pickNode(page, "intake");
    await openChat(page);
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
