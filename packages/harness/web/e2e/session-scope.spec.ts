import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { activeSessionId, startChatWithAgent } from "./mock-navigation";

/**
 * SAP-2927 / criterion 18 — a new session's cwd is the PROJECT ROOT.
 *
 * `session-scope.test.ts` pins the resolution rule, but a unit test on a pure
 * function cannot show that `App.tsx` calls it. These specs prove the wiring
 * through the browser: Start chat on an agent's map panel (flow-navigation.md
 * 4.4.2) boots at the project that owns the agent, so the coding agent sees the
 * project's CLAUDE.md, .claude/ and skills, and the new session is named for
 * the project rather than the agent.
 *
 * Mock fixtures this leans on (web/src/lib/mock-data.ts):
 *   - agent `leasing` lives at /Users/demo/acme-app/leasing
 *   - recentDirs holds /Users/demo/acme-app  → a root that STRICTLY contains it
 *
 * The old third case, an agent under no known root, has no UI path any more:
 * an agent outside every open project is on no map (NAVIGATION.md "Removed"),
 * so nothing can start a chat on it.
 */

interface SessionTestState {
  lastCreateSession?: { req?: { cwd?: string; harness?: string } };
}

const testState = (page: Page): Promise<SessionTestState> =>
  page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: SessionTestState })
        .__HARNESS_TEST__ ?? {},
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("a chat started on an agent boots at the owning PROJECT root", async ({
  page,
}) => {
  await startChatWithAgent(page, "acme-app", "leasing");
  // The fix itself: the agent is /Users/demo/acme-app/leasing, the session is
  // not. Before SAP-2927 this POSTed the agent directory.
  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req?.cwd)
    .toBe("/Users/demo/acme-app");
});

test("the new session is named for the project, not the agent, and bound to the agent", async ({
  page,
}) => {
  const id = await startChatWithAgent(page, "acme-app", "leasing");
  // The server's default title: the cwd's basename plus the next unused
  // ordinal in that folder. "leasing" here would mean the session came up
  // inside the agent's folder.
  await expect(page.getByTestId(`rail-session-${id}`)).toContainText("acme-app 3");
  await expect(page.getByTestId("session-context-title")).toHaveText("acme-app 3");
  await expect(page.getByTestId(`rail-session-${id}`)).toHaveAttribute(
    "data-agent",
    "leasing",
  );
  expect(await activeSessionId(page)).toBe(id);
});
