/**
 * E2E tests for the GitHub Device Flow "Connect to GitHub" UI.
 *
 * Runs against `vite dev` with VITE_MOCK=1 — no real GitHub, no real server,
 * no real git. The MockApi wires up the Device Flow endpoints (githubDeviceStart,
 * githubDevicePoll, githubListRepos, githubStatus, githubDisconnect, connectGitHub)
 * and the App.tsx wires the GitHubDeviceApi adapter.
 *
 * Test scenarios:
 *  1. "Connect to GitHub" button opens the Device Flow panel (not the URL form).
 *  2. Device code is displayed after start; polling auto-starts (no Open click needed).
 *  3. Polling completes → connected state shows login + Browse repos.
 *  4. Browse repos → pick one → mock clone → repo appears in rail.
 *  5. Disconnect reverts to idle state.
 *  6. Error states: denied / expired (errors surface via auto-poll, no Open click needed).
 *  7. Unconfigured (mockError=githubNotConfigured): shows fallback hint.
 */

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

/** Navigate + → Connect to GitHub door → AddProjectMenu → GitHub button. */
async function openGitHubDeviceFlow(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("add-workspace").click();
  await expect(page.getByTestId("add-menu")).toBeVisible();
  await page.getByTestId("aw-door-github").click();
  await expect(page.getByTestId("add-project-menu")).toBeVisible();
  await page.getByTestId("add-project-connect-github").click();
}

test.describe("GitHub Device Flow", () => {
  test('clicking "Connect to GitHub" shows the Device Flow panel', async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("aw-door-github").click();
    await expect(page.getByTestId("add-project-menu")).toBeVisible();

    await page.getByTestId("add-project-connect-github").click();

    // The Device Flow panel should be visible (not the old URL form).
    await expect(page.getByTestId("github-device-connect")).toBeVisible();
    // The status check completes (not configured → idle → Connect GitHub button).
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
  });

  test("device start shows user code, clipboard hint, and Open GitHub fallback button", async ({ page }) => {
    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("github-device-start").click();

    // User code, clipboard hint, Open GitHub button, and waiting indicator appear.
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("github-device-code")).toContainText("ABCD-1234");
    await expect(page.getByTestId("github-device-clipboard-hint")).toBeVisible();
    await expect(page.getByTestId("github-device-copy")).toBeVisible();
    await expect(page.getByTestId("github-device-link")).toBeVisible();
    await expect(page.getByTestId("github-device-waiting")).toBeVisible();
    // The heading should set the mental model for the code-first flow.
    await expect(page.getByTestId("github-device-awaiting")).toContainText("Enter this code on GitHub to connect");
  });

  test("polling auto-starts after deviceStart → authorized → shows login + Browse repos (no Open click needed)", async ({
    page,
  }) => {
    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });

    // Polling auto-starts — no click on "Open GitHub" needed.
    // The mock returns "authorized" immediately on the first poll.
    await expect(page.getByTestId("github-device-connected")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("github-device-browse")).toBeVisible();
    // Connected state should show the mock login.
    await expect(page.getByTestId("github-device-connected")).toContainText("mock-user");
  });

  test("Browse repos shows the repo list → pick one → mock clone → repo in rail", async ({
    page,
  }) => {
    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });
    // Polling auto-starts — connected state arrives without clicking "Open GitHub".
    await expect(page.getByTestId("github-device-connected")).toBeVisible({ timeout: 5000 });

    // Click Browse repos.
    await page.getByTestId("github-device-browse").click();

    // Repo list appears.
    await expect(page.getByTestId("github-repo-list")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("github-repo-item-my-agent")).toBeVisible();

    // Pick a repo.
    await page.getByTestId("github-repo-item-my-agent").click();

    // Menu closes and repo appears in the workspace rail.
    await expect(page.getByTestId("add-project-menu")).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator(".rail-tree")).toContainText("my-agent", { timeout: 5000 });
  });

  test("repo list search filters correctly", async ({ page }) => {
    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });
    // Polling auto-starts — connected state arrives without clicking "Open GitHub".
    await expect(page.getByTestId("github-device-connected")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("github-device-browse").click();
    await expect(page.getByTestId("github-repo-list")).toBeVisible({ timeout: 5000 });

    // Both repos should be visible initially.
    await expect(page.getByTestId("github-repo-item-my-agent")).toBeVisible();
    await expect(page.getByTestId("github-repo-item-private-project")).toBeVisible();

    // Search for "private".
    await page.getByTestId("github-repo-search").fill("private");

    // Only the private-project should remain.
    await expect(page.getByTestId("github-repo-item-private-project")).toBeVisible();
    await expect(page.getByTestId("github-repo-item-my-agent")).not.toBeVisible();
  });

  test("Disconnect button in repo list reverts to idle", async ({ page }) => {
    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });
    // Polling auto-starts — connected state arrives without clicking "Open GitHub".
    await expect(page.getByTestId("github-device-connected")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("github-device-browse").click();
    await expect(page.getByTestId("github-repo-list")).toBeVisible({ timeout: 5000 });

    // Disconnect.
    await page.getByTestId("github-device-disconnect").click();

    // Should return to idle (Connect GitHub button visible).
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
  });

  test("error state: denied shows error + Try again button", async ({ page }) => {
    // Navigate with the mockError flag so polling returns "denied".
    await page.goto("/?seed=0&mockError=githubPollDenied");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });

    // Polling auto-starts — no "Open GitHub" click needed to trigger the error.
    await expect(page.getByTestId("github-device-error")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("github-device-error")).toContainText("denied");
    await expect(page.getByTestId("github-device-retry")).toBeVisible();
  });

  test("error state: expired shows error + Try again button", async ({ page }) => {
    await page.goto("/?seed=0&mockError=githubPollExpired");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });

    // Polling auto-starts — no "Open GitHub" click needed to surface the expiry.
    await expect(page.getByTestId("github-device-error")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("github-device-error")).toContainText("expired");
    await expect(page.getByTestId("github-device-retry")).toBeVisible();
  });

  test("unconfigured: shows fallback hint when GitHub client ID is not set", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockError=githubNotConfigured");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openGitHubDeviceFlow(page);

    // Should show the unconfigured state.
    await expect(page.getByTestId("github-device-unconfigured")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("github-device-connect")).toContainText("not configured");
  });

  test("back button returns to the menu", async ({ page }) => {
    await openGitHubDeviceFlow(page);
    await expect(page.getByTestId("github-device-connect")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Back to menu" }).click();

    await expect(page.getByTestId("add-project-menu-items")).toBeVisible();
    await expect(page.getByTestId("github-device-connect")).not.toBeVisible();
  });
});
