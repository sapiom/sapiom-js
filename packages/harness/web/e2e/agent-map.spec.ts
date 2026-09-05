import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openDashboardMap(page: Page): Promise<void> {
  const group = page.getByTestId("workspace-group-dashboard-keeper");
  await expect(group.getByTestId("agent-map-row")).toBeVisible();
  await group.getByTestId("agent-map-select").click();
}

async function activeSessionId(page: Page): Promise<string | null> {
  return page.getByTestId("session-context").getAttribute("data-session-id");
}

async function createSessionCallCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { createSessionCalls?: unknown[] };
        }
      ).__HARNESS_TEST__?.createSessionCalls?.length ?? 0,
  );
}

/** Opening a project starts nothing (SAP-3143); its first session is explicit. */
async function startProjectSession(page: Page): Promise<void> {
  await page.getByTestId("project-session-start").click();
  await expect(page.locator(".harness-terminal")).toBeVisible();
}

test.describe("SAP-3058 Agent Map workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("first open shows the map and starts NO session (SAP-3143)", async ({
    page,
  }) => {
    const before = await createSessionCallCount(page);
    await openDashboardMap(page);

    // The map renders from durable state, and the centre says honestly that
    // nothing is running. No session was created by looking at a project.
    await expect(page.getByTestId("project-session-empty")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toHaveText(
      "Nothing generated yet",
    );
    await expect(page.locator(".harness-terminal")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await createSessionCallCount(page)).toBe(before);

    // The explicit Start is what creates it, through the ordinary path.
    await startProjectSession(page);
    expect(await createSessionCallCount(page)).toBe(before + 1);
    const [cli, map] = await Promise.all([
      page.locator(".harness-terminal").boundingBox(),
      page.getByTestId("agent-map-empty").boundingBox(),
    ]);
    expect(cli?.width ?? 0).toBeGreaterThan(200);
    expect(map?.width ?? 0).toBeGreaterThan(200);
    expect(map?.x ?? 0).toBeGreaterThan((cli?.x ?? 0) + (cli?.width ?? 0) - 2);
    await page.screenshot({
      path: "web/e2e/screenshots/agent-map.png",
      fullPage: true,
    });

    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (
              window as unknown as {
                __HARNESS_TEST__?: { trackEvents?: Array<{ event: string }> };
              }
            ).__HARNESS_TEST__?.trackEvents ?? []
          ).map((event) => event.event),
        ),
      )
      .toContain("agent_map.entered");
  });

  test("renders the stock-research proposal and a coding-agent follow-up live", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.getByTestId("agent-map-live")).toBeVisible({
      timeout: 1_000,
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (
              window as unknown as {
                __HARNESS_TEST__?: { trackEvents?: Array<{ event: string }> };
              }
            ).__HARNESS_TEST__?.trackEvents ?? []
          ).map((event) => event.event),
        ),
      )
      .toContain("agent_map.proposal_visible");

    const nodes = page.locator("[data-proposal-state='proposed']");
    await expect(nodes).toHaveCount(6);
    for (const kind of [
      "agent",
      "subagent",
      "resource",
      "connector",
      "artifact",
    ]) {
      await expect(
        page.locator(`[data-node-kind='${kind}']`).first(),
      ).toBeVisible();
    }
    await expect(
      page.getByText("Stock Research", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Marketing", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Research Database", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("TikTok", { exact: true })).toBeVisible();
    await expect(
      page.getByText("ResearchReport", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("News Editor", { exact: true })).toBeVisible();
    await expect(
      page.getByTestId("agent-map-live").getByText(/capability/i),
    ).toHaveCount(0);

    const researchReport = page.getByRole("button", {
      name: "ResearchReport, artifact, Proposed",
    });
    await researchReport.click();
    const inspector = page.getByTestId("agent-map-inspector");
    await expect(inspector).toContainText("Purpose");
    await expect(inspector).toContainText("Contracts");
    await expect(inspector).toContainText("Map planner");
    await page.getByRole("button", { name: "Close node details" }).click();
    await expect(inspector).toHaveCount(0);
    await expect(researchReport).toBeFocused();

    await researchReport.click();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await expect(researchReport).toBeFocused();

    await page.getByRole("button", { name: "Zoom in" }).click();
    const mapSubject = page.getByTestId("agent-map-subject");
    const transformedView = await mapSubject.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );

    const projectId = await page
      .getByTestId("agent-map-live")
      .getAttribute("data-project-id");
    expect(projectId).toBeTruthy();
    await page.evaluate((activeProjectId) => {
      const test = (
        window as unknown as {
          __HARNESS_TEST__?: { publish?: (message: unknown) => void };
        }
      ).__HARNESS_TEST__;
      test?.publish?.({
        type: "agent-map.proposal.changed",
        delta: {
          schemaVersion: 1,
          projectId: activeProjectId,
          proposalId: "proposal_00000000-0000-7000-8000-000000000101",
          fromVersion: 1,
          version: 2,
          operationIds: ["operation_00000000-0000-7000-8000-000000000401"],
          operations: [
            {
              kind: "update-node",
              nodeId: "node_00000000-0000-7000-8000-000000000102",
              changes: { name: "Campaign Marketing" },
            },
          ],
          actor: {
            userId: "user_mock",
            sessionId: "builder_mock",
            role: "agent-builder",
            assignment: { kind: "unplanned" },
          },
          acceptedAt: new Date().toISOString(),
        },
      });
    }, projectId);
    await expect(
      page.getByText("Campaign Marketing", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        mapSubject.evaluate(
          (element) => (element as HTMLElement).style.transform,
        ),
      )
      .toBe(transformedView);
    await page.getByText("Campaign Marketing", { exact: true }).click();
    await expect(
      page.getByTestId("agent-map-latest-attribution"),
    ).toContainText("Agent builder · unplanned");
    await expect(page.locator("[data-proposal-state='proposed']")).toHaveCount(
      6,
    );

    await page.evaluate((activeProjectId) => {
      const test = (
        window as unknown as {
          __HARNESS_TEST__?: { publish?: (message: unknown) => void };
        }
      ).__HARNESS_TEST__;
      test?.publish?.({
        type: "agent-map.proposal.changed",
        delta: {
          schemaVersion: 1,
          projectId: activeProjectId,
          proposalId: "proposal_00000000-0000-7000-8000-000000000101",
          fromVersion: 2,
          version: 3,
          operationIds: ["operation_00000000-0000-7000-8000-000000000402"],
          operations: [
            {
              kind: "update-node",
              nodeId: "node_00000000-0000-7000-8000-000000000101",
              changes: { name: "Equity Research" },
            },
          ],
          actor: {
            userId: "user_mock",
            sessionId: "planner_mock",
            role: "map-planner",
            assignment: null,
          },
          acceptedAt: new Date().toISOString(),
        },
      });
    }, projectId);
    await expect(
      page.getByText("Equity Research", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("agent-map-latest-attribution"),
    ).toContainText("Agent builder · unplanned");
  });

  test("expands the Agent Map in place and unwinds its inspector before full view", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    const map = page.getByTestId("agent-map-live");
    await expect(map).toBeVisible();
    const subject = page.getByTestId("agent-map-subject");
    await page.getByRole("button", { name: "Zoom in" }).click();
    const adjustedView = await subject.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );

    const expand = page.getByTestId("canvas-expand");
    await expect(expand).toHaveAccessibleName("Expand Agent Map");
    await expand.click();

    const frame = page.getByTestId("agent-map-frame");
    await expect(frame).toHaveClass(/is-expanded/);
    await expect(frame).toHaveCSS("position", "fixed");
    await expect(page.getByTestId("resize-handle-rail")).toHaveCount(0);
    await expect(page.getByTestId("resize-handle-canvas")).toHaveCount(0);
    await expect
      .poll(() =>
        subject.evaluate((element) => (element as HTMLElement).style.transform),
      )
      .toBe(adjustedView);

    await page
      .getByRole("button", { name: "ResearchReport, artifact, Proposed" })
      .click();
    await expect(page.getByTestId("agent-map-inspector")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-map-inspector")).toHaveCount(0);
    await expect(frame).toHaveClass(/is-expanded/);

    await page.keyboard.press("Escape");
    await expect(frame).not.toHaveClass(/is-expanded/);
    await expect(page.getByTestId("resize-handle-rail")).toBeVisible();
    await expect(page.getByTestId("resize-handle-canvas")).toBeVisible();

    await expand.click();
    await page.getByTestId("canvas-expand-exit").click();
    await expect(frame).not.toHaveClass(/is-expanded/);
  });

  test("the removed greeting fixtures no longer create a session on open", async ({
    page,
  }) => {
    // ?mockGreeting was planner-only. Whatever a stale link carries, opening a
    // project shows the map and starts nothing.
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockGreeting=generating",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    await expect(page.getByTestId("project-session-empty")).toBeVisible();
    await expect(page.locator(".harness-terminal")).toHaveCount(0);
    await startProjectSession(page);
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
  });

  test("return keeps the project's own session and plus creates a second tab", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await startProjectSession(page);
    const first = await activeSessionId(page);
    expect(first).toBeTruthy();

    await page
      .getByTestId("workflow-dashboard-keeper")
      .locator("button")
      .click();
    // Moving down from the project map to an agent changes only the right-hand
    // subject. The coding-agent CLI stays mounted in the centre and the
    // selected agent's canvas/step graph becomes available beside it.
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("right-tab-canvas")).toContainText("Canvas");
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("right-tab-canvas")).toContainText(
      "Agent Map",
    );
    await expect(page.getByTestId("right-tab-steps")).toBeDisabled();
    expect(await activeSessionId(page)).toBe(first);

    await page.getByTestId("session-tab-new").click();
    await expect.poll(() => activeSessionId(page)).not.toBe(first);
    const second = await activeSessionId(page);
    await expect(
      page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
    ).toHaveCount(2);
    await expect(page.locator(".harness-terminal")).toBeVisible();

    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-end-btn").click();
    await page.getByTestId("end-session-confirm-btn").click();
    expect(second).not.toBe(first);
    await expect.poll(() => activeSessionId(page)).toBe(first);
    await expect(
      page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
    ).toHaveCount(1);
    await expect(page.locator(".harness-terminal")).toBeVisible();
  });

  test("an explicitly selected session tab is not replaced by a new one", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await startProjectSession(page);
    const first = await activeSessionId(page);
    expect(first).toBeTruthy();

    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-rename").click();
    const rename = page.getByTestId("session-rename-input");
    await rename.fill("Session A");
    await rename.press("Enter");

    await page.getByTestId("session-tab-new").click();
    await expect.poll(() => activeSessionId(page)).not.toBe(first);
    const callsBeforeExplicitSelection = await createSessionCallCount(page);

    await page
      .getByTestId("workflow-dashboard-keeper")
      .locator("button")
      .click();
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("right-tab-canvas")).toContainText("Canvas");
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("Session A");
    await page
      .getByTestId("command-palette-list")
      .getByText("Session A", { exact: true })
      .click();

    await expect(page.locator(".harness-terminal")).toBeVisible();
    expect(await activeSessionId(page)).toBe(first);
    expect(await createSessionCallCount(page)).toBe(
      callsBeforeExplicitSelection,
    );
  });

  test("a project session has the ordinary chrome, including path and editor", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await startProjectSession(page);

    await page.getByTestId("session-menu").click();
    const menu = page.getByTestId("session-menu-popover");
    await expect(menu.getByTestId("session-rename")).toBeVisible();
    await expect(menu.getByTestId("session-end-btn")).toBeVisible();
    // SAP-3143: it is an ordinary session, so it keeps the ordinary actions
    // that the planner deliberately hid.
    await expect(menu.getByText("Copy path", { exact: true })).toBeVisible();
    await expect(menu.getByTestId("session-open-editor")).toBeVisible();
  });

  test("ending the last session returns to the honest empty state", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await startProjectSession(page);
    const ended = await activeSessionId(page);

    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-end-btn").click();
    // The planner-only copy is gone with the planner.
    await expect(page.getByTestId("end-session-confirm")).not.toContainText(
      "planning conversation",
    );
    await page.getByTestId("end-session-confirm-btn").click();

    await expect(page.getByTestId("project-session-empty")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();
    await startProjectSession(page);
    await expect.poll(() => activeSessionId(page)).not.toBe(ended);
  });

  test("a project with no session shows the map, not an error", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockGreeting=failed",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    await expect(page.getByTestId("project-session-empty")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();
    await expect(page.getByTestId("agent-map-load-error")).toHaveCount(0);
  });

  test("a map read failure is local, while unauthorized is whole-workspace", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
    // The centre is unaffected: the project can still start a session.
    await expect(page.getByTestId("project-session-empty")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (
              window as unknown as {
                __HARNESS_TEST__?: {
                  trackEvents?: Array<{
                    event: string;
                    data?: Record<string, unknown>;
                  }>;
                };
              }
            ).__HARNESS_TEST__?.trackEvents ?? []
          ).some(
            (event) =>
              event.event === "agent_map.workspace_load_failed" &&
              event.data?.pane === "map",
          ),
        ),
      )
      .toBe(true);

    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=unauthorized",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.getByTestId("agent-map-unavailable")).toBeVisible();
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect(page.getByTestId("resize-handle-canvas")).toHaveCount(0);
  });
});

test.describe("SAP-3058 mobile Agent Map", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the raw CLI stays primary and the explicit sheet restores focus on close", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    await expect(page.getByTestId("rail-expand")).toBeVisible();
    await page.getByTestId("rail-expand").click();
    await openDashboardMap(page);
    await startProjectSession(page);

    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect(page.getByTestId("session-menu")).toBeVisible();
    const openMap = page.getByTestId("right-expand");
    await expect(openMap).toHaveText("Agent Map");

    await openMap.click();
    await expect(page.locator(".right-pane")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();
    await expect(page.getByTestId("right-sheet-scrim")).toBeVisible();

    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("command-palette-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette-input")).toHaveCount(0);
    await expect(page.locator(".right-pane")).toBeVisible();

    await page.getByTestId("right-collapse").click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect(page.getByTestId("right-expand")).toBeFocused();
    await page.screenshot({
      path: "web/e2e/screenshots/agent-map-mobile.png",
      fullPage: true,
    });
  });

  test("a failed preference restore cannot repeatedly close the map sheet", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockStudioPreference=error",
    );
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.locator(".right-pane")).toBeHidden();

    // The mock preference read has one 180 ms round trip. Let its one-shot
    // failure settle before the user explicitly opens the sheet; the assertion
    // below then guards against later session updates closing it again.
    await page.waitForTimeout(250);
    const first = await activeSessionId(page);
    const newSession = page.getByTestId("session-tab-new");
    await expect(newSession).toBeEnabled();
    await newSession.click();
    await expect.poll(() => activeSessionId(page)).not.toBe(first);

    // Open the sheet while the new session is still launching. Its automatic
    // ready/status event arrives later and must not replay the failed preference
    // restore or collapse the user-opened Agent Map.
    await page.getByTestId("right-expand").click();
    await expect(page.locator(".right-pane")).toBeVisible();
    // The strip now shows the project's ordinary sessions, so more than one
    // may be running; one live dot is enough to prove a session update landed.
    await expect(
      page.locator(".session-dot[data-status='running']").first(),
    ).toBeVisible();
    await expect(page.locator(".right-pane")).toBeVisible();
  });
});
