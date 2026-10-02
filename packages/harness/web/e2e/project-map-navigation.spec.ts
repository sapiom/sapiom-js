import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Project Agent Map navigation (SAP-3148), re-pointed at Project › Sessions
 * (flow-navigation.md 4.3, 4.4; design.md I1, I5). A project's name puts its
 * map in the CENTRE; nothing about that click creates, resumes, prompts or
 * swaps a session, and the selected session stays the rail's filled row.
 * Session membership is the server-issued project identity, never a path.
 */

async function openProjectMap(page: Page, label: string): Promise<void> {
  await page.getByTestId(`project-select-${label}`).click();
  await expect(page.getByTestId(`project-select-${label}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
}

const activeSessionId = (page: Page): Promise<string | null> =>
  page.getByTestId("session-context").getAttribute("data-session-id");

const rowsOf = (page: Page, project: string): Promise<string[]> =>
  page
    .getByTestId(`rail-project-${project}`)
    .locator(".rail-session-row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        (row.getAttribute("data-testid") ?? "").replace("rail-session-", ""),
      ),
    );

interface NavigationEvidence {
  selectedSession: string | null;
  createSessionCalls: number;
  injectInputCalls: number;
  resumeSessionCalls: number;
}

/** The selected session is read off the rail: the project view's header names
 *  the project, so the session context there is empty by design. */
async function navigationEvidence(page: Page): Promise<NavigationEvidence> {
  const selected = await page
    .locator('.rail-session-row[data-selected="true"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        (row.getAttribute("data-testid") ?? "").replace("rail-session-", ""),
      ),
    );
  return page.evaluate((selectedSession) => {
    const state = (
      window as unknown as {
        __HARNESS_TEST__?: {
          createSessionCalls?: unknown[];
          injectInputCalls?: unknown[];
          resumeSessionCalls?: unknown[];
        };
      }
    ).__HARNESS_TEST__;
    return {
      selectedSession,
      createSessionCalls: state?.createSessionCalls?.length ?? 0,
      injectInputCalls: state?.injectInputCalls?.length ?? 0,
      resumeSessionCalls: state?.resumeSessionCalls?.length ?? 0,
    };
  }, selected[0] ?? null);
}

const trackEvents = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: {
            trackEvents?: Array<{
              event: string;
              data?: { navigation_kind?: string };
              harnessSessionId?: string;
            }>;
          };
        }
      ).__HARNESS_TEST__?.trackEvents ?? [],
  );

test.describe("SAP-3148 project Agent Map navigation", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const sibling = testInfo.title.startsWith("a scaffolded sibling")
      ? "&mockCreatedSibling=1"
      : "";
    const empty = testInfo.title.includes("without a live conversation")
      ? "&mockNoLiveSessions=1"
      : "";
    const restored = testInfo.title.includes("after restart")
      ? "&mockRestoredSessions=1"
      : "";
    await page.goto(
      `/?seed=0&mockFixtures=deep&mockStudioProjects=present${sibling}${empty}${restored}`,
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("a scaffolded sibling is an agent of its creating project and opening it keeps the same conversation", async ({
    page,
  }) => {
    // Its folder is outside acme-app, but its server binding is acme-app's: it
    // is on acme-app's map and never becomes a project of its own.
    await expect(page.getByTestId("rail-project-report-reviewer")).toHaveCount(0);
    const before = await navigationEvidence(page);
    expect(before.selectedSession).toBe("sess-boot");
    await openProjectMap(page, "acme-app");
    await page.getByTestId("map-agent-report-reviewer").click();
    await expect(page.getByTestId("map-agent-panel")).toHaveAttribute(
      "data-agent",
      "report-reviewer",
    );
    expect(await navigationEvidence(page)).toEqual(before);
    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "acme-app");
    await page.getByTestId("map-agent-report-reviewer").click();
    await expect(page.getByTestId("map-agent-panel")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);
  });

  for (const [harness, sessionId] of [
    ["Claude Code", "sess-leasing"],
    ["Codex", "sess-leasing-2"],
  ]) {
    test(`a scaffolded sibling keeps its restored ${harness} conversation after restart`, async ({
      page,
    }) => {
      await page.getByTestId("rail-history").click();
      await page.getByTestId(`exited-session-${sessionId}`).click();
      await expect(page.getByTestId("session-context")).toHaveAttribute(
        "data-session-id",
        sessionId,
      );
      await expect(page.getByTestId("dead-session-detail")).toContainText(harness);
      const before = await navigationEvidence(page);
      expect(before).toEqual({
        selectedSession: sessionId,
        createSessionCalls: 0,
        injectInputCalls: 0,
        resumeSessionCalls: 0,
      });

      await openProjectMap(page, "acme-app");
      await page.getByTestId("map-agent-report-reviewer").click();
      await expect(page.getByTestId("map-agent-panel")).toBeVisible();
      expect(await navigationEvidence(page)).toEqual(before);

      // The exact conversation comes back with the session, not with the map.
      await page.reload();
      await expect(page.getByTestId("session-context")).toHaveAttribute(
        "data-session-id",
        sessionId,
      );
      await expect(page.getByTestId("dead-session-detail")).toContainText(harness);
      await openProjectMap(page, "acme-app");
      await page.getByTestId("map-agent-report-reviewer").click();
      await expect(page.locator(".harness-terminal .xterm")).toHaveCount(0);
      expect(await navigationEvidence(page)).toEqual(before);
    });
  }

  test("a stale saved conversation falls back to the existing live session", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const key = "sapiom-harness-ui-prefs";
      const prefs = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(
        key,
        JSON.stringify({ ...prefs, activeSessionId: "removed-session" }),
      );
    });
    await page.reload();
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual({
      selectedSession: "sess-boot",
      createSessionCalls: 0,
      injectInputCalls: 0,
      resumeSessionCalls: 0,
    });
  });

  test("a scaffolded sibling without a live conversation starts its chat at its creating project's root", async ({
    page,
  }) => {
    await openProjectMap(page, "acme-app");
    await page.getByTestId("map-agent-report-reviewer").click();
    await page.getByTestId("map-agent-start-chat").click();
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__?: {
              createSessionCalls?: Array<{ req: { cwd: string } }>;
            };
          }
        ).__HARNESS_TEST__?.createSessionCalls ?? [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.req.cwd).toBe("/Users/demo/acme-app");
    await expect(page.getByTestId("rail-project-report-reviewer")).toHaveCount(0);
    const created = (await rowsOf(page, "acme-app"))[0]!;
    await expect(page.getByTestId(`rail-session-${created}`)).toHaveAttribute(
      "data-agent",
      "report-reviewer",
    );
  });

  test("a scaffolded sibling goes with its closed project", async ({ page }) => {
    await expect(page.getByTestId("rail-project-acme-app")).toBeVisible();
    await page.getByTestId("workspace-group-acme-app").hover();
    await page.getByTestId("project-remove-acme-app").click();
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("rail-project-acme-app")).toHaveCount(0);
    await expect(page.getByTestId("rail-project-report-reviewer")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("rail-project-acme-app")).toHaveCount(0);
    await expect(page.getByTestId("rail-project-report-reviewer")).toHaveCount(0);
  });

  test("the project name opens the durable map at full width without touching the selected conversation", async ({
    page,
  }) => {
    const before = await navigationEvidence(page);
    expect(before.selectedSession).toBeTruthy();

    await openProjectMap(page, "acme-app");

    // The centre is the map, never the chat beside it.
    await expect(page.locator(".harness-terminal")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-row")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-select")).toHaveCount(0);
    expect(await navigationEvidence(page)).toEqual(before);
    const [map, app] = await Promise.all([
      page.getByTestId("project-map-pane").boundingBox(),
      page.locator(".app").boundingBox(),
    ]);
    expect(map!.width).toBeGreaterThan(app!.width - 40);

    await expect
      .poll(async () => (await trackEvents(page)).map((event) => event.event))
      .toContain("agent_map.entered");
  });

  test("a project map never renders another project's conversation", async ({
    page,
  }) => {
    const before = await navigationEvidence(page);
    expect(before.selectedSession).toBe("sess-boot");

    await openProjectMap(page, "dashboard-keeper");

    await expect(page.locator(".harness-terminal")).toHaveCount(0);
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    // A project click does not solve containment by selecting a different
    // session: the foreign selection stays, and nothing switched.
    expect(await navigationEvidence(page)).toEqual(before);
    expect(
      (await trackEvents(page)).filter(
        (event) => event.event === "session.switched",
      ),
    ).toHaveLength(0);
  });

  test("project identity, not a bound Canvas path, owns a session's rail row", async ({
    page,
  }) => {
    // sess-boot is bound to an agent path under polsia/services/workers, but
    // its server-issued project is acme-app.
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockRestoreBindingConflict=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    expect(await rowsOf(page, "acme-app")).toContain("sess-boot");
    expect(await rowsOf(page, "polsia/services/workers")).not.toContain("sess-boot");
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
    expect(await navigationEvidence(page)).toMatchObject({
      selectedSession: "sess-boot",
      createSessionCalls: 0,
      injectInputCalls: 0,
    });
  });

  test("overlapping projects each list only their own sessions, and Cmd/Ctrl+1 on the nested map selects the nested one", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockNoLiveSessions=1&mockStudioProjects=present&mockAgentMapGolden=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openProjectMap(page, "polsia");
    const outerProjectId = await page
      .getByTestId("agent-map-live")
      .getAttribute("data-project-id");
    await openProjectMap(page, "polsia/services/workers");
    const nestedProjectId = await page
      .getByTestId("agent-map-live")
      .getAttribute("data-project-id");
    expect(outerProjectId).toBeTruthy();
    expect(nestedProjectId).toBeTruthy();
    expect(nestedProjectId).not.toBe(outerProjectId);

    await page.evaluate(
      ({ outerId, nestedId }) => {
        const publish = (
          window as unknown as {
            __HARNESS_TEST__?: { publish?: (message: unknown) => void };
          }
        ).__HARNESS_TEST__?.publish;
        const at = new Date().toISOString();
        const base = {
          agentSessionId: null,
          boundWorkflowPath: null,
          harness: "claude-code" as const,
          status: "running" as const,
          createdAt: at,
          lastActiveAt: at,
          ready: true,
        };
        publish?.({
          type: "session.status",
          session: {
            ...base,
            id: "sess-overlap-outer",
            cwd: "/Users/demo/polsia",
            title: "Outer project session",
            agentMapIdentity: {
              projectId: outerId,
              userId: "user_mock",
              sessionId: "sess-overlap-outer",
            },
          },
        });
        publish?.({
          type: "session.status",
          session: {
            ...base,
            id: "sess-overlap-nested",
            cwd: "/Users/demo/polsia/services/workers",
            title: "Nested project session",
            agentMapIdentity: {
              projectId: nestedId,
              userId: "user_mock",
              sessionId: "sess-overlap-nested",
            },
          },
        });
      },
      { outerId: outerProjectId!, nestedId: nestedProjectId! },
    );

    // The outer root contains the nested cwd, and still does not list it.
    await expect.poll(() => rowsOf(page, "polsia")).toEqual(["sess-overlap-outer"]);
    expect(await rowsOf(page, "polsia/services/workers")).toEqual([
      "sess-overlap-nested",
    ]);

    await page.getByTestId("rail-session-select-sess-overlap-outer").click();
    await expect.poll(() => activeSessionId(page)).toBe("sess-overlap-outer");
    await openProjectMap(page, "polsia/services/workers");
    await page.keyboard.press("ControlOrMeta+1");
    await expect.poll(() => activeSessionId(page)).toBe("sess-overlap-nested");
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  });

  test("renders E2 structured state and applies attributed deltas without resetting the viewport", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "dashboard-keeper");
    await expect(page.getByTestId("agent-map-live")).toBeVisible({
      timeout: 1_000,
    });

    const nodes = page.locator(".agent-map-node");
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
      name: "ResearchReport, artifact",
    });
    await researchReport.click();
    const inspector = page.getByTestId("agent-map-inspector");
    await expect(inspector).toContainText("Purpose");
    await expect(inspector).toContainText("Contracts");
    await expect(inspector).toContainText("Project agent");
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
      const publish = (
        window as unknown as {
          __HARNESS_TEST__?: { publish?: (message: unknown) => void };
        }
      ).__HARNESS_TEST__?.publish;
      publish?.({
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
    ).toContainText("Project agent");
    await expect(nodes).toHaveCount(6);
  });

  test("Plan Agents and every sibling are ordinary exact-session rail rows", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockStudioProjects=present&mockPlanAgentsSession=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "acme-app");

    const planAgents = page.getByTestId("rail-session-select-sess-boot");
    const sibling = page.getByTestId("rail-session-select-sess-leasing-2");
    await expect(planAgents).toContainText("Plan Agents");
    await expect(page.getByText("Plan Agents", { exact: true })).toHaveCount(1);
    await expect(page.getByTestId("rail-session-sess-leasing-2")).toHaveCount(1);
    expect(await rowsOf(page, "acme-app")).not.toContain("sess-bg");
    const rowsBefore = await rowsOf(page, "acme-app");

    // A repeated status projection for the same durable session replaces its
    // row; it cannot manufacture a second user-visible row.
    await page.evaluate(() => {
      const publish = (
        window as unknown as {
          __HARNESS_TEST__?: { publish?: (message: unknown) => void };
        }
      ).__HARNESS_TEST__?.publish;
      publish?.({
        type: "session.status",
        session: {
          id: "sess-boot",
          agentSessionId: null,
          boundWorkflowPath: "/Users/demo/acme-app/leasing",
          harness: "claude-code",
          cwd: "/Users/demo/acme-app",
          title: "Plan Agents",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: new Date().toISOString(),
          ready: true,
          agentMapIdentity: {
            projectId: "project_00000000-0000-4000-8000-000000000001",
            userId: "user_mock",
            sessionId: "sess-boot",
          },
        },
      });
    });
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(1);

    await planAgents.click();
    await expect.poll(() => activeSessionId(page)).toBe("sess-boot");
    await expect
      .poll(async () =>
        (await trackEvents(page)).some(
          (event) =>
            event.event === "session.switched" &&
            event.data?.navigation_kind === "rail_session" &&
            event.harnessSessionId === "sess-boot",
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("agent-view")).toBeVisible();
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    await expect(page.getByTestId("right-tab-canvas")).toContainText("Canvas");
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    expect((await rowsOf(page, "acme-app")).sort()).toEqual([...rowsBefore].sort());

    await page.getByTestId("session-menu").click();
    const menu = page.getByTestId("session-menu-popover");
    await expect(menu.getByText("Copy path", { exact: true })).toBeVisible();
    await expect(menu.getByTestId("session-rename")).toBeVisible();
    await expect(menu.getByTestId("session-open-editor")).toBeVisible();
    await expect(menu.getByTestId("session-end-btn")).toBeVisible();
    await page.keyboard.press("Escape");

    await sibling.click();
    await expect.poll(() => activeSessionId(page)).toBe("sess-leasing-2");
    await expect(page.getByTestId("agent-view")).toBeVisible();

    // The project view leaves the selection where the row click put it.
    await openProjectMap(page, "acme-app");
    await expect(page.getByTestId("rail-session-sess-leasing-2")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(1);
  });

  test("a selected session that exits under the map never mounts dead-session chrome over it", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockStudioProjects=present&mockPlanAgentsSession=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "acme-app");

    await page.evaluate(() => {
      const publish = (
        window as unknown as {
          __HARNESS_TEST__?: { publish?: (message: unknown) => void };
        }
      ).__HARNESS_TEST__?.publish;
      publish?.({
        type: "session.status",
        session: {
          id: "sess-boot",
          agentSessionId: null,
          boundWorkflowPath: "/Users/demo/acme-app/leasing",
          harness: "claude-code",
          cwd: "/Users/demo/acme-app",
          title: "Plan Agents",
          status: "exited",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: new Date().toISOString(),
          exitCode: 0,
          ready: false,
          agentMapIdentity: {
            projectId: "project_00000000-0000-4000-8000-000000000001",
            userId: "user_mock",
            sessionId: "sess-boot",
          },
        },
      });
    });

    await expect(page.getByTestId("project-map-pane")).toBeVisible();
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    // The row drops to the exited mark and keeps the selection (D43).
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-mark",
      "exited",
    );
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.getByTestId("planner-session-ended")).toHaveCount(0);
    await expect(
      page.getByText("New planning session", { exact: true }),
    ).toHaveCount(0);

    await page.getByTestId("rail-session-select-sess-leasing-2").click();
    await expect.poll(() => activeSessionId(page)).toBe("sess-leasing-2");
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    await expect(page.getByTestId("agent-view")).toBeVisible();
  });

  test("map failures stay in the map's centre and never replace the selected conversation", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    const before = await navigationEvidence(page);
    await openProjectMap(page, "acme-app");
    await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);

    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=unauthorized",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "acme-app");
    await expect(page.getByTestId("agent-map-project-unavailable")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);
  });
});

test.describe("SAP-3148 mobile Agent Map", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the project name opens the map as the centre, and the CLI is one rail tap away", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    await expect(page.getByTestId("rail-expand")).toBeVisible();
    const before = await page.evaluate(() => {
      const state = (window as unknown as {
        __HARNESS_TEST__?: { createSessionCalls?: unknown[]; injectInputCalls?: unknown[] };
      }).__HARNESS_TEST__;
      return [state?.createSessionCalls?.length ?? 0, state?.injectInputCalls?.length ?? 0];
    });
    await page.getByTestId("rail-expand").click();
    // Selecting a mobile rail destination closes the drawer.
    await page.getByTestId("project-select-acme-app").click();
    await expect(page.locator(".rail-workflows")).toHaveCount(0);
    await expect(page.getByTestId("project-map-pane")).toBeVisible();
    await expect(page.locator(".harness-terminal")).toHaveCount(0);
    await expect(page.getByTestId("right-sheet-scrim")).toHaveCount(0);

    await page.getByTestId("rail-expand").click();
    await page.getByTestId("rail-session-select-sess-boot").click();
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const state = (window as unknown as {
          __HARNESS_TEST__?: { createSessionCalls?: unknown[]; injectInputCalls?: unknown[] };
        }).__HARNESS_TEST__;
        return [state?.createSessionCalls?.length ?? 0, state?.injectInputCalls?.length ?? 0];
      }),
    ).toEqual(before);
  });
});
