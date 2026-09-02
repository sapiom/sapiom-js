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

  test("first open starts a planner beside the honest empty map", async ({
    page,
  }) => {
    await openDashboardMap(page);

    await expect(page.getByTestId("planning-conversation")).toBeVisible();
    await expect(page.getByTestId("agent-map-empty")).toHaveText(
      "Nothing generated yet",
    );
    await expect(
      page.getByTestId("planner-transcript-assistant"),
    ).toContainText("What kind of agent architecture do you want to build?");
    // The automatic greeting is assistant-initiated. No fake user/control
    // instruction is projected into the conversation.
    await expect(
      page
        .getByTestId("planner-transcript-turn")
        .first()
        .locator(".transcript-role-user"),
    ).toHaveCount(0);
    await expect(page.getByTestId("planner-composer-input")).toBeEnabled();
    await expect(page.locator(".harness-terminal")).toHaveCount(0);

    const [conversation, map] = await Promise.all([
      page.getByTestId("planning-conversation").boundingBox(),
      page.getByTestId("agent-map-empty").boundingBox(),
    ]);
    expect(conversation?.width ?? 0).toBeGreaterThan(200);
    expect(map?.width ?? 0).toBeGreaterThan(200);
    expect(map?.x ?? 0).toBeGreaterThan(
      (conversation?.x ?? 0) + (conversation?.width ?? 0) - 2,
    );
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

  test("a user can proceed while the greeting is generating and the record refetches", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockGreeting=generating",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    await expect(page.getByTestId("planner-greeting-generating")).toBeVisible();
    const composer = page.getByTestId("planner-composer-input");
    await expect(composer).toBeEnabled();
    await composer.fill("A support triage system for customer requests.");
    await page.getByTestId("planner-composer-send").click();
    await composer.fill("A follow-up I started while that was queued.");

    await expect(page.getByTestId("planner-queued-inputs")).toContainText(
      "Message queued",
    );
    await expect(composer).toHaveValue(
      "A follow-up I started while that was queued.",
    );
    await expect(page.getByTestId("planner-transcript-prompt")).toHaveText(
      "A support triage system for customer requests.",
    );
    await expect(
      page.getByTestId("planner-transcript-assistant"),
    ).toContainText("clarifying the outcome");
    await expect(page.getByTestId("planner-greeting-generating")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("planner-queued-inputs")).toHaveCount(0);
  });

  test("return resumes the same planner and plus creates a fresh planner tab", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
    const first = await activeSessionId(page);
    expect(first).toBeTruthy();

    await page
      .getByTestId("workflow-dashboard-keeper")
      .locator("button")
      .click();
    await expect(page.getByTestId("planning-conversation")).toHaveCount(0);
    await openDashboardMap(page);
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
    expect(await activeSessionId(page)).toBe(first);
    await expect(page.getByTestId("planner-transcript-assistant")).toHaveCount(
      1,
    );

    await page.getByTestId("session-tab-new").click();
    await expect.poll(() => activeSessionId(page)).not.toBe(first);
    const second = await activeSessionId(page);
    await expect(
      page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
    ).toHaveCount(2);
    await expect(
      page.getByTestId("planner-transcript-assistant"),
    ).toContainText("What kind of agent architecture do you want to build?");

    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-end-btn").click();
    await page.getByTestId("end-session-confirm-btn").click();
    expect(second).not.toBe(first);
    await expect.poll(() => activeSessionId(page)).toBe(first);
    await expect(
      page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
    ).toHaveCount(1);
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
  });

  test("an explicitly selected planner tab wins over project resume ordering", async ({
    page,
  }) => {
    await openDashboardMap(page);
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
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
    await expect(page.getByTestId("planning-conversation")).toHaveCount(0);

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("Planner A");
    await page
      .getByTestId("command-palette-list")
      .getByText("Planner A", { exact: true })
      .click();

    await expect(page.getByTestId("planning-conversation")).toBeVisible();
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
    await expect(page.getByTestId("planning-conversation")).toBeVisible();

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
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
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

    await expect(page.getByTestId("planning-conversation")).toBeVisible();
    await expect.poll(() => activeSessionId(page)).not.toBe(ended);
  });

  test("greeting retry failures stay local to the greeting", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockGreeting=failed&mockGreetingRetry=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);

    await page.getByTestId("planner-greeting-retry").click();
    await expect(
      page.getByTestId("planner-greeting-retry-error"),
    ).toContainText("temporarily unavailable");
    await expect(page.getByTestId("planner-greeting-failed")).toBeVisible();
    await expect(page.getByTestId("planner-composer-input")).toBeEnabled();
  });

  test("workspace and planner failures stay local, while unauthorized is whole-workspace", async ({
    page,
  }) => {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapWorkspace=error",
    );
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openDashboardMap(page);
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
    await expect(page.getByTestId("agent-map-load-error")).toBeVisible();
    await expect(page.getByTestId("planner-composer-input")).toBeEnabled();
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

  test("conversation stays primary and the explicit sheet restores focus on close", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockFixtures=deep&mockStudioProjects=present");
    await expect(page.getByTestId("rail-expand")).toBeVisible();
    await page.getByTestId("rail-expand").click();
    await openDashboardMap(page);

    await expect(page.getByTestId("planning-conversation")).toBeVisible();
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
    await expect(page.getByTestId("planning-conversation")).toBeVisible();
    await expect(page.locator(".right-pane")).toBeHidden();

    const composer = page.getByTestId("planner-composer-input");
    await composer.fill("Keep the Agent Map open while this turn starts.");
    await page.getByTestId("planner-composer-send").click();
    await page.getByTestId("right-expand").click();
    await expect(page.locator(".right-pane")).toBeVisible();

    await expect(page.getByTestId("planner-transcript-prompt")).toHaveText(
      "Keep the Agent Map open while this turn starts.",
    );
    await expect(page.locator(".right-pane")).toBeVisible();
  });
});
