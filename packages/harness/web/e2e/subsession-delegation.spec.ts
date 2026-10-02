import { expect, test } from "@playwright/test";

test("delegation retries project one ordinary rail row per real session without touching manual sessions", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  const projectId = "project_00000000-0000-4000-8000-000000000001";
  const rows = page
    .getByTestId("rail-project-acme-app")
    .locator(".rail-session-row");
  const manualRowCount = await rows.count();

  await page.evaluate((selectedProjectId) => {
    const publish = (
      window as unknown as {
        __HARNESS_TEST__?: {
          publish?: (message: Record<string, unknown>) => void;
        };
      }
    ).__HARNESS_TEST__?.publish;
    const session = (id: string, title: string) => ({
      id,
      agentSessionId: null,
      harness: "claude-code" as const,
      cwd: "/Users/demo/acme-app",
      boundWorkflowPath: null,
      title,
      status: "running" as const,
      exitCode: null,
      ready: true,
      createdAt: "2026-09-04T10:00:00.000Z",
      lastActiveAt: "2026-09-04T10:00:00.000Z",
      agentMapIdentity: {
        projectId: selectedProjectId,
        userId: "user_mock",
        sessionId: id,
      },
    });
    publish?.({
      type: "session.status",
      session: session("sess-delegated", "Focused research"),
    });
    // A coordinator replay/status refresh carries the same real Harness ID.
    publish?.({
      type: "session.status",
      session: session("sess-delegated", "Focused research"),
    });
  }, projectId);

  await expect(rows).toHaveCount(manualRowCount + 1);
  await expect(page.getByTestId("rail-session-sess-delegated")).toHaveCount(1);
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(1);

  await page.getByTestId("rail-session-select-sess-delegated").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-delegated",
  );
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  await expect(page.locator(".harness-terminal")).toBeVisible();

  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(1);
});
