/**
 * Direct execution controls must use the harness HTTP APIs, never the coding
 * agent terminal. The unified sheet adds input collection in front of those
 * same routes; these tests protect that boundary and the exact payload. The
 * controls are the agent modal's header verbs (flow-map-chat-overlay.md 4.2b,
 * 4.4b): Run locally, Run, Deploy.
 */
import { expect, test, type Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";


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
  await page.getByTestId("agent-modal-prod-run").click();
  await expect(page.getByText("Cloud execution", { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // Every test here drives the modal's Run / Run locally / Deploy controls.
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openAgentModal(page, "acme-app", "leasing");
});

test("Local launch sends validated input to runLocal and never writes to the pty", async ({ page }) => {
  const before = JSON.stringify((await hook(page)).lastInjectInput);
  await page.getByTestId("agent-modal-run-local").click();
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
        agentMapIdentity: {
          projectId: "project_00000000-0000-4000-8000-000000000001",
          userId: "user_mock",
          sessionId: "sess-boot",
        },
        title: "acme-app",
        status: "running",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        ready: false,
      },
    });
  });
  await page.getByTestId("agent-modal-run-local").click();
  await expect(page.getByRole("dialog", { name: "Run leasing" })).toBeVisible();
  await page.getByTestId("run-sheet-submit").click();
  expect((await waitForAction(page)).action).toBe("runLocal");
});

test("Deploy remains a direct, de-duplicated build stream", async ({ page }) => {
  const deploy = page.getByTestId("agent-modal-deploy");
  await deploy.click();
  // A second press while the first is in flight must not start another
  // build (the control is disabled for its duration).
  await deploy.click({ force: true });
  await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });

  const deployActions = ((await hook(page)).directActions ?? []).filter(
    (item) => item.action === "deploy",
  );
  expect(deployActions).toEqual([
    { action: "deploy", req: { workflowPath: "/Users/demo/acme-app/leasing" } },
  ]);
});

test("a draft agent disables only Cloud while Local remains runnable", async ({ page }) => {
  await page.getByTestId("agent-modal-close").click();
  await openAgentModal(page, "rfq-agent", "rfq");
  await expect(page.getByTestId("agent-modal-run-local")).toBeEnabled();

  const cloud = page.getByTestId("agent-modal-prod-run");
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("data-tooltip", "Not deployed yet");

  await page.getByTestId("agent-modal-run-local").click();
  await expect(page.getByText("Local execution", { exact: true })).toBeVisible();
});
