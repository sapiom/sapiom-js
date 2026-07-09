/**
 * First-run welcome panel — mock-mode UI smoke (see smoke.spec.ts for the
 * setup). `/?mockState=fresh` renders MockApi as a brand-new install: no
 * sessions, no recent dirs, no workflows, AppState.firstRun set — the state
 * the real CLI produces on a machine that's never run the harness (it also
 * skips the auto boot session then). The default fixtures (a lived-in
 * install) double as the returning-user case.
 */
import { expect, test } from "@playwright/test";

test.describe("first-run welcome panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("renders on fresh state instead of the bare terminal empty state", async ({ page }) => {
    const panel = page.getByTestId("welcome-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator(".terminal-empty")).toHaveCount(0);

    // The two primary actions plus the compact macros/⌘K hint.
    await expect(page.getByTestId("welcome-start-project")).toBeVisible();
    await expect(page.getByTestId("welcome-run-sample")).toBeVisible();
    const hints = page.getByTestId("welcome-hints");
    await expect(hints).toContainText("Visualize");
    await expect(hints).toContainText("Run local");
    await expect(hints).toContainText("Deploy");
    await expect(hints).toContainText("⌘K");

    await page.screenshot({ path: "web/e2e/screenshots/welcome-panel.png", fullPage: true });
  });

  test("'Start a new project' opens the existing new-session flow and creating a session dismisses the panel", async ({
    page,
  }) => {
    await page.getByTestId("welcome-start-project").click();
    await expect(page.getByText("New session")).toBeVisible();

    // Same directory picker as the tab strip's "+" — pick a real fixture dir.
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    await page.getByRole("button", { name: "Start session" }).click();

    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    await expect(page.locator(".session-tab.is-active")).toContainText("acme-app");
  });

  test("'Run the sample project' seeds the example and opens a session in it", async ({ page }) => {
    await page.getByTestId("welcome-run-sample").click();

    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    await expect(page.locator(".session-tab.is-active")).toContainText("sample-project");

    // MockApi.seedSampleProject has no other observable effect — the test
    // hook confirms the click actually seeded before creating the session.
    const lastSeed = await page.evaluate(
      () =>
        (window as unknown as { __HARNESS_TEST__?: { lastSampleSeed?: { root: string; created: boolean } } })
          .__HARNESS_TEST__?.lastSampleSeed,
    );
    expect(lastSeed?.root).toBe("/Users/demo/.sapiom/harness/sample-project");
  });

  test("'Skip for now' dismisses to the plain empty-terminal state", async ({ page }) => {
    await page.getByTestId("welcome-dismiss").click();
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    await expect(page.locator(".terminal-empty")).toBeVisible();
  });
});

test("returning users never see the welcome panel — the default (lived-in) fixtures render straight into the boot session", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("session-tab-sess-boot")).toHaveClass(/is-active/);
  await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
});
