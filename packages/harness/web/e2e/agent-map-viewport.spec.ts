import { expect, test, type Page } from "@playwright/test";
import { selectSession } from "./mock-navigation";

async function openProject(page: Page, project: string) {
  await page.getByTestId(`project-select-${project}`).click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-state",
    "ready",
  );
}

const transform = (page: Page) =>
  page.getByTestId("agent-map-subject").evaluate((el) => el.style.transform);

test.beforeEach(async ({ page }) => {
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await expect(page.getByTestId("session-context")).toBeVisible();
  await openProject(page, "acme-app");
});

test("each project's pan and zoom survive another project and a session", async ({
  page,
}) => {
  const initial = await transform(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByTestId("agent-map-viewport").focus();
  await page.keyboard.press("ArrowRight");
  const acmeView = await transform(page);
  expect(acmeView).not.toBe(initial);

  await openProject(page, "polsia");
  expect(await transform(page)).not.toBe(acmeView);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByTestId("agent-map-viewport").focus();
  await page.keyboard.press("ArrowDown");
  const polsiaView = await transform(page);
  expect(polsiaView).not.toBe(acmeView);

  await openProject(page, "acme-app");
  await expect.poll(() => transform(page)).toBe(acmeView);
  // A session in between: the map leaves the centre entirely.
  await selectSession(page, "sess-boot");
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await openProject(page, "acme-app");
  await expect.poll(() => transform(page)).toBe(acmeView);
  await openProject(page, "polsia");
  await expect.poll(() => transform(page)).toBe(polsiaView);
});

test("returning to a map with every node offscreen fits it back into view", async ({
  page,
}) => {
  const fitted = await transform(page);
  // Pan well beyond the map using the actual viewport controls.
  await page.getByTestId("agent-map-viewport").focus();
  for (let i = 0; i < 50; i += 1) await page.keyboard.press("ArrowRight");
  expect(await transform(page)).not.toBe(fitted);
  await openProject(page, "polsia");
  await openProject(page, "acme-app");
  await expect.poll(() => transform(page)).toBe(fitted);
});

test("Fit clears the saved manual view and keeps following pane size after returning", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Fit Agent Map to view" }).click();
  await openProject(page, "polsia");
  await openProject(page, "acme-app");
  const normal = await transform(page);
  // The map fills the centre, so its pane follows the window: shrink it.
  await page.setViewportSize({ width: 1100, height: 520 });
  await expect.poll(() => transform(page)).not.toBe(normal);
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-state",
    "ready",
  );
  const automatic = await transform(page);
  await page.getByRole("button", { name: "Fit Agent Map to view" }).click();
  expect(await transform(page)).toBe(automatic);
});

test("an auth change discards the previous signed-in viewport", async ({
  page,
}) => {
  const initial = await transform(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByTestId("agent-map-viewport").focus();
  await page.keyboard.press("ArrowRight");
  expect(await transform(page)).not.toBe(initial);
  await page.evaluate(() => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "auth.changed",
      authenticated: true,
      organizationName: "Another account",
    });
  });
  await expect.poll(() => transform(page)).toBe(initial);
});
