import { expect, test } from "@playwright/test";

async function openGitHub(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("composer-connect-github")).toBeVisible();
  await page.getByTestId("composer-connect-github").click();
  await expect(
    page.getByRole("dialog", { name: "Connect GitHub" }),
  ).toBeVisible();
  await expect(page.getByTestId("github-device-start")).toBeVisible({
    timeout: 5_000,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("Connect GitHub is directly below the idea composer", async ({ page }) => {
  await page.getByTestId("rail-create-new").click();
  await expect(
    page.locator(".composer-box + .composer-github-option"),
  ).toHaveCount(1);
  await expect(page.getByTestId("composer-connect-github")).toContainText(
    "Connect GitHub",
  );

  await page.getByTestId("composer-connect-github").click();
  await expect(
    page.getByRole("dialog", { name: "Connect GitHub" }),
  ).toContainText("Authorize GitHub");
  await expect(page.locator(".dir-picker")).not.toBeVisible();
});

test("device authorization automatically loads the repository browser", async ({
  page,
}) => {
  await openGitHub(page);
  await page.getByTestId("github-device-start").click();
  await expect(page.getByTestId("github-device-code")).toContainText(
    "ABCD-EFGH",
  );
  await expect(page.getByTestId("github-device-link")).toBeVisible();
  await expect(page.getByTestId("github-repo-list")).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId("github-repo-item-my-agent")).toBeVisible();
});

test("repository search, clone, and normal registration add the selected agent", async ({
  page,
}) => {
  await openGitHub(page);
  await page.getByTestId("github-device-start").click();
  await expect(page.getByTestId("github-repo-list")).toBeVisible({
    timeout: 5_000,
  });

  await page.getByTestId("github-repo-search").fill("private");
  await expect(
    page.getByTestId("github-repo-item-private-agent"),
  ).toBeVisible();
  await expect(page.getByTestId("github-repo-item-my-agent")).not.toBeVisible();

  await page.getByTestId("github-repo-search").fill("");
  await page.getByTestId("github-repo-item-my-agent").click();
  await expect(page.locator(".modal-github-connect")).not.toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator(".rail-workflows")).toContainText("my-agent", {
    timeout: 5_000,
  });

  const cloneRequest = await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: {
            lastConnectGitHub?: { repoUrl: string; targetDir?: string };
          };
        }
      ).__HARNESS_TEST__?.lastConnectGitHub,
  );
  expect(cloneRequest).toEqual({
    repoUrl: "https://github.com/mock-user/my-agent.git",
    targetDir: "/Users/demo/acme-app/projects/my-agent",
  });
});

test("disconnect returns to the OAuth start state", async ({ page }) => {
  await openGitHub(page);
  await page.getByTestId("github-device-start").click();
  await expect(page.getByTestId("github-repo-list")).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId("github-device-disconnect").click();
  await expect(page.getByTestId("github-device-start")).toBeVisible();
});

test("an unavailable OAuth app is reported without a repository URL fallback", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockError=githubNotConfigured");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("rail-create-new").click();
  await page.getByTestId("composer-connect-github").click();
  await expect(page.getByTestId("github-device-unconfigured")).toContainText(
    "not configured",
  );
  await expect(page.getByPlaceholder(/repo/i)).toHaveCount(0);
});
