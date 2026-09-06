import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { selectMockSessionFromPalette } from "./mock-navigation";

async function openProjectMap(page: Page, label: string): Promise<void> {
  const group = page.getByTestId(`workspace-group-${label}`);
  await group.getByTestId(`project-select-${label}`).click();
  await expect(group.getByTestId(`project-select-${label}`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

const activeSessionId = (page: Page): Promise<string | null> =>
  page.getByTestId("session-context").getAttribute("data-session-id");

interface NavigationEvidence {
  activeSessionId: string | null;
  createSessionCalls: number;
  injectInputCalls: number;
  resumeSessionCalls: number;
}

async function navigationEvidence(page: Page): Promise<NavigationEvidence> {
  const active = await activeSessionId(page);
  return page.evaluate((activeSession) => {
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
      activeSessionId: activeSession,
      createSessionCalls: state?.createSessionCalls?.length ?? 0,
      injectInputCalls: state?.injectInputCalls?.length ?? 0,
      resumeSessionCalls: state?.resumeSessionCalls?.length ?? 0,
    };
  }, active);
}

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

  test("a scaffolded sibling stays under its creating project and keeps the same conversation", async ({
    page,
  }) => {
    const project = page.getByTestId("workspace-group-acme-app");
    const sibling = project.getByTestId("workflow-report-reviewer");
    await expect(sibling).toBeVisible();
    await expect(page.getByTestId("workflow-report-reviewer")).toHaveCount(1);
    await expect(
      page.getByTestId("workspace-group-report-reviewer"),
    ).toHaveCount(0);
    const before = await navigationEvidence(page);
    await sibling.click();
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);
    await openProjectMap(page, "acme-app");
    await sibling.click();
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);
    await page.reload();
    await expect(project.getByTestId("workflow-report-reviewer")).toBeVisible();
    await sibling.click();
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    await expect(project.getByTestId("workflow-report-reviewer")).toBeVisible();
    await project.getByTestId("workflow-report-reviewer").click();
    expect(await navigationEvidence(page)).toEqual(before);
  });

  for (const [harness, sessionId] of [
    ["Claude Code", "sess-leasing"],
    ["Codex", "sess-leasing-2"],
  ]) {
    test(`a scaffolded sibling keeps its restored ${harness} conversation after restart`, async ({
      page,
    }) => {
      await page.getByTestId("history-trigger").click();
      await page.getByTestId("past-sessions-trigger").hover();
      await page.getByTestId(`exited-session-${sessionId}`).click();
      await expect(page.getByTestId("session-context")).toHaveAttribute(
        "data-session-id",
        sessionId,
      );
      await expect(page.getByTestId("dead-session-detail")).toContainText(harness);
      const before = await navigationEvidence(page);
      expect(before).toEqual({
        activeSessionId: sessionId,
        createSessionCalls: 0,
        injectInputCalls: 0,
        resumeSessionCalls: 0,
      });

      const sibling = page
        .getByTestId("workspace-group-acme-app")
        .getByTestId("workflow-report-reviewer");
      await sibling.click();
      await expect(page.getByTestId("session-context")).toHaveAttribute(
        "data-session-id",
        sessionId,
      );
      await expect(page.getByTestId("dead-session-pane")).toBeVisible();
      expect(await navigationEvidence(page)).toEqual(before);

      await page.reload();
      await expect(sibling).toBeVisible();
      await expect(page.getByTestId("session-context")).toHaveAttribute(
        "data-session-id",
        sessionId,
      );
      await expect(page.getByTestId("dead-session-detail")).toContainText(harness);
      await sibling.click();
      await expect(page.getByTestId("dead-session-pane")).toBeVisible();
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
      activeSessionId: "sess-boot",
      createSessionCalls: 0,
      injectInputCalls: 0,
      resumeSessionCalls: 0,
    });
  });

  test("a scaffolded sibling without a live conversation starts at its original project root", async ({
    page,
  }) => {
    await page
      .getByTestId("workspace-group-acme-app")
      .getByTestId("workflow-report-reviewer")
      .click();
    await page.getByTestId("open-agent-start-session").click();
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
    await expect(
      page.getByTestId("workspace-group-report-reviewer"),
    ).toHaveCount(0);
  });

  test("a scaffolded sibling is hidden with its closed project", async ({
    page,
  }) => {
    const project = page.getByTestId("workspace-group-acme-app");
    await expect(project.getByTestId("workflow-report-reviewer")).toBeVisible();
    await project.getByTestId("project-menu-acme-app").click();
    await page.getByTestId("project-remove-acme-app").click();
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(project).toHaveCount(0);
    await expect(page.getByTestId("workflow-report-reviewer")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("workflow-report-reviewer")).toHaveCount(0);
  });

  test("the project name opens the durable map without touching its active conversation", async ({
    page,
  }) => {
    const before = await navigationEvidence(page);
    expect(before.activeSessionId).toBeTruthy();

    await openProjectMap(page, "acme-app");

    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.locator(".harness-terminal .xterm")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toHaveText(
      "Nothing generated yet",
    );
    await expect(page.getByTestId("agent-map-row")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-select")).toHaveCount(0);
    expect(await navigationEvidence(page)).toEqual(before);

    const [cli, map] = await Promise.all([
      page.locator(".harness-terminal").boundingBox(),
      page.getByTestId("agent-map-empty").boundingBox(),
    ]);
    expect(cli?.width ?? 0).toBeGreaterThan(200);
    expect(map?.width ?? 0).toBeGreaterThan(200);
    expect(map?.x ?? 0).toBeGreaterThan((cli?.x ?? 0) + (cli?.width ?? 0) - 2);

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

  test("a project map never renders another project's active conversation", async ({
    page,
  }) => {
    const before = await navigationEvidence(page);
    expect(before.activeSessionId).toBe("sess-boot");

    await openProjectMap(page, "dashboard-keeper");

    await expect(page.getByTestId("agent-map-frame")).toBeVisible();
    await expect(page.locator(".harness-terminal")).toHaveCount(0);
    await expect(page.getByTestId("project-session-empty")).toContainText(
      "No active session in this project",
    );
    // Project-name navigation does not solve containment by selecting a
    // different session. The foreign active ID stays untouched but its CLI is
    // not mounted beside this project's map.
    const after = await navigationEvidence(page);
    expect(after).toMatchObject({
      createSessionCalls: before.createSessionCalls,
      injectInputCalls: before.injectInputCalls,
    });
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (
          (
            window as unknown as {
              __HARNESS_TEST__?: { trackEvents?: Array<{ event: string }> };
            }
          ).__HARNESS_TEST__?.trackEvents ?? []
        ).filter((event) => event.event === "session.switched"),
      ),
    ).toHaveLength(0);
  });

  test("the project name remains the map action on the Group axis", async ({
    page,
  }) => {
    const before = await navigationEvidence(page);
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");

    await openProjectMap(page, "polsia");
    await expect(page.getByTestId("agent-map-frame")).toBeVisible();
    await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-row")).toHaveCount(0);
    const after = await navigationEvidence(page);
    expect(after).toMatchObject({
      createSessionCalls: before.createSessionCalls,
      injectInputCalls: before.injectInputCalls,
    });
  });

  test("neutral project identity owns restoration instead of a foreign bound Canvas path", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockRestoreBindingConflict=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const acme = page
      .getByTestId("workspace-group-acme-app")
      .getByTestId("project-select-acme-app");
    await expect(acme).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("agent-map-frame")).toBeVisible();
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
    const evidence = await navigationEvidence(page);
    expect(evidence).toMatchObject({
      activeSessionId: "sess-boot",
      createSessionCalls: 0,
      injectInputCalls: 0,
    });
  });

  test("neutral project identity hands an overlapping nested-project agent to its own session", async ({
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
        const base = {
          agentSessionId: null,
          boundWorkflowPath: null,
          harness: "claude-code" as const,
          status: "running" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastActiveAt: "2026-01-01T00:00:00.000Z",
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

    await selectMockSessionFromPalette(page, "Outer project session");
    await expect.poll(() => activeSessionId(page)).toBe("sess-overlap-outer");

    const nestedProject = page.getByTestId(
      "workspace-group-polsia/services/workers",
    );
    await nestedProject
      .getByTestId("workflow-queue")
      .locator(".workflow-item-trigger")
      .click();

    await expect.poll(() => activeSessionId(page)).toBe("sess-overlap-nested");
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    await expect(page.getByTestId("right-tab-canvas")).toContainText("Canvas");
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
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

  test("expands the production Agent Map and unwinds its inspector before full view", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "dashboard-keeper");

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
  });

  test("Plan Agents and every sibling are ordinary exact-session tabs", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockStudioProjects=present&mockPlanAgentsSession=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "acme-app");

    const planAgents = page.getByTestId("session-tab-main-sess-boot");
    const sibling = page.getByTestId("session-tab-main-sess-leasing-2");
    await expect(planAgents).toHaveText(/Plan Agents/);
    await expect(page.getByText("Plan Agents", { exact: true })).toHaveCount(1);
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(1);
    await expect(page.getByTestId("session-tab-sess-leasing-2")).toHaveCount(1);
    await expect(page.getByTestId("session-tab-sess-bg")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-frame")).toBeVisible();

    const mapTabIds = await page
      .locator(".session-tabs-list > .session-tab")
      .evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute("data-testid")).filter(Boolean),
      );

    // A repeated status projection for the same durable session replaces its
    // row; it cannot manufacture a second user-visible tab.
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
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(1);

    await planAgents.click();
    await expect.poll(() => activeSessionId(page)).toBe("sess-boot");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
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
            ).__HARNESS_TEST__?.trackEvents ?? []
          ).some(
            (event) =>
              event.event === "session.switched" &&
              event.data?.navigation_kind === "session_tab" &&
              event.harnessSessionId === "sess-boot",
          ),
        ),
      )
      .toBe(true);
    await expect(page.getByTestId("agent-view")).toBeVisible();
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    await expect(page.getByTestId("right-tab-canvas")).toContainText("Canvas");
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    expect(
      await page
        .locator(".session-tabs-list > .session-tab")
        .evaluateAll((tabs) =>
          tabs.map((tab) => tab.getAttribute("data-testid")).filter(Boolean),
        ),
    ).toEqual(mapTabIds);

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
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);

    await openProjectMap(page, "acme-app");
    await expect.poll(() => activeSessionId(page)).toBe("sess-leasing-2");
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(1);
    await expect(page.getByTestId("session-tab-sess-leasing-2")).toHaveCount(1);
  });

  test("an exited active session never mounts dead-session chrome over the map", async ({
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

    await expect(page.getByTestId("agent-map-frame")).toBeVisible();
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.getByTestId("project-session-empty")).toBeVisible();
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(0);
    await expect(page.getByTestId("session-tab-sess-leasing-2")).toHaveCount(1);
    await expect(page.getByTestId("session-tab-new")).toHaveCount(1);
    await expect(page.getByTestId("planner-session-ended")).toHaveCount(0);
    await expect(
      page.getByText("New planning session", { exact: true }),
    ).toHaveCount(0);

    await page.getByTestId("session-tab-main-sess-leasing-2").click();
    await expect.poll(() => activeSessionId(page)).toBe("sess-leasing-2");
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    await expect(page.getByTestId("agent-view")).toBeVisible();
  });

  test("map failures stay in the map pane and never replace the conversation", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    const before = await navigationEvidence(page);
    await openProjectMap(page, "acme-app");
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);

    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=unauthorized",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openProjectMap(page, "acme-app");
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("agent-map-project-unavailable")).toBeVisible();
  });
});

test.describe("SAP-3148 mobile Agent Map", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the project name opens the map sheet without replacing the CLI", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    await expect(page.getByTestId("rail-expand")).toBeVisible();
    const before = await navigationEvidence(page);
    await page.getByTestId("rail-expand").click();
    // Selecting a mobile rail destination closes the drawer, so its pressed
    // state is intentionally no longer mounted after this click.
    await page
      .getByTestId("workspace-group-acme-app")
      .getByTestId("project-select-acme-app")
      .click();

    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.locator(".right-pane")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();
    await expect(page.getByTestId("right-sheet-scrim")).toBeVisible();
    expect(await navigationEvidence(page)).toEqual(before);

    await page.getByTestId("right-collapse").click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect(page.getByTestId("right-expand")).toBeFocused();
    await expect(page.getByTestId("right-expand")).toHaveText("Agent Map");
  });
});
