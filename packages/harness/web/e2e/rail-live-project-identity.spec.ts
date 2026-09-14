import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const PARENT = "polsia";
const CHILD = "polsia/services/workers";
const PARENT_ROOT = "/Users/demo/polsia";
const CHILD_ROOT = `${PARENT_ROOT}/services/workers`;
const QUEUE = `${CHILD_ROOT}/queue`;

async function projectId(page: Page, label: string): Promise<string> {
  await page.getByTestId(`project-select-${label}`).click();
  const map = page.getByTestId("agent-map-live");
  await expect(map).toBeVisible();
  const id = await map.getAttribute("data-project-id");
  expect(id).toBeTruthy();
  return id!;
}

async function publishSession(
  page: Page,
  update: {
    id: string;
    cwd: string;
    projectId?: string;
    boundWorkflowPath?: string;
    status?: "starting" | "running" | "exited";
  },
): Promise<void> {
  await page.evaluate((value) => {
    const publish = (
      window as unknown as {
        __HARNESS_TEST__?: { publish?: (message: unknown) => void };
      }
    ).__HARNESS_TEST__?.publish;
    if (!publish) throw new Error("Mock event bus is not ready");
    publish({
      type: "session.status",
      session: {
        id: value.id,
        agentSessionId: null,
        boundWorkflowPath: value.boundWorkflowPath ?? null,
        harness: "claude-code",
        cwd: value.cwd,
        title: value.id,
        status: value.status ?? "running",
        createdAt: "2026-09-07T00:00:00.000Z",
        ready: true,
        agentMapIdentity: value.projectId
          ? {
              projectId: value.projectId,
              userId: "user_mock",
              sessionId: value.id,
            }
          : null,
      },
    });
  }, update);
}

test.beforeEach(async ({ page }) => {
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await expect(page.getByTestId(`workspace-group-${PARENT}`)).toBeVisible();
});

test("a nested project's session does not light its parent project", async ({
  page,
}) => {
  const childId = await projectId(page, CHILD);
  await publishSession(page, {
    id: "child-session",
    cwd: CHILD_ROOT,
    projectId: childId,
    boundWorkflowPath: QUEUE,
  });

  await expect(page.getByTestId(`project-live-${CHILD}`)).toHaveAttribute(
    "aria-label",
    "1 live session",
  );
  await expect(page.getByTestId(`project-live-${PARENT}`)).toHaveCount(0);

  await page.getByTestId(`project-select-${PARENT}`).click();
  await expect(page.getByTestId("project-session-empty")).toBeVisible();
});

test("groups count shared agent paths only within their own project", async ({
  page,
}) => {
  const parentId = await projectId(page, PARENT);
  const childId = await projectId(page, CHILD);
  expect(childId).not.toBe(parentId);

  await page.getByTestId("history-trigger").click();
  await page.getByTestId("filing-group-by").selectOption("group");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`group-create-${CHILD}`)).toBeVisible();

  await publishSession(page, {
    id: "child-session",
    cwd: CHILD_ROOT,
    projectId: childId,
    boundWorkflowPath: QUEUE,
  });
  const parent = page.getByTestId(`workspace-group-${PARENT}`);
  const child = page.getByTestId(`workspace-group-${CHILD}`);
  await expect(child.getByTestId("group-live-Ungrouped")).toHaveAttribute(
    "aria-label",
    "1 live session",
  );
  await expect(parent.getByTestId("group-live-gateway")).toHaveCount(0);

  await publishSession(page, {
    id: "parent-session",
    cwd: PARENT_ROOT,
    projectId: parentId,
    boundWorkflowPath: QUEUE,
  });
  await expect(parent.getByTestId("group-live-gateway")).toHaveAttribute(
    "aria-label",
    "1 live session",
  );
  await expect(child.getByTestId("group-live-Ungrouped")).toHaveAttribute(
    "aria-label",
    "1 live session",
  );
});

test("a project counts its sessions outside the displayed root without a cwd fallback", async ({
  page,
}) => {
  const parentId = await projectId(page, PARENT);
  // A durable project can have another active root. Its session principal,
  // rather than containment under the displayed root, owns the live count.
  await publishSession(page, {
    id: "other-root-session",
    cwd: "/Users/demo/polsia-secondary-root",
    projectId: parentId,
    status: "starting",
  });
  await expect(page.getByTestId(`project-live-${PARENT}`)).toHaveAttribute(
    "aria-label",
    "1 live session",
  );

  // Missing identity must not become a match just because its cwd is inside
  // a durable project. Ending the identified session therefore clears it.
  await publishSession(page, { id: "unidentified-session", cwd: PARENT_ROOT });
  await publishSession(page, {
    id: "other-root-session",
    cwd: "/Users/demo/polsia-secondary-root",
    projectId: parentId,
    status: "exited",
  });
  await expect(page.getByTestId(`project-live-${PARENT}`)).toHaveCount(0);
});
