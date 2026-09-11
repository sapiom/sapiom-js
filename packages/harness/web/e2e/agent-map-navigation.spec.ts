import { expect, test, type Page } from "@playwright/test";
import type { HarnessApi } from "../src/lib/api";
import type { HarnessSession } from "../../src/shared/types";

const nodeId = (n = 101) =>
  `node_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const node = (page: Page, n = 101) =>
  page.getByTestId(`agent-map-node-${nodeId(n)}`);
const info = (page: Page, n = 101) =>
  page.getByTestId(`agent-map-info-${nodeId(n)}`);
type Probe = {
  targets: number;
  completed: number;
  writes: number;
  refreshes: number;
  hide: boolean;
  release: (() => void) | null;
};
type TestWindow = Window & {
  __navigation: Probe;
  __HARNESS_TEST__?: Record<string, unknown> & {
    publish: (message: unknown) => void;
  };
};

async function openMap(page: Page, project = "acme-app") {
  await expect(page.getByTestId("session-context")).toBeVisible();
  const rail = page.getByTestId("rail-expand");
  if (await rail.isVisible()) await rail.click();
  await page.getByTestId(`project-select-${project}`).click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
}
async function open(page: Page, query = "", project = "acme-app") {
  await page.goto(
    `/?seed=0&mockFixtures=${query.includes("flood") ? "flood" : "deep"}&mockStudioProjects=present&mockAgentMapGolden=1&${query}`,
  );
  await openMap(page, project);
}
async function evidence(page: Page) {
  const session = await page
    .getByTestId("session-context")
    .getAttribute("data-session-id");
  return page.evaluate((session) => {
    const calls = (window as TestWindow).__HARNESS_TEST__;
    return {
      session,
      actions: [
        "createSessionCalls",
        "resumeSessionCalls",
        "bindWorkflowCalls",
        "injectInputCalls",
      ].map((key) => (calls?.[key] as unknown[] | undefined)?.length ?? 0),
    };
  }, session);
}
async function probe(
  page: Page,
  options: {
    delay?: boolean;
    path?: string;
    error?: string;
    refresh?: boolean;
    delayRefresh?: boolean;
  } = {},
) {
  await page.evaluate(async (options) => {
    const modulePath = performance
      .getEntriesByType("resource")
      .find(
        (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
      )!.name;
    const { MockApi } = await import(modulePath);
    const prototype = MockApi.prototype as HarnessApi;
    const target = prototype.getAgentMapNodeImplementation;
    const put = prototype.putStudioCurrentWorkspace;
    const list = prototype.listWorkflows;
    const state: Probe = {
      targets: 0,
      completed: 0,
      writes: 0,
      refreshes: 0,
      hide: Boolean(options.refresh),
      release: null,
    };
    (window as TestWindow).__navigation = state;
    prototype.listWorkflows = async function () {
      const rows = await list.call(this);
      if (options.delayRefresh && !state.hide)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      state.refreshes++;
      return state.hide ? rows.filter((w) => w.path !== options.path) : rows;
    };
    prototype.getAgentMapNodeImplementation = async function (
      projectId,
      nodeId,
    ) {
      state.targets++;
      if (options.delay && state.targets === 1)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      try {
        if (options.error)
          throw Object.assign(new Error("private server detail"), {
            code: options.error,
          });
        state.hide = false;
        if (options.path) {
          const workflow = (await list.call(this)).find(
            (w) => w.path === options.path,
          )!;
          const binding = workflow.studioBindings!.find(
            (b) => b.projectId === projectId,
          )!;
          return {
            projectId,
            nodeId,
            agentId: binding.agentId,
            workflowPath: workflow.path,
          };
        }
        return await target.call(this, projectId, nodeId);
      } finally {
        state.completed++;
      }
    };
    prototype.putStudioCurrentWorkspace = function (...args) {
      state.writes++;
      return put.apply(this, args);
    };
  }, options);
}
const calls = (page: Page) =>
  page.evaluate(() => {
    const { targets, completed, writes, refreshes } = (window as TestWindow)
      .__navigation;
    return { targets, completed, writes, refreshes };
  });
async function publish(page: Page, message: unknown) {
  await page.evaluate(
    (message) => (window as TestWindow).__HARNESS_TEST__!.publish(message),
    message,
  );
}
async function updateSession(
  page: Page,
  id: string,
  patch: Partial<HarnessSession>,
) {
  await page.evaluate(
    async ({ id, patch }) => {
      const modulePath = performance
        .getEntriesByType("resource")
        .find(
          (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
        )!.name;
      const { MockApi } = await import(modulePath);
      const session = (await new MockApi().getState()).sessions.find(
        (session: HarnessSession) => session.id === id,
      );
      (window as TestWindow).__HARNESS_TEST__!.publish({
        type: "session.status",
        session: { ...session, ...patch },
      });
    },
    { id, patch },
  );
}
async function expectCanvas(page: Page, hasBoard = true) {
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  if (hasBoard) {
    await expect(
      page.locator('.canvas-frame-wrap[data-view="board"]'),
    ).toBeVisible();
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  } else await expect(page.getByTestId("canvas-empty-exited")).toBeVisible();
  await expect(page.getByTestId("right-tab-canvas")).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

for (const mode of [
  "Claude",
  "Codex",
  "archived Claude",
  "archived Codex",
  "no session",
]) {
  test(`opens the exact agent while preserving ${mode}`, async ({ page }) => {
    await open(
      page,
      mode.startsWith("archived")
        ? "mockRestoredSessions=1"
        : mode === "no session"
          ? "mockNoLiveSessions=1"
          : "",
    );
    let archivedSession: string | null = null;
    if (mode.startsWith("archived")) {
      await page.getByTestId("history-trigger").click();
      await page.getByTestId("past-sessions-trigger").hover();
      await page
        .getByTestId(
          `exited-session-${mode.endsWith("Codex") ? "sess-leasing-2" : "sess-leasing"}`,
        )
        .click();
      await expect(page.getByTestId("dead-session-pane")).toBeVisible();
      archivedSession = (await evidence(page)).session;
      await openMap(page);
    } else if (mode === "Codex") {
      await page.getByTestId("session-tab-main-sess-leasing-2").click();
      await updateSession(page, "sess-leasing-2", { boundWorkflowPath: null });
      await openMap(page);
    }
    await probe(page);
    const before = await evidence(page);
    if (archivedSession) before.session = archivedSession;
    if (mode === "Claude") await page.getByTestId("canvas-expand").click();
    await node(page).click();
    // This archived fixture has no saved Canvas document; keep its existing empty state.
    await expectCanvas(page, mode !== "archived Codex");
    await expect(
      page.locator('[data-agent-path="/Users/demo/acme-app/leasing"]'),
    ).toHaveClass(/is-focused/);
    expect(await evidence(page)).toEqual(before);
    if (mode.startsWith("archived"))
      await expect(page.getByTestId("dead-session-pane")).toBeVisible();
    expect((await calls(page)).writes).toBe(1);
    if (mode === "Claude") {
      await expect(
        page.locator('.canvas-frame-wrap[data-view="board"]'),
      ).toHaveClass(/is-expanded/);
      await page.getByTestId("canvas-expand-exit").click();
      await page.reload();
      await expectCanvas(page);
    }
    await openMap(page);
    expect(await evidence(page)).toEqual({
      ...before,
      session: archivedSession ? "" : before.session,
    });
    if (mode.startsWith("archived")) {
      await openMap(page, "polsia");
      await node(page).click();
      await expectCanvas(page);
      await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
      await openMap(page);
      await node(page).click();
      await expectCanvas(page, mode !== "archived Codex");
      expect(await evidence(page)).toEqual(before);
    }
  });
}

test("same-name agents use the exact ID and path; one refresh finds a newly discovered target", async ({
  page,
}) => {
  const path = "/Users/demo/polsia/services/etl/ingest";
  await open(page, "flood=1", "polsia");
  await probe(page, { path, refresh: true });
  await publish(page, { type: "workflows.changed" });
  await expect(page.locator(`[data-agent-path="${path}"]`)).toHaveCount(0);
  await node(page).click();
  await expectCanvas(page);
  await expect(page.locator(`[data-agent-path="${path}"]`)).toHaveClass(
    /is-focused/,
  );
  await expect(
    page.locator(
      '[data-agent-path="/Users/demo/polsia/backend/src/pipelines/ingest"]',
    ),
  ).not.toHaveClass(/is-focused/);
  expect((await calls(page)).refreshes).toBe(2);
});

test("Info and resource inspection preserve the map and return keyboard focus", async ({
  page,
}) => {
  await open(page);
  await probe(page);
  await info(page).click();
  await expect(page.getByTestId("agent-map-inspector")).toContainText(
    "Purpose",
  );
  await page.keyboard.press("Escape");
  await expect(info(page)).toBeFocused();
  await node(page, 103).press("Enter");
  await page.getByTestId("agent-map-inspector-close").click();
  await expect(node(page, 103)).toBeFocused();
  expect(await calls(page)).toMatchObject({ targets: 0, writes: 0 });
  await node(page, 106).click();
  await expect(page.getByTestId("agent-map-inspector")).toContainText(
    "No implementation is linked yet.",
  );
  await expect(page.getByTestId("agent-map-frame")).toBeVisible();
});

for (const [code, message] of [
  ["target_not_found", "isn't available locally"],
  ["target_ambiguous", "one implementation"],
  ["discovery_unavailable", "Try again"],
]) {
  test(`keeps ${code} failures in the inspector`, async ({ page }) => {
    await open(page);
    await probe(page, { error: code });
    await node(page).click();
    const inspector = page.getByTestId("agent-map-inspector");
    await expect(inspector).toContainText(message);
    await expect(inspector).not.toContainText("private server detail");
    expect((await calls(page)).writes).toBe(0);
  });
}

for (const action of [
  "Info",
  "another project",
  "another node",
  "auth change",
  "map change",
  "collapse",
  "refresh then Info",
]) {
  test(`a delayed reply cannot navigate after ${action}`, async ({ page }) => {
    await open(page, "", "polsia");
    const refreshing = action === "refresh then Info";
    const path = "/Users/demo/polsia/backend/src/agents/ads";
    await probe(
      page,
      refreshing
        ? { path, refresh: true, delayRefresh: true }
        : { delay: true },
    );
    if (refreshing) {
      await publish(page, { type: "workflows.changed" });
      await expect(page.locator(`[data-agent-path="${path}"]`)).toHaveCount(0);
    }
    await node(page).click();
    await expect(node(page)).toHaveAttribute("aria-busy", "true");
    if (refreshing)
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as TestWindow).__navigation.release !== null,
          ),
        )
        .toBe(true);
    if (action === "Info" || refreshing) await info(page).click();
    if (action === "another project") await openMap(page, "acme-app");
    if (action === "another node") {
      await node(page, 102).click();
      await expectCanvas(page);
    }
    if (action === "auth change")
      await publish(page, {
        type: "auth.changed",
        authenticated: false,
        organizationName: "Another account",
      });
    if (action === "collapse") await page.getByTestId("right-collapse").click();
    if (action === "map change")
      await publish(page, {
        type: "agent-map.proposal.changed",
        delta: {
          schemaVersion: 1,
          projectId: await page
            .getByTestId("agent-map-live")
            .getAttribute("data-project-id"),
          proposalId: "proposal_00000000-0000-7000-8000-000000000101",
          fromVersion: 1,
          version: 2,
          operationIds: ["operation_00000000-0000-7000-8000-000000009999"],
          operations: [
            {
              kind: "update-node",
              nodeId: nodeId(),
              changes: { purpose: "Updated plan" },
            },
          ],
          actor: { userId: "user_mock", sessionId: "planner_mock" },
          acceptedAt: new Date().toISOString(),
        },
      });
    const writes = (await calls(page)).writes;
    await page.evaluate(() => (window as TestWindow).__navigation.release!());
    await expect
      .poll(async () => (await calls(page)).completed)
      .toBe(action === "another node" ? 2 : 1);
    if (refreshing)
      await expect.poll(async () => (await calls(page)).refreshes).toBe(2);
    expect((await calls(page)).writes).toBe(writes);
    if (action === "collapse")
      await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);
    else if (action !== "another node")
      await expect(page.getByTestId("agent-map-frame")).toBeVisible();
  });
}

test("mobile keyboard activation opens Canvas and closes the rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "mockNoLiveSessions=1");
  const before = await evidence(page);
  await node(page).press("Space");
  await expectCanvas(page);
  await expect(page.locator(".rail-workflows")).toHaveCount(0);
  expect(await evidence(page)).toEqual(before);
});

test("a live session without a project ID keeps its conversation on rail selection", async ({
  page,
}) => {
  await open(page);
  const before = await evidence(page);
  await updateSession(page, "sess-boot", { agentMapIdentity: undefined });
  await page.getByTestId("workflow-leasing").click();
  await expectCanvas(page);
  expect(await evidence(page)).toEqual(before);
});

for (const boundWorkflowPath of ["/Users/demo/acme-app/leasing", null]) {
  test(`ending a session retains its own Canvas with binding ${boundWorkflowPath}`, async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.getByTestId("session-context")).toBeVisible();
    await updateSession(page, "sess-boot", { boundWorkflowPath });
    await page.getByTestId("session-tab-main-sess-boot").click();
    await expectCanvas(page);
    const source = await page.locator(".canvas-iframe").getAttribute("src");
    await updateSession(page, "sess-boot", {
      boundWorkflowPath,
      status: "exited",
    });
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
    await expectCanvas(page);
    await expect(page.locator(".canvas-iframe")).toHaveAttribute(
      "src",
      source!,
    );
  });
}

test("deployment refresh preserves a pending node navigation", async ({ page }) => {
  await open(page);
  await probe(page, { delay: true });
  const before = await evidence(page);
  await node(page).click();
  await expect(node(page)).toHaveAttribute("aria-busy", "true");
  await publish(page, { type: "workflows.changed" });
  await expect.poll(async () => (await calls(page)).refreshes).toBe(1);
  await page.evaluate(() => (window as TestWindow).__navigation.release!());
  await expectCanvas(page);
  expect(await evidence(page)).toEqual(before);
});
