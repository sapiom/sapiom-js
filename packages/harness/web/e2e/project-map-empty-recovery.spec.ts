import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * A project with no sessions, seen from its project view
 * (flow-navigation.md 4.3, 4.5, 4.6). The view itself never starts anything:
 * the project's first conversation is the header's `+` (New chat), at the
 * project ROOT.
 */
async function openEmptyProjectMap(page: Page, failure = ""): Promise<void> {
  await page.goto(`/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockNoLiveSessions=1${failure ? `&mockAgentMapWorkspace=${failure}` : ""}`);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
}

async function createRequests(page: Page): Promise<Array<{ req: { cwd: string } }>> {
  return page.evaluate(() => (window as unknown as {
    __HARNESS_TEST__?: { createSessionCalls?: Array<{ req: { cwd: string } }> };
  }).__HARNESS_TEST__?.createSessionCalls ?? []);
}

test("a project with no sessions starts its first conversation from the header's +, at the project root", async ({ page }) => {
  await openEmptyProjectMap(page);
  // No map is drawn yet, so its agents are cards; nothing has started.
  await expect(page.getByTestId("project-agent-grid")).toBeVisible();
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  expect(await createRequests(page)).toHaveLength(0);
  await page.getByTestId("project-new-chat-acme-app").click();
  await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  const calls = await createRequests(page);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.req.cwd).toBe("/Users/demo/acme-app");
});

for (const [journey, failure] of [["deleted", "missing"], ["foreign", "unauthorized"]]) {
  test(`a ${journey} project shows an unavailable state instead of a permanent retry`, async ({ page }) => {
    await openEmptyProjectMap(page, failure);
    const unavailable = page.getByTestId("agent-map-project-unavailable");
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText("Select another project to continue");
    await expect(page.getByTestId("agent-map-retry")).toHaveCount(0);
    expect(await createRequests(page)).toHaveLength(0);
  });
}
