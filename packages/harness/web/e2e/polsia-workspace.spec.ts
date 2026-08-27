import { expect, test, type Page } from "@playwright/test";

const POLSIA = "/Users/demo/polsia";

const graphRequestCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        (
          window as unknown as {
            __HARNESS_TEST__?: { systemGraphRequests?: string[] };
          }
        ).__HARNESS_TEST__?.systemGraphRequests ?? []
      ).length,
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0&mockFixtures=deep&mockNoLiveSessions=1");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
});

test("a Polsia-style Project opens its complete graph without a session and reuses it", async ({
  page,
}) => {
  const project = page.getByTestId("workspace-group-polsia");

  // One realistic Project mixes a deployed agent with local-only agents.
  await expect(
    project.getByTestId(
      `workflow-status-${POLSIA}/packages/harness/web/src/components/mailer`,
    ),
  ).toHaveAttribute("data-deployed", "true");
  await expect(
    project.getByTestId(`workflow-status-${POLSIA}/scripts/tools/rollup`),
  ).toHaveAttribute("data-deployed", "false");
  await expect(page.getByTestId("session-context")).not.toHaveAttribute(
    "data-session-id",
    /.+/,
  );

  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.locator(".system-graph-node")).toHaveCount(8);
  for (const agentKey of [
    "ads",
    "outreach",
    "mailer",
    "sender",
    "gateway",
    "ads-worker",
    "queue",
    "local:scripts/tools/rollup",
  ]) {
    await expect(page.getByTestId(`system-graph-node-${agentKey}`)).toBeVisible();
  }

  // The fixture exercises fan-out, fan-in, a cycle, mixed call modes, and one
  // disconnected inventory-only agent in one useful product-level graph.
  await expect(
    page.getByTestId("system-graph-edge-agent:outreach-agent:mailer"),
  ).toContainText("blocking + async");
  await expect(
    page
      .getByTestId("system-graph-edge-agent:ads-agent:gateway")
      .locator("path"),
  ).toHaveClass(/is-blocking/);
  await expect(
    page
      .getByTestId("system-graph-edge-agent:sender-agent:gateway")
      .locator("path"),
  ).toHaveClass(/is-async/);
  await expect(page.locator('[data-testid^="system-graph-edge-"]')).toHaveCount(
    7,
  );
  await expect(
    page.locator(
      '[data-testid^="system-graph-edge-"][data-testid*="rollup"]',
    ),
  ).toHaveCount(0);
  await expect.poll(() => graphRequestCount(page)).toBe(1);

  // The disclosure is only a tree control; it never closes the selected graph.
  await page.getByTestId("project-disclosure-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(project.getByTestId("workflow-rollup")).toHaveCount(0);
  await page.getByTestId("project-disclosure-polsia").click();

  // A local fallback identity remains a real agent door. Returning to the
  // Project is a cache hit rather than another projection request.
  await page
    .getByTestId("system-graph-node-local:scripts/tools/rollup")
    .click();
  await expect(project.getByTestId("workflow-rollup")).toHaveClass(
    /is-focused/,
  );
  await expect(page.getByTestId("open-agent-empty")).toContainText(
    "No running session for rollup",
  );
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("system-graph-canvas")).toBeVisible();
  await expect.poll(() => graphRequestCount(page)).toBe(1);
});

test("a failed Polsia graph can retry and the recovered snapshot is cached", async ({
  page,
}) => {
  await page.evaluate(() => {
    (
      window as unknown as { __MOCK_SYSTEM_GRAPH_FAIL_ONCE__?: boolean }
    ).__MOCK_SYSTEM_GRAPH_FAIL_ONCE__ = true;
  });

  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("system-graph-error")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("system-graph-node-gateway")).toBeVisible();
  await expect.poll(() => graphRequestCount(page)).toBe(2);

  await page.getByTestId("system-graph-node-gateway").click();
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("system-graph-canvas")).toBeVisible();
  await expect.poll(() => graphRequestCount(page)).toBe(2);
});
