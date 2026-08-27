import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * SAP-2927 / criterion 18 — a new session's cwd is the PROJECT ROOT.
 *
 * `session-scope.test.ts` pins the resolution rule, but a unit test on a pure
 * function cannot show that `App.tsx` calls it. These specs prove the wiring
 * through the browser: the tab a new session opens is named for the project,
 * not for the agent, which is only true if the session actually booted at the
 * project root and so can see its CLAUDE.md, .claude/ and skills.
 *
 * Mock fixtures this leans on (web/src/lib/mock-data.ts):
 *   - agent `leasing` lives at /Users/demo/acme-app/leasing
 *   - recentDirs holds /Users/demo/acme-app  → a root that STRICTLY contains it
 *   - `?mockFixtures=search` adds agents under no recorded root at all
 */

interface SessionTestState {
  lastCreateSession?: { req?: { cwd?: string; harness?: string } };
  createSessionCalls?: Array<{ req?: { cwd?: string; harness?: string } }>;
}

const testState = (page: Page): Promise<SessionTestState> =>
  page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: SessionTestState })
        .__HARNESS_TEST__ ?? {},
  );

/** End the active session through the tab menu's confirm dialog. Clicks
 *  straight through, the way smoke.spec.ts does: asserting the dialog visible
 *  first catches it mid pop-in and the confirm button is then unstable. */
const endActiveSession = async (page: Page): Promise<void> => {
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  await page.getByTestId("end-session-confirm-btn").click();
};

/** Leave `leasing` focused with no live session of its own, so the workbench
 *  shows the "Start session" empty state. */
const emptyLeasingWorkbench = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  const context = page.getByTestId("session-context");
  await expect(context).toHaveAttribute("data-session-id", "sess-boot");
  // Both live sessions in the fixtures are bound to `leasing`.
  await endActiveSession(page);
  await expect(context).toHaveAttribute("data-session-id", "sess-leasing-2");
  await endActiveSession(page);
  await expect(page.getByTestId("open-agent-empty")).toBeVisible();
  // Nothing else is left claiming this agent, so the created session below is
  // unambiguously the one under test.
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
};

test("a session started on an agent boots at the owning PROJECT root", async ({
  page,
}) => {
  await emptyLeasingWorkbench(page);

  await page.getByTestId("open-agent-start-session").click();

  // The fix itself: the agent is /Users/demo/acme-app/leasing, the session is
  // not. Before SAP-2927 this POSTed the agent directory.
  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req?.cwd)
    .toBe("/Users/demo/acme-app");
});

test("the new session's tab is named for the project, not the agent", async ({
  page,
}) => {
  await emptyLeasingWorkbench(page);

  await page.getByTestId("open-agent-start-session").click();

  // The tab label is the cwd's basename (session-name.ts), so this reads the
  // booted folder back out of the rendered UI rather than out of the request:
  // "leasing" here would mean the session came up inside the agent's folder.
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.nth(0)).toHaveText("acme-app");
  await expect(page.getByTestId("session-context-title")).toHaveText("acme-app");
  // ...and it is genuinely THIS AGENT's tab strip, so the two names are being
  // compared on the same row: the strip is about `leasing` while its only tab
  // is named for the project that owns it.
  await expect(page.getByTestId("session-tab-new")).toHaveAttribute(
    "aria-label",
    "New session on leasing",
  );
});

test("an agent under no known root still starts a session, in its own folder", async ({
  page,
}) => {
  // `daily-activity-analyst` sits at /Users/demo/social-marketing/analytics-stack/…,
  // which no recentDirs entry and no launchDir contains. Honest degradation:
  // the old behaviour, not a failure to start.
  await page.goto("/?seed=0&mockFixtures=search");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  const row = page.getByTestId("workflow-daily-activity-analyst");
  await row.scrollIntoViewIfNeeded();
  await row.locator(".workflow-item-trigger").click();
  await expect(page.getByTestId("open-agent-empty")).toBeVisible();

  await page.getByTestId("open-agent-start-session").click();

  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req?.cwd)
    .toBe("/Users/demo/social-marketing/analytics-stack/daily-activity-analyst");
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
  ).toHaveCount(1);
});
