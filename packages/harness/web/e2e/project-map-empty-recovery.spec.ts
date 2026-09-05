import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openEmptyProjectMap(page: Page, failure = ""): Promise<void> {
  await page.goto(`/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockNoLiveSessions=1${failure ? `&mockAgentMapWorkspace=${failure}` : ""}`);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("project-session-empty")).toBeVisible();
}

async function createRequests(page: Page): Promise<Array<{ req: { cwd: string } }>> {
  return page.evaluate(() => (window as unknown as {
    __HARNESS_TEST__?: { createSessionCalls?: Array<{ req: { cwd: string } }> };
  }).__HARNESS_TEST__?.createSessionCalls ?? []);
}

test("a project map with no sessions starts its first exact project conversation", async ({ page }) => {
  await openEmptyProjectMap(page);
  await expect(page.getByTestId("agent-map-empty")).toBeVisible();
  expect(await createRequests(page)).toHaveLength(0);
  await page.getByTestId("project-start-session").click();
  await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
  await expect(page.getByTestId("project-session-empty")).toHaveCount(0);
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
    await expect(page.getByTestId("project-start-session")).toHaveCount(0);
    expect(await createRequests(page)).toHaveLength(0);
  });
}
