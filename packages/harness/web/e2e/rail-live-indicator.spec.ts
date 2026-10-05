/**
 * The rail's session marks (flow-navigation.md 4.1.2, design-eng NAVIGATION.md;
 * design.md §4.1: rewritten from SAP-3200's project live mark).
 *
 * The rail lists sessions now, so "is anything running in here" is answered on
 * each session's own row rather than by a count on its project: live (filled
 * green, the `.session-dot` running state), idle (filled neutral: running and
 * quiet for ten minutes or more), exited (hollow). `rail-sessions.test.ts` pins
 * the derivation; what a unit test cannot see is whether the mark reaches the
 * row, stands there without being hovered, and CHANGES when a session ends or
 * goes quiet. That depends on the rail re-deriving from the session list and
 * the shell's clock rather than remembering what it drew.
 *
 * Mock fixtures this leans on (web/src/lib/mock-data.ts), at `?seed=0`:
 *   - `sess-boot` and `sess-leasing-2` are both running in /Users/demo/acme-app
 *   - `sess-rfq` in /Users/demo/rfq-agent has EXITED
 *   - `onboarding-flow` is a project in recentDirs with no sessions at all
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** End the selected session through its header menu's confirm dialog. */
const endActiveSession = async (page: Page): Promise<void> => {
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
};

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
});

test("a live session's row carries the live mark, in the dot recipe's running state", async ({
  page,
}) => {
  const row = page.getByTestId("rail-session-sess-boot");
  await expect(row).toHaveAttribute("data-mark", "live");
  const mark = page.getByTestId("rail-session-mark-sess-boot");
  await expect(mark).toBeVisible();
  // The dot recipe in its running state, not a second one.
  await expect(mark).toHaveClass(/session-dot/);
  await expect(mark).toHaveAttribute("data-status", "running");
  // Never a bare dot: it says what it means.
  await expect(mark).toHaveAttribute("aria-label", "Live: the agent is working");
});

test("the mark STANDS: it is on screen without hovering the row", async ({
  page,
}) => {
  // The row's × is hover-revealed. The mark answers a question asked at a
  // glance, so it must not be. Walk the chain to the row and multiply, which
  // catches the mark being nested into a hover-revealed cluster as well as the
  // mark being given `opacity: 0` directly.
  await page.locator(".rail-header-label").hover();
  const effective = await page
    .getByTestId("rail-session-mark-sess-boot")
    .evaluate((element) => {
      let node: HTMLElement | null = element as HTMLElement;
      let opacity = 1;
      let insideHoverAction = false;
      while (node && !node.classList.contains("workspace-row")) {
        opacity *= Number(getComputedStyle(node).opacity);
        if (node.classList.contains("workspace-row-action")) {
          insideHoverAction = true;
        }
        node = node.parentElement;
      }
      return { opacity, insideHoverAction };
    });
  expect(effective).toEqual({ opacity: 1, insideHoverAction: false });
});

test("an exited session's row carries the hollow exited mark", async ({
  page,
}) => {
  await expect(page.getByTestId("rail-session-sess-rfq")).toHaveAttribute(
    "data-mark",
    "exited",
  );
  const mark = page.getByTestId("rail-session-mark-sess-rfq");
  await expect(mark).not.toHaveAttribute("data-status", "running");
  const style = await mark.evaluate((element) => {
    const css = getComputedStyle(element);
    return { background: css.backgroundColor, border: css.borderTopWidth };
  });
  expect(style.background).toBe("rgba(0, 0, 0, 0)");
  expect(style.border).not.toBe("0px");
});

test("a project with no sessions at all carries no session rows", async ({
  page,
}) => {
  await expect(
    page.getByTestId("rail-project-onboarding-flow").locator(".rail-session-row"),
  ).toHaveCount(0);
  await expect(page.getByTestId("rail-project-onboarding-flow")).toHaveAttribute(
    "data-session-count",
    "0",
  );
});

test("ending a session drops its row to the exited mark, and the row stays", async ({
  page,
}) => {
  await expect.poll(() =>
    page.getByTestId("session-context").getAttribute("data-session-id"),
  ).toBe("sess-boot");
  await endActiveSession(page);
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-mark",
    "exited",
  );
  // The other live session in the same project is untouched.
  await expect(page.getByTestId("rail-session-sess-leasing-2")).toHaveAttribute(
    "data-mark",
    "live",
  );
});

test("the mark is about a session, so the rail carries no agent rows and no project count", async ({
  page,
}) => {
  await expect(page.locator(".rail-list [data-testid^='workflow-']")).toHaveCount(0);
  await expect(page.locator("[data-testid^='project-live-']")).toHaveCount(0);
  // A session bound to an agent names it on the row instead.
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
    "data-agent",
    "leasing",
  );
});

test.describe("idle", () => {
  test("a running session quiet for ten minutes reads idle, without any event arriving", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto("/?seed=0");
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-mark",
      "live",
    );
    // The shell's clock ticks the marks; no session event is involved.
    await page.clock.fastForward("11:00");
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-mark",
      "idle",
    );
    const mark = page.getByTestId("rail-session-mark-sess-boot");
    await expect(mark).not.toHaveAttribute("data-status", "running");
    await expect(mark).toHaveAttribute(
      "aria-label",
      "Idle: running, quiet for a while",
    );
  });
});
