/** Project-map shell and exact conversation navigation after topology retirement. */
import { expect, test, type Page } from "@playwright/test";

const activeSessionId = (page: Page): Promise<string | null> =>
  page.getByTestId("session-context").getAttribute("data-session-id");

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("agent-map-frame")).toBeVisible();
  await page.getByTestId("session-tab-main-sess-boot").click();
  await expect(page.getByTestId("right-panel-board")).toBeVisible();
});

test("map disclosure and Back/Forward preserve the exact conversation", async ({ page }) => {
  await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1");
  await expect(page.getByTestId("session-context")).toBeVisible();
  const before = await activeSessionId(page);
  const actions = () => page.evaluate(() => {
    const probe = (window as unknown as {
      __HARNESS_TEST__: Record<string, unknown[]>;
    }).__HARNESS_TEST__;
    return ["createSessionCalls", "resumeSessionCalls", "bindWorkflowCalls", "injectInputCalls"]
      .map((key) => probe[key]?.length ?? 0);
  });
  const beforeActions = await actions();
  await page.getByTestId("project-select-acme-app").click();
  const map = page.getByTestId("agent-map-live");
  await expect(map).toBeVisible();
  const projectId = await map.getAttribute("data-project-id");
  await page.getByTestId("project-disclosure-acme-app").click();
  await expect(page.getByTestId("workflow-leasing")).toHaveCount(0);
  await expect(map).toBeVisible();
  await page.getByTestId("project-disclosure-acme-app").click();
  await expect(page.getByTestId("workflow-leasing")).toBeVisible();
  await page.getByTestId("agent-map-node-node_00000000-0000-7000-8000-000000000101").click();
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId("right-panel-board")).toBeVisible();
  const focused = await page.locator(".workflow-item.is-focused").getAttribute("data-testid");
  expect(focused).toBeTruthy();
  await page.getByTestId("session-nav-back").click();
  await expect(map).toHaveAttribute("data-project-id", projectId!);
  await page.getByTestId("session-nav-forward").click();
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId(focused!)).toHaveClass(/is-focused/);
  expect(await activeSessionId(page)).toBe(before);
  expect(await actions()).toEqual(beforeActions);
});

test("E3.1/E3.6 — the project's map fills the RIGHT pane; the conversation keeps the centre", async ({
  page,
}) => {
  await expect(page.locator(".harness-terminal")).toBeVisible();
  const before = await activeSessionId(page);

  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-frame")).toBeVisible();

  // The centre pane is not merely present — it is live. `inert` was the
  // letterbox pattern this epic removes: the panes stayed mounted behind the
  // destination and could not be typed into.
  const centre = page.locator(".center-pane");
  await expect(centre).toBeVisible();
  await expect(centre).not.toHaveAttribute("inert", "");
  await expect(page.locator(".harness-terminal")).toBeVisible();

  // TWO columns, measured. A single-track grid is the collapse this fixes, and
  // it is invisible to any assertion that only counts elements.
  const [centreBox, mapBox, appBox] = await Promise.all([
    centre.boundingBox(),
    page.getByTestId("agent-map-frame").boundingBox(),
    page.locator(".app").boundingBox(),
  ]);
  expect(centreBox!.width).toBeGreaterThan(200);
  expect(mapBox!.width).toBeGreaterThan(200);
  expect(mapBox!.x).toBeGreaterThan(centreBox!.x + centreBox!.width - 2);
  expect(mapBox!.width).toBeLessThan(appBox!.width);

  // acme-app already owns the boot session, so selecting it hands nothing over.
  expect(await activeSessionId(page)).toBe(before);

  // The resize handle survives: the two panes are still two panes.
  await expect(page.getByTestId("resize-handle-canvas")).toBeVisible();
});

test("E3.4 — selecting a sibling agent moves the right pane and NOTHING else", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-frame")).toBeVisible();
  const before = await activeSessionId(page);
  const tabsBefore = await page
    .getByRole("tablist", { name: "Sessions" })
    .getByRole("tab")
    .allTextContents();

  await page
    .getByTestId("workflow-leasing")
    .locator(".workflow-item-trigger")
    .click();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);

  // The right pane cut to board altitude...
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  await expect(page.getByTestId("right-panel-board")).toBeVisible();
  // ...and the conversation did not move. Both halves matter: the session
  // POINTER staying put is invisible if the strip beneath it re-keys, which is
  // what "the conversation vanishing on a look" actually looked like.
  expect(await activeSessionId(page)).toBe(before);
  expect(
    await page
      .getByRole("tablist", { name: "Sessions" })
      .getByRole("tab")
      .allTextContents(),
  ).toEqual(tabsBefore);
});

test("E3.3 — sessions bound to different agents stay in the project strip on sibling Canvas navigation", async ({ page }) => {
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await expect(page.getByTestId("project-select-polsia")).toBeVisible();
  await page.getByTestId("project-select-polsia").click();
  const map = page.getByTestId("agent-map-live");
  await expect(map).toBeVisible();
  const projectId = await map.getAttribute("data-project-id");
  expect(projectId).toBeTruthy();
  await page.evaluate((projectId) => {
    const { publish } = (window as unknown as {
      __HARNESS_TEST__: { publish: (message: unknown) => void };
    }).__HARNESS_TEST__;
    for (const [index, agent] of ["mailer", "rollup"].entries()) {
      const id = `sess-polsia-${agent}`;
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
          createdAt: `2026-08-01T1${index}:00:00.000Z`,
          lastActiveAt: `2026-08-01T1${index}:00:00.000Z`,
          boundWorkflowPath: agent === "mailer"
            ? "/Users/demo/polsia/packages/harness/web/src/components/mailer"
            : "/Users/demo/polsia/scripts/tools/rollup",
          agentMapIdentity: { projectId, userId: "user_mock", sessionId: id },
        },
      });
    }
  }, projectId!);
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute("data-testid", "session-tab-main-sess-polsia-mailer");
  await expect(tabs.nth(1)).toHaveAttribute("data-testid", "session-tab-main-sess-polsia-rollup");
  await tabs.nth(0).click();
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-polsia-mailer");
  await page.getByTestId("project-select-polsia").click();
  await expect(map).toBeVisible();
  const before = await tabs.allTextContents();
  await page.getByTestId("workflow-rollup").locator(".workflow-item-trigger").click();
  await expect(page.getByTestId("workflow-rollup")).toHaveClass(/is-focused/);
  await expect(map).toHaveCount(0);
  await expect(page.getByTestId("right-panel-board")).toBeVisible();
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-polsia-mailer");
  await expect(tabs).toHaveCount(2);
  expect(await tabs.allTextContents()).toEqual(before);
});

test("E3.9/E3.10 — Steps says why it cannot answer for a project; Code is gone", async ({
  page,
}) => {
  await page.getByTestId("right-tab-steps").click();
  await expect(page.getByTestId("right-tab-steps")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByTestId("project-select-acme-app").click();
  const steps = page.getByTestId("right-tab-steps");
  await expect(steps).toBeDisabled();
  await expect(steps).toHaveAttribute(
    "data-tooltip",
    "Steps belong to one agent — select an agent to see them",
  );
  await expect(steps).toHaveAttribute(
    "aria-label",
    "Steps belong to one agent — select an agent to see them",
  );
  // Secrets belongs to ONE agent for the same reason Steps does — the engine
  // stores a credential per definition — so it is disabled here and says why.
  // Sharper than Steps, in fact: a tab still listing the last agent's
  // credentials under a project's name would invite a wrong conclusion about a
  // different agent.
  const secrets = page.getByTestId("right-tab-secrets");
  await expect(secrets).toBeDisabled();
  await expect(secrets).toHaveAttribute(
    "data-tooltip",
    "Secrets belong to one agent — select an agent to see them",
  );

  // The map is what the Canvas tab shows at this altitude, so the tab set never
  // grows a peer for it. Three tabs — Canvas, Steps, Secrets — and no fourth.
  await expect(page.getByTestId("right-tab-canvas")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("right-tab-code")).toHaveCount(0);
  await expect(page.locator(".right-pane-tab")).toHaveCount(3);

  // The held Steps intent is not destroyed by the trip up — it is restored on
  // the way back down.
  await page.getByTestId("workflow-leasing").locator(".workflow-item-trigger").click();
  await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
  await expect(page.getByTestId("right-tab-steps")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Cmd/Ctrl+1..9 addresses the tabs the STRIP rendered, not a second list", async ({
  page,
}) => {
  /* The key handler resolves the tab list a second time, and the two resolvers
     have to be given the same inputs. Handed no selected project, they agree
     only while the active session is live and inside a known root — so a
     project selected over an EXITED session gave the strip the project's tabs
     and the handler the exited session's own subject, and Cmd+1 activated a
     session that was not tab 1. */
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const projectId = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  expect(projectId).toBeTruthy();
  await page.evaluate((selectedProjectId) => {
    const publish = (
      window as unknown as {
        __HARNESS_TEST__?: {
          publish?: (message: Record<string, unknown>) => void;
        };
      }
    ).__HARNESS_TEST__?.publish;
    const base = {
      agentSessionId: null,
      harness: "claude-code" as const,
      cwd: "/Users/demo/polsia",
      status: "running" as const,
      ready: true,
    };
    publish?.({
      type: "session.status",
      session: {
        ...base,
        id: "sess-polsia-1",
        boundWorkflowPath:
          "/Users/demo/polsia/packages/harness/web/src/components/mailer",
        title: "mailer",
        createdAt: "2026-08-01T10:00:00.000Z",
        lastActiveAt: "2026-08-01T10:00:00.000Z",
        agentMapIdentity: {
          projectId: selectedProjectId,
          userId: "user_mock",
          sessionId: "sess-polsia-1",
        },
      },
    });
    publish?.({
      type: "session.status",
      session: {
        ...base,
        id: "sess-polsia-2",
        boundWorkflowPath: "/Users/demo/polsia/scripts/tools/rollup",
        title: "rollup",
        createdAt: "2026-08-01T11:00:00.000Z",
        lastActiveAt: "2026-08-01T11:00:00.000Z",
        agentMapIdentity: {
          projectId: selectedProjectId,
          userId: "user_mock",
          sessionId: "sess-polsia-2",
        },
      },
    });
  }, projectId!);

  await expect(page.getByTestId("agent-map-frame")).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);

  // Tab 2 in the strip is the newer session — and that is what Cmd+2 selects.
  await page.keyboard.press("ControlOrMeta+2");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-polsia-2",
  );
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-polsia-1",
  );
  // A number key is exact conversation navigation, just like clicking the
  // corresponding tab. The project map therefore gives way to that ordinary
  // session's Canvas/Steps experience while the project-wide tab set remains.
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(page.getByTestId("right-tab-canvas")).toBeEnabled();

  // Even after the active tab exits, its neutral project identity keeps the
  // shortcut resolver on the exact same project-wide set. The remaining live
  // tab becomes Cmd/Ctrl+1 rather than disappearing behind an agent-path rule.
  await page.evaluate((selectedProjectId) => {
    (
      window as unknown as {
        __HARNESS_TEST__?: {
          publish?: (message: Record<string, unknown>) => void;
        };
      }
    ).__HARNESS_TEST__?.publish?.({
      type: "session.status",
      session: {
        id: "sess-polsia-1",
        agentSessionId: null,
        harness: "claude-code",
        cwd: "/Users/demo/polsia",
        boundWorkflowPath:
          "/Users/demo/polsia/packages/harness/web/src/components/mailer",
        title: "mailer",
        status: "exited",
        exitCode: 0,
        ready: false,
        createdAt: "2026-08-01T10:00:00.000Z",
        lastActiveAt: "2026-08-01T10:00:00.000Z",
        agentMapIdentity: {
          projectId: selectedProjectId,
          userId: "user_mock",
          sessionId: "sess-polsia-1",
        },
      },
    });
  }, projectId!);
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-polsia-2",
  );
});
