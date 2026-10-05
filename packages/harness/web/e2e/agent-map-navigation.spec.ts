import { expect, test, type Page } from "@playwright/test";
import type { HarnessApi } from "../src/lib/api";
import type { HarnessSession } from "../../src/shared/types";

const nodeId = (n = 101) =>
  `node_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const node = (page: Page, n = 101) =>
  page.getByTestId(`agent-map-node-${nodeId(n)}`);
/** The golden map's Research Database: a resource, which opens no panel. */
const RESOURCE = 103;
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
/**
 * What a map interaction must leave alone: the SELECTED session (the rail's
 * filled row — the project view's header names the project, not a session)
 * and every session-mutating call. A map click opens a panel; it never
 * creates, resumes, binds or prompts anything (flow-navigation.md 4.3.2).
 */
async function evidence(page: Page) {
  const session = await page
    .locator('.rail-session-row[data-selected="true"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        (row.getAttribute("data-testid") ?? "").replace("rail-session-", ""),
      ),
    );
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
/** The floating card names a resolved AGENT (it carries Open agent). */
const agentCard = (page: Page) => page.getByTestId("map-card-open-agent");
/** The card's name; its tooltip is the agent's path. */
const cardName = (page: Page) => page.getByTestId("map-card-name");
/** Single click on an agent node: the card names it in place, the map still
 *  there (flow-map-chat-overlay.md 4.2), naming the EXACT agent the node
 *  resolved to: its path is the name's tooltip. */
async function expectPanel(page: Page, path: string) {
  await expect(agentCard(page)).toBeVisible();
  await expect(cardName(page)).toHaveAttribute("data-tooltip", path);
  await expect(page.getByTestId("agent-map-frame")).toBeVisible();
}
/** Open agent on the card: the agent's own board in a modal over the map,
 *  which stays mounted underneath (4.2b, I9). */
async function expectAgentModal(page: Page) {
  await agentCard(page).click();
  await expect(page.getByTestId("agent-modal")).toBeVisible();
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(1);
  await expect(
    page
      .getByTestId("agent-modal")
      .locator('.canvas-frame-wrap[data-view="board"]'),
  ).toBeVisible();
}
/** The board's size. Width is design I1; height too, because in the board's
 *  one-cell grid a sibling in flow would take a row rather than a column. */
const boardSize = async (page: Page) => {
  const box = (await page.getByTestId("agent-map-viewport").boundingBox())!;
  return { width: Math.round(box.width), height: Math.round(box.height) };
};
const LEASING = "/Users/demo/acme-app/leasing";

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
    if (mode.startsWith("archived")) {
      await page.getByTestId("rail-history").click();
      await page
        .getByTestId(
          `exited-session-${mode.endsWith("Codex") ? "sess-leasing-2" : "sess-leasing"}`,
        )
        .click();
      await expect(page.getByTestId("dead-session-pane")).toBeVisible();
      await openMap(page);
    } else if (mode === "Codex") {
      await page.getByTestId("rail-session-select-sess-leasing-2").click();
      await updateSession(page, "sess-leasing-2", { boundWorkflowPath: null });
      await openMap(page);
    }
    await probe(page);
    const before = await evidence(page);
    await node(page).click();
    await expectPanel(page, LEASING);
    expect(await evidence(page)).toEqual(before);
    // Navigation is client state now: nothing is written to the server's
    // per-project selection preference.
    expect((await calls(page)).writes).toBe(0);
    await expectAgentModal(page);
    expect(await evidence(page)).toEqual(before);
    await page.getByTestId("agent-modal-close").click();
    await expect(page.getByTestId("agent-modal")).toHaveCount(0);
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    expect(await evidence(page)).toEqual(before);
    if (mode.startsWith("archived")) {
      // Another project's map is just as unable to move the session.
      await openMap(page, "polsia");
      await node(page).click();
      await expect(agentCard(page)).toBeVisible();
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
  await node(page).click();
  // The card names the exact path the node's id resolved to, not its
  // same-named neighbour at /Users/demo/polsia/backend/src/pipelines/ingest.
  await expectPanel(page, path);
  expect((await calls(page)).refreshes).toBe(2);
});

test("picking an agent node and a resource node leaves the board's size unchanged", async ({
  page,
}) => {
  await open(page);
  await probe(page);
  const atRest = await boardSize(page);
  await node(page).click();
  await expectPanel(page, LEASING);
  expect(await boardSize(page)).toEqual(atRest);
  // The floating card may lie over the resource; release the pick first.
  await page.keyboard.press("Escape");
  await expect(agentCard(page)).toHaveCount(0);
  await node(page, RESOURCE).click();
  await expect(node(page, RESOURCE)).toHaveAttribute("aria-pressed", "true");
  await expect(agentCard(page)).toHaveCount(0);
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-kind", "resource");
  expect(await boardSize(page)).toEqual(atRest);
  // A resource pick is a selection only: announced, and nothing resolved.
  await expect(page.locator(".agent-map-live [aria-live]")).toHaveText(
    "Selected Research Database",
  );
  expect(await calls(page)).toMatchObject({ targets: 1, writes: 0 });
});

test("picking a resource over a picked agent releases it, and Escape does not bring it back", async ({
  page,
}) => {
  await open(page);
  await probe(page);
  await node(page).click();
  await expectPanel(page, LEASING);
  // The card floats over the map and may lie over the resource; the pick
  // goes to the node itself either way.
  await node(page, RESOURCE).dispatchEvent("click");
  await expect(node(page, RESOURCE)).toHaveAttribute("aria-pressed", "true");
  await expect(agentCard(page)).toHaveCount(0);
  await page.getByTestId("agent-map-live").press("Escape");
  await expect(node(page, RESOURCE)).toHaveAttribute("aria-pressed", "false");
  // The last pick was the resource: clearing it returns the card to the
  // project, not to the agent picked before it.
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-state", "project");
  await expect(agentCard(page)).toHaveCount(0);
  await expect(node(page)).toHaveAttribute("aria-pressed", "false");
});

for (const [code, message] of [
  ["target_not_found", "isn't available locally"],
  ["target_ambiguous", "one implementation"],
  ["discovery_unavailable", "Try again"],
]) {
  test(`shows ${code} failures in the map header`, async ({ page }) => {
    await open(page);
    await probe(page, { error: code });
    const atRest = await boardSize(page);
    await node(page).click();
    const error = page.getByTestId("agent-map-open-error");
    await expect(error).toContainText(message);
    await expect(error).not.toContainText("private server detail");
    await expect(node(page)).toHaveAttribute("aria-pressed", "true");
    await expect(agentCard(page)).toHaveCount(0);
    expect(await boardSize(page)).toEqual(atRest);
    await page.keyboard.press("Escape");
    await expect(error).toHaveCount(0);
    expect((await calls(page)).writes).toBe(0);
  });
}

for (const action of [
  "a resource pick",
  "another project",
  "another node",
  "auth change",
  "map change",
  "leaving the map",
  "refresh then a resource pick",
]) {
  test(`a delayed reply cannot name an agent on the card after ${action}`, async ({
    page,
  }) => {
    await open(page, "", "polsia");
    const refreshing = action === "refresh then a resource pick";
    const path = "/Users/demo/polsia/backend/src/agents/ads";
    await probe(
      page,
      refreshing
        ? { path, refresh: true, delayRefresh: true }
        : { delay: true },
    );
    if (refreshing) await publish(page, { type: "workflows.changed" });
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
    if (action === "a resource pick" || refreshing)
      await node(page, RESOURCE).click();
    if (action === "another project") await openMap(page, "acme-app");
    if (action === "another node") {
      await node(page, 102).click();
      await expect(agentCard(page)).toBeVisible();
    }
    if (action === "auth change")
      await publish(page, {
        type: "auth.changed",
        authenticated: false,
        organizationName: "Another account",
      });
    if (action === "leaving the map")
      await page.getByTestId("rail-session-select-sess-boot").click();
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
    const panelPath = cardName(page);
    const panelBefore =
      (await agentCard(page).count()) > 0
        ? await panelPath.getAttribute("data-tooltip")
        : null;
    await page.evaluate(() => (window as TestWindow).__navigation.release!());
    await expect
      .poll(async () => (await calls(page)).completed)
      .toBe(action === "another node" ? 2 : 1);
    if (refreshing)
      await expect.poll(async () => (await calls(page)).refreshes).toBe(2);
    expect((await calls(page)).writes).toBe(0);
    if (action === "leaving the map") {
      await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
      await expect(page.getByTestId("agent-view")).toBeVisible();
    } else if (action === "another node") {
      // The newer node's card stands; the stale reply did not replace it.
      await expect(cardName(page)).toHaveAttribute(
        "data-tooltip",
        panelBefore!,
      );
    } else {
      await expect(page.getByTestId("agent-map-frame")).toBeVisible();
      await expect(agentCard(page)).toHaveCount(0);
    }
  });
}

test("mobile keyboard activation names the agent on the card, then opens its modal, with the rail closed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "mockNoLiveSessions=1");
  const before = await evidence(page);
  await node(page).press("Space");
  await expect(agentCard(page)).toBeVisible();
  await expect(page.locator(".rail-workflows")).toHaveCount(0);
  await expectAgentModal(page);
  expect(await evidence(page)).toEqual(before);
});

test("deployment refresh preserves a pending node resolution", async ({ page }) => {
  await open(page);
  await probe(page, { delay: true });
  const before = await evidence(page);
  await node(page).click();
  await expect(node(page)).toHaveAttribute("aria-busy", "true");
  await publish(page, { type: "workflows.changed" });
  await expect.poll(async () => (await calls(page)).refreshes).toBe(1);
  await page.evaluate(() => (window as TestWindow).__navigation.release!());
  await expectPanel(page, LEASING);
  expect(await evidence(page)).toEqual(before);
});
