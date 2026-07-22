/**
 * Mobile shell (<=768px) — the three-pane layout folds to one column: the
 * center pane owns the viewport, the workspace rail opens as an overlay
 * drawer and the right pane as a bottom sheet, both reusing the desktop
 * collapse state (UX-01). Same mock fixtures as smoke.spec.ts.
 */
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

/** Geometry assertions must not race the 300ms drawer/sheet entrance —
 *  boundingBox() reads mid-flight transforms otherwise. */
async function settled(el: Locator): Promise<void> {
  await el.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".session-bar")).toBeVisible();
});

test("folds to one column: both side panes start collapsed and nothing overflows sideways", async ({ page }) => {
  // Collapsed panes surface their expand affordances in the session bar.
  await expect(page.getByTestId("rail-expand")).toBeVisible();
  await expect(page.getByTestId("right-expand")).toBeVisible();
  // The rail unmounts when collapsed; the right pane only CSS-hides so a
  // running Visualize enrichment survives (same contract as desktop).
  await expect(page.locator(".rail-workflows")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toBeHidden();
  await expect(page.locator(".right-pane")).toHaveCount(1);
  // Drag handles are desktop-only — overlays have no boundary to drag.
  await expect(page.getByTestId("resize-handle-rail")).toHaveCount(0);
  await expect(page.getByTestId("resize-handle-canvas")).toHaveCount(0);

  // The whole page fits 375 edge to edge — no horizontal scroll or clipping.
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBe(0);

  await page.screenshot({ path: "web/e2e/screenshots/mobile-shell.png" });
});

test("rail opens as a drawer and closes on opening a workflow or a scrim tap", async ({ page }) => {
  await page.getByTestId("rail-expand").click();
  const rail = page.locator(".rail-workflows");
  await expect(rail).toBeVisible();
  await settled(rail);
  // Overlay, not a column: pinned to the left edge, narrower than the
  // viewport so a sliver of the page stays visible behind the scrim.
  const box = await rail.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(375);
  await page.screenshot({ path: "web/e2e/screenshots/mobile-drawer.png" });

  // Opening a workflow is a destination pick — it changes what the main panel
  // shows (here, rfq's honest "start a session" state), so it closes the
  // drawer it overlays. One verb, one gesture.
  await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
  await expect(rail).toHaveCount(0);
  await expect(page.getByTestId("open-agent-empty")).toContainText("No running session for rfq");

  // The scrim's exposed sliver (right of the drawer) dismisses on tap.
  await page.getByTestId("rail-expand").click();
  await expect(rail).toBeVisible();
  await page.getByTestId("rail-drawer-scrim").click({ position: { x: 360, y: 400 } });
  await expect(rail).toHaveCount(0);
});

test("right pane opens as a bottom sheet and dismisses from its own collapse control", async ({ page }) => {
  await page.getByTestId("right-expand").click();
  const pane = page.locator(".right-pane");
  await expect(pane).toBeVisible();
  await settled(pane);
  // Sheet anatomy: full width, anchored to the bottom, one header height of
  // the page left visible above as context.
  const box = await pane.boundingBox();
  expect(box?.width).toBe(375);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBe(812);
  expect(box?.y ?? 0).toBeGreaterThan(0);
  await page.screenshot({ path: "web/e2e/screenshots/mobile-sheet.png" });

  await page.getByTestId("right-collapse").click();
  await expect(pane).toBeHidden();
  // Hidden, not unmounted — the keep-alive contract holds on mobile too.
  await expect(pane).toHaveCount(1);
});
