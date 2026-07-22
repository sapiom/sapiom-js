/**
 * Canvas step inspector: the bottom overview panel is selection-driven.
 *
 * Contract under test:
 * - A board node pick (the document's {type:"sapiom-canvas:node"} answer)
 *   populates the bottom panel with that step's detail IN PLACE — the right
 *   pane stays on the Canvas tab; the Steps tab is only the inspector's
 *   explicit "Open in Steps" drill.
 * - Deselect (Esc / empty board space / the panel's close) restores the
 *   general workflow overview unchanged.
 * - Height hugs the content up to half the canvas pane; taller content
 *   scrolls inside the panel.
 * - Dragging the panel's top edge sets a manual height (persisted in
 *   ui-prefs); double-clicking the handle resets to auto-hug.
 * - When a run has been observed, the selected step's inspector carries its
 *   run truth (status, duration) — the Studio surface is cost-free.
 */
import { expect, test, type Page } from "@playwright/test";

const loadBoard = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
};

/** Waits out the auto-fit (the document posts its size async), then clicks
 *  the node's center through the gesture layer. */
const pickNode = async (page: Page, nodeId: string): Promise<void> => {
  const node = page.frameLocator(".canvas-iframe").locator(`[data-node-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const box = await node.boundingBox();
  if (!box) throw new Error(`${nodeId} node has no box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await loadBoard(page);
});

test("a board pick populates the inspector in place, with no tab switch", async ({ page }) => {
  // The overview panel shows the workflow-level copy before any pick.
  const panel = page.getByTestId("canvas-overview");
  await expect(panel).toContainText("Overview");
  await expect(panel).toContainText("Handles lease applications end to end");

  await pickNode(page, "intake");

  // Same panel, now the picked step's live detail — and the right pane
  // never left the Canvas tab.
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
  await expect(page.getByTestId("right-tab-canvas")).toHaveClass(/is-active/);
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  const inspector = page.getByTestId("canvas-step-inspector");
  await expect(inspector).toContainText("Logs the incoming order");
  // Contract chips and transitions render from the posted graph.
  await expect(inspector).toContainText("records.read");
  await expect(inspector).toContainText("screen");

  // A transition row retargets the selection without leaving the board.
  await inspector.locator(".canvas-step-transition.is-link").filter({ hasText: "screen" }).click();
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("screen");
  await expect(page.getByTestId("right-tab-canvas")).toHaveClass(/is-active/);

  // "Open in Steps" is the explicit full-pane drill.
  await page.getByTestId("canvas-inspector-open-steps").click();
  await expect(page.getByTestId("right-tab-steps")).toHaveClass(/is-active/);
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "detail");
  await expect(page.getByTestId("canvas-detail-title")).toHaveText("screen");
});

test("deselect restores the overview: Esc, the panel's close, and empty board space", async ({ page }) => {
  const panel = page.getByTestId("canvas-overview");

  // Esc clears the selection back to the overview.
  await pickNode(page, "intake");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-step-inspector")).toHaveCount(0);
  await expect(panel).toContainText("Handles lease applications end to end");
  await expect(panel).toContainText("4 steps");

  // The panel's own close affordance does the same.
  await pickNode(page, "intake");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
  await page.getByTestId("canvas-inspector-close").click();
  await expect(panel).toContainText("Handles lease applications end to end");

  // Clicking empty board space deselects too. Hover the empty point first
  // so the document's hit answer (no node) lands before the click.
  await pickNode(page, "intake");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
  const board = await page.getByTestId("canvas-pan-layer").boundingBox();
  if (!board) throw new Error("board has no box");
  const emptyX = board.x + board.width - 12;
  const emptyY = board.y + 12;
  await page.mouse.move(emptyX, emptyY, { steps: 2 });
  await expect(page.getByTestId("canvas-pan-layer")).not.toHaveAttribute("data-over-node", "true");
  await page.mouse.click(emptyX, emptyY);
  await expect(page.getByTestId("canvas-step-inspector")).toHaveCount(0);
  await expect(panel).toContainText("Handles lease applications end to end");
});

test("the panel hugs its content up to half the pane; taller content scrolls inside", async ({ page }) => {
  // A short pane makes the 50% cap bite: the inspector's content for a
  // contract-heavy step is taller than half the pane at this height.
  // Collapse the overview first so the whole cascade stays clickable.
  await page.setViewportSize({ width: 1280, height: 560 });
  await loadBoard(page);
  await page.getByTestId("canvas-overview-toggle").click();
  await pickNode(page, "credit-check");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("credit-check");

  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="canvas-overview"]') as HTMLElement;
    const pane = panel.parentElement as HTMLElement;
    const body = panel.querySelector(".canvas-overview-body") as HTMLElement;
    return {
      panel: panel.getBoundingClientRect().height,
      pane: pane.getBoundingClientRect().height,
      scrollable: body.scrollHeight > body.clientHeight,
    };
  });
  expect(metrics.panel).toBeLessThanOrEqual(metrics.pane * 0.5 + 2);
  expect(metrics.scrollable).toBe(true);

  // Deselecting leaves the collapsed overview collapsed: the panel yields
  // to its ⓘ reopen affordance, exactly the pre-pick arrangement.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-step-inspector")).toHaveCount(0);
  await expect(page.getByTestId("canvas-overview")).toHaveCount(0);
  await expect(page.getByTestId("canvas-overview-toggle")).toBeVisible();
});

test("dragging the top edge resizes the panel and persists; double-click resets to auto", async ({
  page,
}) => {
  const panel = page.getByTestId("canvas-overview");
  const handle = page.getByTestId("canvas-overview-resize");
  await expect(handle).toHaveAttribute("role", "separator");
  await expect(handle).toHaveCSS("cursor", "row-resize");

  const before = (await panel.boundingBox())?.height ?? 0;
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("resize handle has no box");
  const x = handleBox.x + handleBox.width / 2;
  const y = handleBox.y + handleBox.height / 2;

  // Drag up 80px: the panel grows (clamped to half the pane).
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 80, { steps: 4 });
  await page.mouse.up();
  const grown = (await panel.boundingBox())?.height ?? 0;
  expect(grown).toBeGreaterThan(before + 40);

  // The manual height persists in ui-prefs alongside the rest of the
  // arrangement.
  const stored = await page.evaluate(
    () =>
      (JSON.parse(window.localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}") as {
        canvasInspectorHeight?: number | null;
      }).canvasInspectorHeight,
  );
  expect(typeof stored).toBe("number");
  expect(Math.abs((stored as number) - grown)).toBeLessThanOrEqual(2);

  // Double-click the handle: back to auto-hug (the pre-drag height).
  await handle.dblclick();
  await expect
    .poll(async () => (await panel.boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(before + 2);
  const cleared = await page.evaluate(
    () =>
      (JSON.parse(window.localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}") as {
        canvasInspectorHeight?: number | null;
      }).canvasInspectorHeight,
  );
  expect(cleared).toBeNull();
});

test("an observed run's truth reaches the selected step's inspector", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });
  });
  // The run's cost reaches the steps header once the mock run-state poll
  // lands; wait for it so the inspector below reads settled data.
  await pickNode(page, "credit-check");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("credit-check");
  const run = page.getByTestId("canvas-inspector-run");
  // The Studio is cost-free: the inspector carries the run's status and
  // latency only (logs + pass/fail), never money.
  await expect(run).toContainText("passed");
  await expect(run).toContainText("1.9s");
  await expect(run).not.toContainText("$");

  // Another step carries the same run truth (status + latency).
  await page.keyboard.press("Escape");
  await pickNode(page, "intake");
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
  await expect(page.getByTestId("canvas-inspector-run")).toContainText("passed");
  await expect(page.getByTestId("canvas-inspector-run")).not.toContainText("$");
});
