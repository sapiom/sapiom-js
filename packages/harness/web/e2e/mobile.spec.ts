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

test("rail opens as a drawer and closes on selecting a session or a scrim tap", async ({
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

  // A session row is the rail's one-click verb: selecting a session in
  // another project closes the drawer and puts that session in the centre.
  await page.getByTestId("rail-session-select-sess-bg").click();
  await expect(rail).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-bg",
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

test("a project's Agent Map takes the whole centre on a phone, with no sheet and no chat", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1");
  // The project view is the centre at every width (flow-navigation.md 4.3):
  // no right pane beside it, so no sheet to open and no scrim to tap out of.
  await page.getByTestId("rail-expand").click();
  await page.getByTestId("project-select-acme-app").click();

  const graph = page.getByTestId("agent-map-frame");
  await expect(graph).toBeVisible();
  await expect(page.locator(".rail-workflows")).toHaveCount(0);
  await expect(page.getByTestId("right-sheet-scrim")).toHaveCount(0);
  await expect(page.getByTestId("right-expand")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toHaveCount(0);

  // Full width, ending at the bottom edge (once the drawer's exit settles).
  await expect
    .poll(async () => {
      const box = await graph.boundingBox();
      return [box?.x, box?.width, Math.round((box?.y ?? 0) + (box?.height ?? 0))];
    })
    .toEqual([0, 375, 812]);

  const controls = await page
    .getByRole("group", { name: "Agent Map view controls" })
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
    path: "web/e2e/screenshots/mobile-agent-map.png",
  });

  // A node opens its panel in place; the selected session is one rail tap
  // away, and its workbench comes back with it.
  await page.getByTestId("agent-map-node-node_00000000-0000-7000-8000-000000000101").click();
  await expect(page.getByTestId("map-agent-panel")).toBeVisible();
  await page.getByTestId("rail-expand").click();
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(graph).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();
});
