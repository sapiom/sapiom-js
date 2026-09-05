/**
 * SAP-3200: a project row carries a live-session mark.
 *
 * `project-live.test.ts` pins the derivation; what a unit test cannot see is
 * whether the mark reaches the row, stands there without being hovered, and
 * LEAVES when the last session ends. The disappearing direction is the half
 * that has to be driven through the browser: it depends on the rail
 * re-deriving from the session list rather than remembering what it drew.
 *
 * Mock fixtures this leans on (web/src/lib/mock-data.ts), at `?seed=0`:
 *   - `sess-boot` and `sess-leasing-2` are both running in /Users/demo/acme-app
 *   - `sess-rfq` in /Users/demo/rfq-agent has EXITED
 *   - `onboarding-flow` is a project in recentDirs with no sessions at all
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** End the active session through the tab menu's confirm dialog. Clicks
 *  straight through, the way `session-scope.spec.ts` does: asserting the
 *  dialog visible first catches it mid pop-in and the confirm is then
 *  unstable. */
const endActiveSession = async (page: Page): Promise<void> => {
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  await page.getByTestId("end-session-confirm-btn").click();
};

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
});

test("a project holding live sessions carries the mark, counted and named", async ({
  page,
}) => {
  const mark = page.getByTestId("project-live-acme-app");
  await expect(mark).toBeVisible();
  // The dot recipe in its running state, not a second one.
  await expect(mark).toHaveClass(/session-dot/);
  await expect(mark).toHaveAttribute("data-status", "running");
  // Never a bare dot: both live sessions are counted, in both the accessible
  // name and the tooltip.
  await expect(mark).toHaveAttribute("aria-label", "2 live sessions");
  await expect(mark).toHaveAttribute("data-tooltip", "2 live sessions");
});

test("the mark STANDS: it is on screen without hovering the row", async ({
  page,
}) => {
  // The `+` and the ⋮ beside it are hover-revealed (`.workspace-row-action`,
  // opacity 0 at rest). The mark answers a question asked at a glance, so it
  // must not be.
  const opacity = await page
    .getByTestId("project-live-acme-app")
    .evaluate((element) => getComputedStyle(element).opacity);
  expect(Number(opacity)).toBe(1);
});

test("a project whose only session has exited carries no mark", async ({
  page,
}) => {
  await expect(page.getByTestId("workspace-group-rfq-agent")).toBeVisible();
  await expect(page.getByTestId("project-live-rfq-agent")).toHaveCount(0);
});

test("a project with no sessions at all carries no mark", async ({ page }) => {
  await expect(
    page.getByTestId("workspace-group-onboarding-flow"),
  ).toBeVisible();
  await expect(page.getByTestId("project-live-onboarding-flow")).toHaveCount(0);
});

test("the mark counts down as sessions end, and goes when the last one does", async ({
  page,
}) => {
  const mark = page.getByTestId("project-live-acme-app");
  await expect(mark).toHaveAttribute("aria-label", "2 live sessions");

  // Both live sessions in the fixtures are acme-app's, so ending them one at a
  // time walks the mark down and then off.
  await endActiveSession(page);
  await expect(mark).toHaveAttribute("aria-label", "1 live session");
  await expect(mark).toBeVisible();

  await endActiveSession(page);
  await expect(page.getByTestId("project-live-acme-app")).toHaveCount(0);
});

test("agent rows are untouched: the mark is a fact about a project", async ({
  page,
}) => {
  const leasing = page.getByTestId("workflow-leasing");
  await expect(leasing).toBeVisible();
  // The rail still lists no sessions and an agent row still carries only its
  // deploy glyph.
  await expect(leasing.locator(".session-dot")).toHaveCount(0);
  await expect(
    page.locator("[data-testid^='workflow-session-dot-']"),
  ).toHaveCount(0);
  await expect(page.locator("[data-testid^='rail-session-']")).toHaveCount(0);
});

/**
 * The Group axis carries the SAME mark on its headers, by the membership rule
 * `liveSessionsOnAgents` pins: bound to a member, or unbound in a member's own
 * folder.
 *
 * Only the negative is reachable from the fixtures. Every live mock session is
 * acme-app's, and acme-app has one agent, so it renders no group sections at
 * all; the deep fixture's projects have the groups and none of the sessions.
 * What this guards is the failure a positive could not catch anyway (a mark
 * that renders unconditionally), and the membership rule itself is pinned in
 * `project-live.test.ts`, both directions.
 */
test.describe("the Group axis", () => {
  test("group headers carry no mark when nothing under them is live", async ({
    page,
  }) => {
    await page.goto("/?mockFixtures=deep");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    // The create row appears only once the stored arrangement AND the launch
    // edges have loaded, so it is the honest "the groups are drawn" signal.
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();

    await expect(
      page.locator('[data-testid^="group-row-"]').first(),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="group-live-"]')).toHaveCount(0);

    // The project row above them still reports its own sessions, so the axis
    // has not simply stopped deriving.
    await expect(page.getByTestId("project-live-acme-app")).toHaveAttribute(
      "aria-label",
      "2 live sessions",
    );
  });
});
