/**
 * Direct execution controls must use the harness HTTP APIs, never the coding
 * agent terminal. The unified sheet adds input collection in front of those
 * same routes; these tests protect that boundary and the exact payload.
 */
import { expect, test, type Page } from "@playwright/test";

import { focusRfqAgent } from "./mock-navigation";

// COMPATIBILITY PAYLOAD, said out loud.
//
// Before the mock's `studioProjects` default was flipped, EVERY spec ran on this
// payload without knowing it: `mockStudioProjects` returned undefined unless a
// spec opted in, so the whole suite exercised the retired direct-creation rail
// and never the shipped plan-first one. Pinning this file takes nothing away,
// it is the payload these tests already ran on; it only stops that being an
// accident. Their plan-first equivalents are covered in `project-axis.spec.ts`
// and `agent-map-planning.spec.ts`, not here.

type HarnessHook = {
  lastDirectAction?: { action: string; req: Record<string, unknown> };
  directActions?: Array<{ action: string; req: Record<string, unknown> }>;
  lastInjectInput?: { id: string; req: Record<string, unknown> };
  publish?: (message: unknown) => void;
};

async function hook(page: Page): Promise<HarnessHook> {
  return page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: HarnessHook })
        .__HARNESS_TEST__ ?? {},
  );
}

async function waitForAction(page: Page): Promise<NonNullable<HarnessHook["lastDirectAction"]>> {
  await expect.poll(async () => (await hook(page)).lastDirectAction).toBeTruthy();
  return (await hook(page)).lastDirectAction!;
}

async function openCloudSheet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Choose run target" }).click();
  await page.getByRole("menuitemradio", { name: /Cloud/ }).click();
  await expect(page.getByText("Cloud execution", { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0&mockStudioProjects=absent");
  await expect(page.getByTestId("session-steps")).toBeVisible();
});

test("Local launch sends validated input to runLocal and never writes to the pty", async ({ page }) => {
  const before = JSON.stringify((await hook(page)).lastInjectInput);
  await page.getByTestId("session-step-local").click();
  await page.getByLabel(/Topic/).fill("tenant onboarding");
  await page.getByTestId("run-sheet-submit").click();

  expect(await waitForAction(page)).toEqual({
    action: "runLocal",
    req: {
      sourceDir: "/Users/demo/acme-app/leasing",
      input: { topic: "tenant onboarding" },
    },
  });
  expect(JSON.stringify((await hook(page)).lastInjectInput)).toBe(before);
});

test("Cloud launch sends validated input to run and never writes to the pty", async ({ page }) => {
  const before = JSON.stringify((await hook(page)).lastInjectInput);
  await openCloudSheet(page);
  await page.getByLabel(/Topic/).fill("credit review");
  await page.getByTestId("run-sheet-submit").click();

  expect(await waitForAction(page)).toEqual({
    action: "run",
    req: { definitionId: "4821", input: { topic: "credit review" } },
  });
  expect(JSON.stringify((await hook(page)).lastInjectInput)).toBe(before);
});

test("the run APIs remain available while the coding-agent session is starting", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: HarnessHook }).__HARNESS_TEST__.publish?.({
      type: "session.status",
      session: {
        id: "sess-boot",
        agentSessionId: null,
        boundWorkflowPath: "/Users/demo/acme-app/leasing",
        harness: "claude-code",
        cwd: "/Users/demo/acme-app",
        title: "acme-app",
        status: "running",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        ready: false,
      },
    });
  });
  await page.getByTestId("session-step-local").click();
  await expect(page.getByRole("dialog", { name: "Run leasing" })).toBeVisible();
  await page.getByTestId("run-sheet-submit").click();
  expect((await waitForAction(page)).action).toBe("runLocal");
});

test("Deploy remains a direct, de-duplicated build stream", async ({ page }) => {
  const deploy = page.getByTestId("session-step-deploy");
  await deploy.click();
  await deploy.click();
  await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });

  const deployActions = ((await hook(page)).directActions ?? []).filter(
    (item) => item.action === "deploy",
  );
  expect(deployActions).toEqual([
    { action: "deploy", req: { workflowPath: "/Users/demo/acme-app/leasing" } },
  ]);
});

test("a draft agent disables only Cloud while Local remains runnable", async ({ page }) => {
  await focusRfqAgent(page);
  await page.getByTestId("open-agent-start-session").click();
  await expect(page.getByTestId("session-step-local")).toHaveAccessibleName("Run using Local");

  await page.getByRole("button", { name: "Choose run target" }).click();
  const cloud = page.getByRole("menuitemradio", { name: /Cloud/ });
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("title", /Not deployed yet/);

  await page.keyboard.press("Escape");
  await page.getByTestId("session-step-local").click();
  await expect(page.getByText("Local execution", { exact: true })).toBeVisible();
});
