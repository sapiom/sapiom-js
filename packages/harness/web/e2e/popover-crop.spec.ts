/**
 * Popover crop audit: every floating menu/panel in the app opens inside a
 * deliberately tight 900x600 viewport, with each trigger sitting near a
 * container edge (rail footer, header right cluster, composer bottom row).
 * Two assertions per surface:
 *   1. The popover's bounding box lies fully inside the viewport.
 *   2. No ancestor clips it — elementFromPoint at all four corners (inset
 *      past the border radius) must resolve to the popover or a descendant.
 * Anything cropped by a scroller, an overflow clip, or the viewport edge
 * fails one of the two.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ viewport: { width: 900, height: 600 } });

test.beforeEach(async ({ page }) => {
  // Kills the pop-in scale so measurements are resting geometry — and doubles
  // as a regression check that every popover honors reduced motion.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

async function expectUncropped(page: Page, popover: Locator): Promise<void> {
  await expect(popover).toBeVisible();
  // Belt and braces: wait out any animation that slipped past reduced motion.
  await popover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => null))));

  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x, "left edge inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box!.y, "top edge inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "right edge inside the viewport").toBeLessThanOrEqual(viewport!.width + 0.5);
  expect(box!.y + box!.height, "bottom edge inside the viewport").toBeLessThanOrEqual(viewport!.height + 0.5);

  // Corner hit-test, inset 10px so the rounded corner radius (8px) never
  // reads as a false crop: each probe must land on the popover itself.
  const corners = await popover.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const inset = 10;
    const points: Array<[number, number]> = [
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
    ];
    return points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit != null && (hit === el || el.contains(hit));
    });
  });
  expect(corners, "all four corners hit the popover, not an occluding clip").toEqual([true, true, true, true]);
}

test("history menu opens uncropped off the rail header", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await expectUncropped(page, page.getByTestId("history-menu"));
});

test("profile menu opens uncropped off the rail footer", async ({ page }) => {
  await page.getByTestId("brand-identity").click();
  await expectUncropped(page, page.getByTestId("profile-menu"));
});

test("settings popover opens uncropped off the rail footer", async ({ page }) => {
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("settings-trigger").click();
  await expectUncropped(page, page.getByTestId("settings-popover"));
});

test("session bar menu opens uncropped at the header's right cluster", async ({ page }) => {
  await page.getByTestId("session-menu").click();
  await expectUncropped(page, page.getByTestId("session-menu-popover"));
});

test("harness picker opens uncropped over the new-session dialog", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();
  await page.getByTestId("harness-select").click();
  await expectUncropped(page, page.getByTestId("harness-select-menu"));
});

test("canvas run picker and step detail menu open uncropped at the right pane's edge", async ({ page }) => {
  // Load the workflow graph, then observe two runs so the chip becomes the
  // run picker (same events the agent's MCP calls emit).
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  const publishRun = (executionId: string): Promise<void> =>
    page.evaluate((id) => {
      (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId: id,
        target: "prod",
      });
    }, executionId);
  await publishRun("exec-crop-1");
  await publishRun("exec-crop-2");

  await page.getByTestId("right-tab-steps").click();
  await page.getByTestId("canvas-run-chip").click();
  await expectUncropped(page, page.getByTestId("canvas-run-menu"));
  await page.keyboard.press("Escape");

  // The step-detail ⋯ menu sits at the pane's far right — the down-end
  // placement must still land fully on screen. "Full details" lives inside
  // the expanded step row, so expand it first.
  await page.getByTestId("canvas-step-row-approve").click();
  await page.getByTestId("canvas-step-open-approve").click();
  await page.getByTestId("canvas-detail-menu").click();
  await expectUncropped(page, page.getByTestId("canvas-detail-menu-popover"));
});
