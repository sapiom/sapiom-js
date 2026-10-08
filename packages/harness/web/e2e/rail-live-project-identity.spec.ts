/**
 * A session belongs to exactly ONE project, by its server-issued identity
 * (design.md I1, `lib/rail-sessions.ts`), never by cwd containment: an outer
 * project's root contains a nested project's sessions on disk, and must not
 * list them.
 */
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
    const now = new Date().toISOString();
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
        createdAt: now,
        lastActiveAt: now,
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

const rowIn = (page: Page, project: string, id: string) =>
  page.getByTestId(`rail-project-${project}`).getByTestId(`rail-session-${id}`);

test.beforeEach(async ({ page }) => {
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present",
  );
  await expect(page.getByTestId(`workspace-group-${PARENT}`)).toBeVisible();
});

test("a nested project's session is listed under it, never under its parent", async ({
  page,
}) => {
  const childId = await projectId(page, CHILD);
  await publishSession(page, {
    id: "child-session",
    cwd: CHILD_ROOT,
    projectId: childId,
    boundWorkflowPath: QUEUE,
  });

  await expect(rowIn(page, CHILD, "child-session")).toHaveAttribute("data-mark", "live");
  await expect(rowIn(page, PARENT, "child-session")).toHaveCount(0);
  await expect(page.getByTestId("rail-session-child-session")).toHaveCount(1);

  // The parent's map is the centre with no chat: the nested session is not
  // the parent's to show.
  await page.getByTestId(`project-select-${PARENT}`).click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
});

test("a project lists its sessions outside the displayed root, and an unidentified session is in no project", async ({
  page,
}) => {
  const parentId = await projectId(page, PARENT);
  // A durable project can have another active root. Its session principal,
  // rather than containment under the displayed root, owns the row.
  await publishSession(page, {
    id: "other-root-session",
    cwd: "/Users/demo/polsia-secondary-root",
    projectId: parentId,
    status: "starting",
  });
  await expect(rowIn(page, PARENT, "other-root-session")).toHaveAttribute(
    "data-mark",
    "live",
  );

  // Missing identity must not become a match just because its cwd is inside
  // a durable project: History and Search reach it, the rail does not.
  await publishSession(page, { id: "unidentified-session", cwd: PARENT_ROOT });
  await expect(page.getByTestId("rail-session-unidentified-session")).toHaveCount(0);
  // ...and the rail is still drawn: a session without identity is skipped,
  // never a crash that takes every row with it.
  await expect(rowIn(page, PARENT, "other-root-session")).toBeVisible();

  await publishSession(page, {
    id: "other-root-session",
    cwd: "/Users/demo/polsia-secondary-root",
    projectId: parentId,
    status: "exited",
  });
  await expect(rowIn(page, PARENT, "other-root-session")).toHaveAttribute(
    "data-mark",
    "exited",
  );
});
