import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { activeSessionId, openAgentModal } from "./mock-navigation";

/**
 * SAP-2927 / criterion 18 — a new session's cwd is the PROJECT ROOT.
 *
 * `session-scope.test.ts` pins the resolution rule, but a unit test on a pure
 * function cannot show that `App.tsx` calls it. These specs prove the wiring
 * through the browser: a prompt asked from an agent's board in its modal
 * (flow-map-chat-overlay.md 4.4b, "Ask ... a new project-root session") boots
 * at the project that owns the agent, so the coding agent sees the project's
 * CLAUDE.md, .claude/ and skills, and the new session is named for the
 * project rather than the agent. It is never bound to the agent (I2).
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

/** Ask about the agent from its board's chat panel, in its modal: a new
 *  project-root session with that first message. Resolves to its id. */
async function askFromAgentBoard(page: Page): Promise<string> {
  const before = await page.locator(".rail-session-row").count();
  await openAgentModal(page, "acme-app", "leasing");
  await page.getByTestId("canvas-chat-toggle").click();
  await page.getByTestId("canvas-freeform-input").fill("Explain this agent");
  await page.getByTestId("canvas-freeform-ask").click();
  await expect(page.locator(".rail-session-row")).toHaveCount(before + 1);
  await expect(page.getByTestId("agent-modal")).toHaveCount(0);
  const id = await activeSessionId(page);
  expect(id).toBeTruthy();
  return id!;
}

test("a session started from an agent boots at the owning PROJECT root", async ({
  page,
}) => {
  await askFromAgentBoard(page);
  // The fix itself: the agent is /Users/demo/acme-app/leasing, the session is
  // not. Before SAP-2927 this POSTed the agent directory.
  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req?.cwd)
    .toBe("/Users/demo/acme-app");
});

test("the new session is named for the project, not the agent, and is not bound to it", async ({
  page,
}) => {
  const id = await askFromAgentBoard(page);
  // The server's default title: the cwd's basename plus the next unused
  // ordinal in that folder. "leasing" here would mean the session came up
  // inside the agent's folder.
  await expect(page.getByTestId(`rail-session-${id}`)).toContainText("acme-app 3");
  await expect(page.getByTestId("session-context-title")).toHaveText("acme-app 3");
  // I2: no code path binds a session to an agent.
  await expect(page.getByTestId(`rail-session-${id}`)).not.toHaveAttribute(
    "data-agent",
    /.+/,
  );
  expect(await activeSessionId(page)).toBe(id);
});
