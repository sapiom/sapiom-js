/**
 * The project view and exact conversation navigation (flow-navigation.md 4.2,
 * 4.3, 4.4; design.md I2, I4, I5).
 *
 * The centre is ONE thing: a session's workbench, or a project's Agent Map at
 * full width. The map is never a right-pane tab beside a chat, and a project
 * click never moves the selected session. These replace the SAP-2980 specs
 * that asserted the opposite (the map filling the RIGHT pane while the
 * conversation kept the centre).
 */
import { expect, test, type Page } from "@playwright/test";
import { selectSession } from "./mock-navigation";

/** The rail's selected session row, which a project view leaves alone. */
const selectedRow = (page: Page): Promise<string[]> =>
  page
    .locator('.rail-session-row[data-selected="true"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));

const rowsOf = (page: Page, project: string): Promise<string[]> =>
  page
    .getByTestId(`rail-project-${project}`)
    .locator(".rail-session-row")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid") ?? ""));

const actions = (page: Page) =>
  page.evaluate(() => {
    const probe = (window as unknown as {
      __HARNESS_TEST__: Record<string, unknown[]>;
    }).__HARNESS_TEST__;
    return ["createSessionCalls", "resumeSessionCalls", "bindWorkflowCalls", "injectInputCalls"]
      .map((key) => probe[key]?.length ?? 0);
  });

/** Two live polsia sessions bound to different agents, newest activity last. */
async function publishPolsiaSessions(page: Page, projectId: string): Promise<void> {
  await page.evaluate((projectId) => {
    const { publish } = (window as unknown as {
      __HARNESS_TEST__: { publish: (message: unknown) => void };
    }).__HARNESS_TEST__;
    for (const [index, agent] of ["mailer", "rollup"].entries()) {
      const id = `sess-polsia-${agent}`;
      const at = new Date(Date.now() - (2 - index) * 60_000).toISOString();
      publish({
        type: "session.status",
        session: {
          id,
          agentSessionId: null,
          harness: "claude-code",
          cwd: "/Users/demo/polsia",
          status: "running",
          ready: true,
          title: agent,
          createdAt: at,
          lastActiveAt: at,
          boundWorkflowPath: agent === "mailer"
            ? "/Users/demo/polsia/packages/harness/web/src/components/mailer"
            : "/Users/demo/polsia/scripts/tools/rollup",
          agentMapIdentity: { projectId, userId: "user_mock", sessionId: id },
        },
      });
    }
  }, projectId);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await selectSession(page, "sess-boot");
  await expect(page.getByTestId("right-panel-board")).toBeVisible();
});

test("a project's fold, its agent canvas and Back/Forward all preserve the exact conversation", async ({ page }) => {
  await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1");
  await expect(page.getByTestId("session-context")).toBeVisible();
  const before = await selectedRow(page);
  const beforeActions = await actions(page);
  await page.getByTestId("project-select-acme-app").click();
  const map = page.getByTestId("agent-map-live");
  await expect(map).toBeVisible();
  const projectId = await map.getAttribute("data-project-id");
  // Folding the project hides its session rows, never its map.
  await page.getByTestId("project-disclosure-acme-app").click();
  await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(0);
  await expect(map).toBeVisible();
  await page.getByTestId("project-disclosure-acme-app").click();
  await expect(page.getByTestId("rail-session-sess-boot")).toBeVisible();
  await page.getByTestId("agent-map-node-node_00000000-0000-7000-8000-000000000101").click();
  await expect(page.getByTestId("map-agent-panel")).toBeVisible();
  await page.getByTestId("map-agent-open-canvas").click();
  await expect(page.getByTestId("project-map-pane")).toHaveAttribute("data-view", "agent");
  await page.getByTestId("session-nav-back").click();
  await expect(map).toHaveAttribute("data-project-id", projectId!);
  await page.getByTestId("session-nav-forward").click();
  await expect(page.getByTestId("project-map-pane")).toHaveAttribute("data-view", "agent");
  expect(await selectedRow(page)).toEqual(before);
  expect(await actions(page)).toEqual(beforeActions);
});

test("E3.1/E3.6 — the project's map fills the CENTRE at full width; no chat and no right pane beside it", async ({
  page,
}) => {
  await expect(page.locator(".harness-terminal")).toBeVisible();
  const before = await selectedRow(page);

  await page.getByTestId("project-select-acme-app").click();
  const pane = page.getByTestId("project-map-pane");
  await expect(pane).toBeVisible();
  await expect(page.locator(".harness-terminal")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toHaveAttribute("data-absent", "true");
  await expect(page.getByTestId("resize-handle-canvas")).toHaveCount(0);

  // ONE column, measured: the map spans the width the chat and its pane shared.
  const [mapBox, appBox] = await Promise.all([
    pane.boundingBox(),
    page.locator(".app").boundingBox(),
  ]);
  expect(mapBox!.width).toBeGreaterThan(appBox!.width - 40);

  // The selected session did not move.
  expect(await selectedRow(page)).toEqual(before);
});

test("E3.4 — an agent on the map opens its panel and moves NOTHING else", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  const before = await selectedRow(page);
  const rowsBefore = await rowsOf(page, "acme-app");

  await page.getByTestId("map-agent-leasing").click();
  await expect(page.getByTestId("map-agent-panel")).toHaveAttribute("data-agent", "leasing");

  // The panel opened in place; the session pointer and the rail rows held.
  await expect(page.getByTestId("project-map-pane")).toHaveAttribute("data-view", "map");
  expect(await selectedRow(page)).toEqual(before);
  expect(await rowsOf(page, "acme-app")).toEqual(rowsBefore);
});

test("E3.3 — sessions bound to different agents all stay in their project's rail rows", async ({ page }) => {
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await page.getByTestId("project-select-polsia").click();
  const map = page.getByTestId("agent-map-live");
  await expect(map).toBeVisible();
  const projectId = await map.getAttribute("data-project-id");
  expect(projectId).toBeTruthy();
  await publishPolsiaSessions(page, projectId!);
  await expect.poll(() => rowsOf(page, "polsia")).toEqual([
    "rail-session-sess-polsia-rollup",
    "rail-session-sess-polsia-mailer",
  ]);
  await selectSession(page, "sess-polsia-mailer");
  await page.getByTestId("project-select-polsia").click();
  await expect(map).toBeVisible();
  const before = await rowsOf(page, "polsia");
  // Looking at another agent's map changes neither the rows nor the session.
  await page.getByTestId("agent-map-node-node_00000000-0000-7000-8000-000000000101").click();
  await expect(page.getByTestId("map-agent-panel")).toBeVisible();
  expect(await selectedRow(page)).toEqual(["rail-session-sess-polsia-mailer"]);
  expect(await rowsOf(page, "polsia")).toEqual(before);
});

test("E3.9/E3.10 — the right pane is one agent's Canvas, Steps and Secrets, and a trip to the map keeps the tab", async ({
  page,
}) => {
  await page.getByTestId("right-tab-steps").click();
  await expect(page.getByTestId("right-tab-steps")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Three tabs, no Code and no Agent Map: the map is the project view's centre.
  await expect(page.getByTestId("right-tab-code")).toHaveCount(0);
  await expect(page.locator(".right-pane-tab")).toHaveCount(3);
  await expect(page.getByTestId("right-tab-canvas")).toHaveText("Canvas");

  await page.getByTestId("project-select-acme-app").click();
  await expect(page.locator(".right-pane")).toHaveAttribute("data-absent", "true");

  // The held Steps intent comes back with the session.
  await selectSession(page, "sess-boot");
  await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
  await expect(page.getByTestId("right-tab-steps")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Cmd/Ctrl+1..9 addresses the rows the rail renders for the shown project", async ({
  page,
}) => {
  /* The shortcut and the rail read ONE module (rail-sessions.ts). The tab
     strip this replaced resolved its list twice and the two drifted whenever a
     project was selected over an exited session. */
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const projectId = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  await publishPolsiaSessions(page, projectId!);
  await expect.poll(() => rowsOf(page, "polsia")).toEqual([
    "rail-session-sess-polsia-rollup",
    "rail-session-sess-polsia-mailer",
  ]);

  // Row 2 in the rail is the older session, and that is what Cmd+2 selects.
  await page.keyboard.press("ControlOrMeta+2");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-polsia-mailer",
  );
  // A number key is exact conversation navigation, like a row click: the map
  // gives way to that session's workbench and its agent's pane.
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(page.getByTestId("right-tab-canvas")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-polsia-rollup",
  );

  // An exited row stays a row (within the 7-day window), so the numbering the
  // user is counting along does not shift under them.
  await page.evaluate((projectId) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    (window as unknown as {
      __HARNESS_TEST__: { publish: (message: unknown) => void };
    }).__HARNESS_TEST__.publish({
      type: "session.status",
      session: {
        id: "sess-polsia-rollup",
        agentSessionId: null,
        harness: "claude-code",
        cwd: "/Users/demo/polsia",
        boundWorkflowPath: "/Users/demo/polsia/scripts/tools/rollup",
        title: "rollup",
        status: "exited",
        exitCode: 0,
        ready: false,
        createdAt: at,
        lastActiveAt: at,
        agentMapIdentity: { projectId, userId: "user_mock", sessionId: "sess-polsia-rollup" },
      },
    });
  }, projectId!);
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+2");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-polsia-mailer",
  );
});
