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

async function openPlannerSessionCallCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { openPlannerSessionCalls?: unknown[] };
        }
      ).__HARNESS_TEST__?.openPlannerSessionCalls?.length ?? 0,
  );
}

test.describe("SAP-3058 Agent Map planning workspace", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("first open starts the raw planner CLI beside the honest empty map", async ({
    page,
  }) => {
    await openDashboardMap(page);

    const terminal = page.locator(".harness-terminal");
    await expect(terminal).toBeVisible();
    await expect(terminal.locator(".xterm")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toHaveText(
      "Nothing generated yet",
    );

    const [cli, map] = await Promise.all([
      terminal.boundingBox(),
      page.getByTestId("agent-map-empty").boundingBox(),
    ]);
    expect(cli?.width ?? 0).toBeGreaterThan(200);
    expect(map?.width ?? 0).toBeGreaterThan(200);
    expect(map?.x ?? 0).toBeGreaterThan((cli?.x ?? 0) + (cli?.width ?? 0) - 2);
    await page.screenshot({
      path: "web/e2e/screenshots/agent-map-planning.png",
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
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("agent-map-live")).toBeVisible({
      timeout: 1_000,
    });
    await expect(page.getByTestId("planning-fanout-consent")).toHaveCount(0);
    await expect(page.getByTestId("open-planning-sessions")).toHaveCount(0);
    const tabs = page
      .getByRole("tablist", { name: "Sessions" })
      .getByRole("tab");
    await expect(tabs).toHaveCount(1);

    const preparation = await page.evaluate(async () => {
      const testState = (
        window as unknown as {
          __HARNESS_TEST__?: {
            plannerPreparePlanningFanout?: () => Promise<unknown>;
          };
        }
      ).__HARNESS_TEST__;
      return testState?.plannerPreparePlanningFanout?.();
    });
    expect(preparation).toMatchObject({
      consentId: expect.stringMatching(/^fanout-consent_/u),
      assignmentIds: [
        "assignment_00000000-0000-7000-8000-000000000101",
        "assignment_00000000-0000-7000-8000-000000000102",
      ],
      plan: expect.objectContaining({
        planId: expect.stringMatching(/^build-plan_/u),
        semanticDigest: expect.stringMatching(/^sha256:/u),
      }),
      source: expect.objectContaining({
        proposalId: expect.stringMatching(/^proposal_/u),
        graphDigest: expect.stringMatching(/^sha256:/u),
      }),
      sessions: [
        expect.objectContaining({
          agentName: "Stock Research",
          mission:
            "Research public-market signals and produce sourced findings.",
          executionPolicy: "planning-readonly",
          brief: expect.objectContaining({
            briefId: expect.stringMatching(/^brief_/u),
            version: 1,
            semanticDigest: expect.stringMatching(/^sha256:/u),
          }),
        }),
        expect.objectContaining({
          agentName: "Marketing",
          mission: "Turn approved findings into audience-ready campaigns.",
          executionPolicy: "planning-readonly",
          brief: expect.objectContaining({
            briefId: expect.stringMatching(/^brief_/u),
            version: 1,
            semanticDigest: expect.stringMatching(/^sha256:/u),
          }),
        }),
      ],
      expectedSessionCount: 2,
      expectedKickoffPromptCount: 2,
    });
    // Preparation is the planner's summary/consent boundary and has no spawn
    // side effect. Opening happens only after the next conversational turn.
    await expect(tabs).toHaveCount(1);
    await page.evaluate(async () => {
      const testState = (
        window as unknown as {
          __HARNESS_TEST__?: {
            plannerOpenPlanningFanoutAfterConsent?: () => Promise<unknown>;
          };
        }
      ).__HARNESS_TEST__;
      await testState?.plannerOpenPlanningFanoutAfterConsent?.();
    });
    await expect(tabs).toHaveCount(3);
    await page.evaluate(async () => {
      const testState = (
        window as unknown as {
          __HARNESS_TEST__?: {
            plannerOpenPlanningFanoutAfterConsent?: () => Promise<unknown>;
          };
        }
      ).__HARNESS_TEST__;
      await testState?.plannerOpenPlanningFanoutAfterConsent?.();
    });
    await expect(tabs).toHaveCount(3);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = (
            window as unknown as {
              __HARNESS_TEST__?: {
                planningPlannerEvidence?: {
                  consentId?: string;
                  confirmation?: string;
                  provenance?: string;
                  assignmentIds?: string[];
                };
                planningFanoutResponse?: {
                  consentId?: string;
                  bindings?: Array<{
                    sessionId?: string;
                    bootstrapDigest?: string;
                    kickoff?: { state?: string; attemptCount?: number };
                  }>;
                };
              };
            }
          ).__HARNESS_TEST__;
          const bindings = state?.planningFanoutResponse?.bindings ?? [];
          return {
            provenance: state?.planningPlannerEvidence?.provenance,
            confirmation: state?.planningPlannerEvidence?.confirmation,
            exactConsent:
              state?.planningPlannerEvidence?.consentId ===
              state?.planningFanoutResponse?.consentId,
            assignmentIds:
              state?.planningPlannerEvidence?.assignmentIds?.join(","),
            bindingCount: bindings.length,
            uniqueSessions: new Set(
              bindings.map((binding) => binding.sessionId),
            ).size,
            acknowledgedKickoffs: bindings.filter(
              (binding) =>
                binding.kickoff?.state === "delivered" &&
                binding.kickoff.attemptCount === 1,
            ).length,
            nonzeroBootstraps: bindings.filter(
              (binding) =>
                binding.bootstrapDigest != null &&
                !/^sha256:0{64}$/u.test(binding.bootstrapDigest),
            ).length,
          };
        }),
      )
      .toEqual({
        provenance: "planner-mcp-after-conversation-consent",
        confirmation: "user-confirmed",
        exactConsent: true,
        assignmentIds:
          "assignment_00000000-0000-7000-8000-000000000101,assignment_00000000-0000-7000-8000-000000000102",
        bindingCount: 2,
        uniqueSessions: 2,
        acknowledgedKickoffs: 2,
        nonzeroBootstraps: 2,
      });
    await expect(tabs.filter({ hasText: "Planner" })).toHaveCount(1);
    await expect(tabs.filter({ hasText: "Stock Research" })).toHaveCount(1);
    const marketingTab = tabs.filter({ hasText: "Marketing" });
    await expect(marketingTab).toHaveCount(1);
    await expect(marketingTab).toHaveAttribute(
      "aria-label",
      /Planning read-only · Planning$/,
    );
    await expect(marketingTab).toContainText("Planning read-only · Planning");

    const plannerSessionId = await activeSessionId(page);
    const researchTab = page.getByRole("tab", {
      name: /^Stock Research ·/,
    });
    await researchTab.click();
    const researchSessionId = await activeSessionId(page);
    expect(researchSessionId).toBeTruthy();
    expect(researchSessionId).not.toBe(plannerSessionId);
    await expect(
      page.getByRole("button", {
        name: "Stock Research, agent, Proposed",
      }),
    ).toHaveAttribute("aria-pressed", "true");

    await marketingTab.click();
    const marketingSessionId = await activeSessionId(page);
    expect(marketingSessionId).toBeTruthy();
    expect(marketingSessionId).not.toBe(researchSessionId);
    await expect(
      page.getByRole("button", { name: "Marketing, agent, Proposed" }),
    ).toHaveAttribute("aria-pressed", "true");

    await tabs.filter({ hasText: "Planner" }).click();
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      plannerSessionId ?? "",
    );
    await researchTab.click();
    await page.getByTestId("session-tab-new").click();
    await expect(tabs).toHaveCount(4);
    const extraResearch = tabs.filter({ hasText: "Stock Research 2" });
    await expect(extraResearch).toHaveCount(1);
    await expect(extraResearch).toContainText("Planning read-only · Planning");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __HARNESS_TEST__?: {
                  additionalBuilderSessionCalls?: unknown[];
                };
              }
            ).__HARNESS_TEST__?.additionalBuilderSessionCalls?.length ?? 0,
        ),
      )
      .toBe(1);

    await extraResearch.click();
    const extraResearchSessionId = await activeSessionId(page);
    expect(extraResearchSessionId).toBeTruthy();
    expect(extraResearchSessionId).not.toBe(researchSessionId);
    await page.evaluate((sessionId) => {
      (
        window as unknown as {
          __HARNESS_TEST__?: {
            exitBuilderPlanningSession?: (id: string) => void;
          };
        }
      ).__HARNESS_TEST__?.exitBuilderPlanningSession?.(sessionId!);
    }, extraResearchSessionId);
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
    await page.getByTestId("dead-session-resume").click();
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      extraResearchSessionId ?? "",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __HARNESS_TEST__?: { builderPlanningResumeCalls?: string[] };
              }
            ).__HARNESS_TEST__?.builderPlanningResumeCalls ?? [],
        ),
      )
      .toContain(extraResearchSessionId);

    await researchTab.click();
    await page.evaluate((sessionId) => {
      (
        window as unknown as {
          __HARNESS_TEST__?: {
            exitBuilderPlanningSession?: (id: string) => void;
          };
        }
      ).__HARNESS_TEST__?.exitBuilderPlanningSession?.(sessionId!);
    }, researchSessionId);
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
    await page.getByTestId("dead-session-resume").click();
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      researchSessionId ?? "",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __HARNESS_TEST__?: { builderPlanningResumeCalls?: string[] };
              }
            ).__HARNESS_TEST__?.builderPlanningResumeCalls ?? [],
        ),
      )
      .toContain(researchSessionId);

    for (const [state, label] of [
      ["pending", "Starting"],
      ["submitted", "Submitted"],
      ["delivery-uncertain", "Delivery uncertain"],
      ["failed", "Failed"],
      ["planning", "Planning"],
    ] as const) {
      await page.evaluate(
        ({ nextState }) => {
          (
            window as unknown as {
              __HARNESS_TEST__?: {
                setBuilderPlanningState?: (
                  agentId: string,
                  state: string,
                ) => void;
              };
            }
          ).__HARNESS_TEST__?.setBuilderPlanningState?.(
            "node_00000000-0000-7000-8000-000000000102",
            nextState,
          );
        },
        { nextState: state },
      );
      await expect(
        page.getByTestId(`session-planning-status-${marketingSessionId}`),
      ).toHaveText(`Planning read-only · ${label}`);
    }

    await page.evaluate(() => {
      (
        window as unknown as {
          __HARNESS_TEST__?: {
            staleBuilderPlanningAssignment?: (agentId: string) => void;
          };
        }
      ).__HARNESS_TEST__?.staleBuilderPlanningAssignment?.(
        "node_00000000-0000-7000-8000-000000000102",
      );
    });
    await expect(
      page.getByTestId(`session-planning-status-${marketingSessionId}`),
    ).toHaveText("Planning read-only · Stale");
    await expect(
      page.getByTestId(`session-planning-status-${researchSessionId}`),
    ).toHaveText("Planning read-only · Planning");
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
    await tabs.filter({ hasText: "Planner" }).click();
    await page.getByRole("button", { name: "Close node details" }).click();

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
    const liveMap = page.getByTestId("agent-map-live");
    await expect(
      liveMap.getByText("Stock Research", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      liveMap.getByText("Marketing", { exact: true }).first(),
    ).toBeVisible();
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
      liveMap.getByText("Campaign Marketing", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        mapSubject.evaluate(
          (element) => (element as HTMLElement).style.transform,
        ),
      )
      .toBe(transformedView);
    await liveMap.getByText("Campaign Marketing", { exact: true }).click();
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
      liveMap.getByText("Equity Research", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("agent-map-latest-attribution"),
    ).toContainText("Agent builder · unplanned");
  });

  test("reports a partial planning fan-out without claiming every assignment opened", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1&mockPlanningUnreachable=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await page.evaluate(async () => {
      const testState = (
        window as unknown as {
          __HARNESS_TEST__?: {
            plannerPreparePlanningFanout?: () => Promise<unknown>;
            plannerOpenPlanningFanoutAfterConsent?: () => Promise<unknown>;
          };
        }
      ).__HARNESS_TEST__;
      await testState?.plannerPreparePlanningFanout?.();
      await testState?.plannerOpenPlanningFanoutAfterConsent?.();
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __HARNESS_TEST__?: {
                  planningFanoutResponse?: {
                    bindings?: unknown[];
                    unreachableAssignmentIds?: string[];
                  };
                };
              }
            ).__HARNESS_TEST__?.planningFanoutResponse,
        ),
      )
      .toMatchObject({
        bindings: [{}, {}],
        unreachableAssignmentIds: [
          "assignment_00000000-0000-7000-8000-000000000102",
        ],
      });
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

  test("keeps unavailable fan-out diagnostics inside the planner flow", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1&mockPlanningFanoutUnavailable=1",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            typeof (
              window as unknown as {
                __HARNESS_TEST__?: {
                  plannerPreparePlanningFanout?: () => Promise<unknown>;
                };
              }
            ).__HARNESS_TEST__?.plannerPreparePlanningFanout,
        ),
      )
      .toBe("function");
    const preparation = await page.evaluate(async () => {
      const testState = (
        window as unknown as {
          __HARNESS_TEST__?: {
            plannerPreparePlanningFanout?: () => Promise<unknown>;
          };
        }
      ).__HARNESS_TEST__;
      return testState?.plannerPreparePlanningFanout?.();
    });
    expect(preparation).toEqual({
      available: false,
      warnings: ["Resolve the incomplete build-plan decisions first."],
    });
    await expect(page.getByTestId("planning-fanout-unavailable")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("open-planning-sessions")).toHaveCount(0);
    await expect(
      page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
    ).toHaveCount(1);
  });

  test("a generating greeting still renders the raw planner CLI", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockGreeting=generating",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    const terminal = page.locator(".harness-terminal");
    await expect(terminal).toBeVisible();
    await expect(terminal.locator(".xterm")).toBeVisible();
  });

  test("return resumes the same planner and plus creates a fresh planner tab", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await expect(page.locator(".harness-terminal")).toBeVisible();
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

  test("an explicitly selected planner tab wins over project resume ordering", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await expect(page.locator(".harness-terminal")).toBeVisible();
    const first = await activeSessionId(page);
    expect(first).toBeTruthy();

    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-rename").click();
    const rename = page.getByTestId("session-rename-input");
    await rename.fill("Planner A");
    await rename.press("Enter");

    await page.getByTestId("session-tab-new").click();
    await expect.poll(() => activeSessionId(page)).not.toBe(first);
    const callsBeforeExplicitSelection =
      await openPlannerSessionCallCount(page);

    await page
      .getByTestId("workflow-dashboard-keeper")
      .locator("button")
      .click();
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("right-tab-canvas")).toContainText("Canvas");
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("Planner A");
    await page
      .getByTestId("command-palette-list")
      .getByText("Planner A", { exact: true })
      .click();

    await expect(page.locator(".harness-terminal")).toBeVisible();
    expect(await activeSessionId(page)).toBe(first);
    await expect(page.getByTestId("planner-loading")).toHaveCount(0);
    expect(await openPlannerSessionCallCount(page)).toBe(
      callsBeforeExplicitSelection,
    );
  });

  test("planner session chrome retains rename/end and omits path/editor actions", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await expect(page.locator(".harness-terminal")).toBeVisible();

    await page.getByTestId("session-menu").click();
    const menu = page.getByTestId("session-menu-popover");
    await expect(menu.getByTestId("session-rename")).toBeVisible();
    await expect(menu.getByTestId("session-end-btn")).toBeVisible();
    await expect(menu.getByText("Copy path", { exact: true })).toHaveCount(0);
    await expect(menu.getByTestId("session-open-editor")).toHaveCount(0);
  });

  test("ending the planner exposes an immediate fresh-session path", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await expect(page.locator(".harness-terminal")).toBeVisible();
    const ended = await activeSessionId(page);

    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-end-btn").click();
    await expect(page.getByTestId("end-session-confirm")).toContainText(
      "stops the planning conversation",
    );
    await expect(page.getByTestId("end-session-confirm")).not.toContainText(
      "live terminal",
    );
    await page.getByTestId("end-session-confirm-btn").click();

    await expect(page.getByTestId("planner-session-ended")).toBeVisible();
    const startFresh = page.getByTestId("session-tab-new");
    await expect(startFresh).toHaveAttribute(
      "aria-label",
      "New planning session",
    );
    await startFresh.click();

    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect.poll(() => activeSessionId(page)).not.toBe(ended);
  });

  test("a failed greeting still leaves the raw planner CLI visible", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockGreeting=failed",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    const terminal = page.locator(".harness-terminal");
    await expect(terminal).toBeVisible();
    await expect(terminal.locator(".xterm")).toBeVisible();
  });

  test("workspace and planner failures stay local, while unauthorized is whole-workspace", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.locator(".harness-terminal")).toBeVisible();
    await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
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
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockPlanner=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.getByTestId("planner-load-error")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toBeVisible();
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
              event.data?.pane === "planner",
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
      path: "web/e2e/screenshots/agent-map-planning-mobile.png",
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

    // Open the sheet while the new planner is still launching. Its automatic
    // ready/status event arrives later and must not replay the failed preference
    // restore or collapse the user-opened Agent Map.
    await page.getByTestId("right-expand").click();
    await expect(page.locator(".right-pane")).toBeVisible();
    await expect(
      page.locator(".session-dot[data-status='running']"),
    ).toBeVisible();
    await expect(page.locator(".right-pane")).toBeVisible();
  });
});
