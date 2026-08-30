/**
 * Mobile shell (<=768px) — the three-pane layout folds to one column: the
 * center pane owns the viewport, the workspace rail opens as an overlay
 * drawer and the right pane as a bottom sheet, both reusing the desktop
 * collapse state. Same mock fixtures as smoke.spec.ts.
 */
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

test.use({ viewport: { width: 375, height: 812 } });

/** Geometry assertions must not race the 300ms drawer/sheet entrance —
 *  boundingBox() reads mid-flight transforms otherwise. */
async function settled(el: Locator): Promise<void> {
  await el.evaluate((node) =>
    Promise.all(node.getAnimations().map((a) => a.finished)),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".session-bar")).toBeVisible();
});

test("folds to one column: both side panes start collapsed and nothing overflows sideways", async ({
  page,
}) => {
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

test("rail opens as a drawer and closes on opening a workflow or a scrim tap", async ({
  page,
}) => {
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

  // This row is both a Project root and an agent, and the row IS the agent:
  // opening it focuses that agent and closes the drawer. It used to take the
  // long way round, opening a one-node dependency graph and then clicking the
  // node, because the Project action won the row's click unconditionally.
  await page
    .getByTestId("workflow-rfq")
    .locator(".workspace-row-main")
    .click();
  await expect(rail).toHaveCount(0);
  await expect(page.getByTestId("open-agent-empty")).toContainText(
    "No running session for rfq",
  );

  // The scrim's exposed sliver (right of the drawer) dismisses on tap.
  await page.getByTestId("rail-expand").click();
  await expect(rail).toBeVisible();
  await page
    .getByTestId("rail-drawer-scrim")
    .click({ position: { x: 360, y: 400 } });
  await expect(rail).toHaveCount(0);
});

test("right pane opens as a bottom sheet and dismisses from its own collapse control", async ({
  page,
}) => {
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

test("a workspace graph opens in the right sheet, over a workbench that is still there", async ({
  page,
}) => {
  // It used to be a full-main destination that hid BOTH panes — the mode
  // switch SAP-2980 removes. On mobile the map is the right pane's map, so it
  // arrives in the sheet, and the conversation is one dismissal away rather
  // than gone.
  await page.getByTestId("rail-expand").click();
  await page.getByTestId("project-select-acme-app").click();

  const graph = page.getByTestId("workspace-graph-view");
  await expect(graph).toBeVisible();
  await expect(page.locator(".rail-workflows")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toBeVisible();
  // A sheet, so it brings the sheet's own scrim — the tap-out back to the
  // conversation, which a full-main destination could not offer.
  await expect(page.getByTestId("right-sheet-scrim")).toBeVisible();
  await expect(page.locator(".center-pane")).toHaveCount(1);

  // Sheet anatomy, same as the board's: full width, anchored to the bottom,
  // one header height of the page left visible above as context.
  await settled(page.locator(".right-pane"));
  const sheet = await page.locator(".right-pane").boundingBox();
  expect(sheet?.x).toBe(0);
  expect(sheet?.width).toBe(375);
  expect((sheet?.y ?? 0) + (sheet?.height ?? 0)).toBe(812);
  expect(sheet?.y ?? 0).toBeGreaterThan(0);
  const bounds = await graph.boundingBox();
  expect(bounds?.x).toBe(0);
  expect(bounds?.width).toBe(375);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBe(812);

  const controls = await page
    .getByTestId("system-graph-controls")
    .boundingBox();
  expect((controls?.x ?? -1) + (controls?.width ?? 0)).toBeLessThanOrEqual(375);
  expect((controls?.y ?? -1) + (controls?.height ?? 0)).toBeLessThanOrEqual(
    812,
  );
  const overflow = await page.evaluate(() => {
    const element = document.scrollingElement as HTMLElement;
    return element.scrollWidth - element.clientWidth;
  });
  expect(overflow).toBe(0);
  await page.screenshot({
    path: "web/e2e/screenshots/mobile-workspace-graph.png",
  });

  // Drilling into a node cuts to board altitude; the sheet's own collapse
  // control then hands the whole screen back to the conversation.
  await page.getByTestId("system-graph-node-leasing").click();
  await expect(graph).toHaveCount(0);
  await page.getByTestId("right-collapse").click();
  await expect(page.locator(".center-pane")).toBeVisible();
});
