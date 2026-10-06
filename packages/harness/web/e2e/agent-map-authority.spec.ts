import { expect, test, type Page } from "@playwright/test";

type Probe = {
  identity: "ready" | "missing-id" | "missing-project" | "older-protocol";
  states: number;
  workflows: number;
  activeSessionId: string | null;
  reloadProjects: () => Promise<void>;
  projects: Record<string, string>;
  preferenceReads: string[];
  holdStates: boolean;
  heldStates: Array<() => void>;
  completedStates: number;
};
type TestWindow = Window & {
  __authority: Probe;
  __HARNESS_TEST__: Record<string, unknown> & {
    publish: (message: unknown) => void;
  };
};

const legacyRequests = new WeakMap<Page, [number, number, number]>();

async function open(
  page: Page,
  identity: Probe["identity"] = "ready",
  project = "acme-app",
) {
  // Observe real browser requests before boot, including accidental reads that
  // would bypass a mock method or a deleted loader.
  const requests: [number, number, number] = [0, 0, 0];
  legacyRequests.set(page, requests);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!/^\/api\/workspaces\/[^/]+\/system-graph(?:\/|$)/.test(path)) return;
    requests[path.endsWith("/refresh") ? 1 : path.endsWith("/navigation") ? 2 : 0]++;
  });
  const setupErrors: string[] = [];
  const recordPageError = (error: Error) => setupErrors.push(error.message);
  page.on("pageerror", recordPageError);
  // Expose the catalog-only refresh and active pointer from this test's hook
  // instance, without adding a production test API or hydrating sessions.
  await page.route("**/src/lib/use-harness-state.ts", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (!body.includes("    refreshWorkspaceScopes,")) {
      setupErrors.push(
        "use-harness-state.ts: missing refreshWorkspaceScopes return field",
      );
      // Settle the request so the test can report the setup error after navigation.
      await route.fulfill({ response, body });
      return;
    }
    await route.fulfill({
      response,
      body: body.replace(
        "    refreshWorkspaceScopes,",
        "    refreshWorkspaceScopes: (window.__authority.activeSessionId = activeSessionId, window.__authority.reloadProjects = refreshWorkspaceScopes),",
      ),
    });
  });
  // Retained catalog reads and session actions remain independently observed.
  await page.route("**/src/lib/api.ts", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        `
if (typeof MockApi !== "function") {
  throw new Error("Authority fixture: api.ts no longer defines MockApi");
}
for (const method of ["getState", "getStudioCurrentWorkspace", "listWorkflows"]) {
  if (typeof MockApi.prototype[method] !== "function") {
    throw new Error("Authority fixture: missing MockApi." + method);
  }
}
const authority = window.__authority = {
  identity: ${JSON.stringify(identity)}, states: 0, workflows: 0,
  projects: {}, preferenceReads: [], holdStates: false, heldStates: [], completedStates: 0,
};
const stateRead = MockApi.prototype.getState;
MockApi.prototype.getState = async function() {
  authority.states++;
  const identity = authority.identity;
  const state = await stateRead.call(this);
  authority.projects = Object.fromEntries(state.studioProjects.map(p => [p.displayName, p.projectId]));
  if (identity === "missing-project") state.studioProjects = [];
  if (identity === "older-protocol") delete state.studioProjects;
  if (identity === "missing-id") {
    state.workspaceScopes = state.workspaceScopes.map(({ projectId, ...scope }) => scope);
  }
  if (authority.holdStates) await new Promise(resolve => authority.heldStates.push(resolve));
  authority.completedStates++;
  return state;
};
const preferenceRead = MockApi.prototype.getStudioCurrentWorkspace;
MockApi.prototype.getStudioCurrentWorkspace = function(projectId) {
  authority.preferenceReads.push(projectId);
  return preferenceRead.call(this, projectId);
};
const workflowsRead = MockApi.prototype.listWorkflows;
MockApi.prototype.listWorkflows = function() {
  authority.workflows++;
  return workflowsRead.call(this);
};
`,
    });
  });
  try {
    await page.goto(
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present",
    );
    expect(setupErrors, "Authority fixture setup failed").toEqual([]);
    await expect(page.getByTestId("session-context")).toBeVisible();
  } catch (error) {
    if (setupErrors.length) {
      throw new Error(
        `Authority fixture setup failed:\n${setupErrors.join("\n")}`,
      );
    }
    throw error;
  } finally {
    page.off("pageerror", recordPageError);
  }
  await page.getByTestId(`project-select-${project}`).click();
}

async function evidence(page: Page) {
  const result = await page.evaluate(() => {
    const win = window as TestWindow;
    return {
      session: win.__authority.activeSessionId,
      actions: [
        "createSessionCalls",
        "resumeSessionCalls",
        "bindWorkflowCalls",
        "injectInputCalls",
      ].map(
        (key) =>
          (win.__HARNESS_TEST__[key] as unknown[] | undefined)?.length ?? 0,
      ),
    };
  });
  return { ...result, legacy: [...legacyRequests.get(page)!] };
}

/*
 * The centre's project view is keyed by the server-issued project id
 * (design.md §1). There is no separate "identity unavailable" screen any more:
 * a root whose scope carries an id opens its map from that id whatever the
 * project catalog says, and a root with no id yet asks only for the catalog.
 * Either way a project click never creates, resumes, binds or prompts a
 * session, and never reads the retired system-graph routes.
 */
for (const identity of ["missing-id", "missing-project", "older-protocol"] as const) {
  test(`a project with ${identity} reads only the catalog and never touches a session`, async ({
    page,
  }) => {
    await open(page, identity);
    const before = await evidence(page);
    expect(before.legacy).toEqual([0, 0, 0]);
    expect(before.actions).toEqual([0, 0, 0, 0]);
    expect(before.session).toBe("sess-boot");
    await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
    if (identity === "missing-id") {
      // No id to key a map by: the click re-reads the catalog and the centre
      // stays where it was.
      await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => (window as TestWindow).__authority.states))
        .toBeGreaterThan(1);
      await page.evaluate(async () => {
        const probe = (window as TestWindow).__authority;
        probe.identity = "ready";
        await probe.reloadProjects();
      });
      await page.getByTestId("project-select-acme-app").click();
    }
    // The scope's own id is enough: the map opens from it.
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    expect(await evidence(page)).toEqual(before);
    await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
  });
}

test("opening another project's map never restores the active conversation's project over it", async ({
  page,
}) => {
  await open(page, "missing-project", "polsia");
  const before = await evidence(page);
  expect(before.session).toBe("sess-boot");
  const selectedId = await page.evaluate(
    () => (window as TestWindow).__authority.projects["polsia"],
  );
  await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
    "data-project-id",
    selectedId,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // No per-project preference is read to decide what the centre shows.
  expect(
    await page.evaluate(
      () => (window as TestWindow).__authority.preferenceReads,
    ),
  ).toEqual([]);
  await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
    "data-project-id",
    selectedId,
  );
  expect(await evidence(page)).toEqual(before);
});

for (const identity of ["ready", "missing-project", "older-protocol"] as const) {
  test(`Cmd/Ctrl+1 on a project's map selects that project's first rail session with ${identity}`, async ({
    page,
  }) => {
    await open(page, identity, "polsia");
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    const before = await evidence(page);
    expect(before.session).toBe("sess-boot");
    await page.evaluate(() => {
      const win = window as TestWindow;
      win.__HARNESS_TEST__.publish({
        type: "session.status",
        session: {
          id: "sess-authority-polsia",
          agentSessionId: null,
          harness: "claude-code",
          cwd: "/Users/demo/polsia",
          boundWorkflowPath: "/Users/demo/polsia/scripts/tools/rollup",
          title: "Polsia session",
          status: "running",
          exitCode: null,
          ready: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          agentMapIdentity: {
            projectId: win.__authority.projects.polsia,
            userId: "user_mock",
            sessionId: "sess-authority-polsia",
          },
        },
      });
    });
    const firstRow = page
      .getByTestId("rail-project-polsia")
      .locator(".rail-session-row")
      .first();
    await expect(firstRow).toHaveAttribute(
      "data-testid",
      "rail-session-sess-authority-polsia",
    );
    await page.keyboard.press("ControlOrMeta+1");
    await expect
      .poll(async () => (await evidence(page)).session)
      .toBe("sess-authority-polsia");
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-authority-polsia",
    );
    await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
    // Bound to rollup, and still nothing beside the session (flow 4.4.1).
    await expect(page.getByTestId("agent-view")).toBeVisible();
    await expect(page.locator(".right-pane")).toHaveCount(0);
    const after = await evidence(page);
    expect(after.actions).toEqual(before.actions);
    expect(after.legacy).toEqual([0, 0, 0]);
  });
}

test("an established map keeps its exact identity after catalog loss", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const projectId = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  const before = await evidence(page);
  await page.evaluate(async () => {
    const probe = (window as TestWindow).__authority;
    probe.identity = "missing-project";
    await probe.reloadProjects();
  });
  await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
    "data-project-id",
    projectId!,
  );
  await page.evaluate(async () => {
    const probe = (window as TestWindow).__authority;
    probe.identity = "ready";
    await probe.reloadProjects();
  });
  await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
    "data-project-id",
    projectId!,
  );
  expect(await evidence(page)).toEqual(before);
});

test("an older failed catalog response cannot replace a newer successful retry", async ({
  page,
}) => {
  await open(page, "missing-id");
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  await page.evaluate(() => {
    const probe = (window as TestWindow).__authority;
    probe.holdStates = true;
    void probe.reloadProjects();
  });
  const held = () =>
    page.evaluate(() => (window as TestWindow).__authority.heldStates.length);
  await expect.poll(held).toBeGreaterThan(0);
  const older = await held();
  await page.evaluate(() => {
    const probe = (window as TestWindow).__authority;
    probe.identity = "ready";
    void probe.reloadProjects();
  });
  await expect.poll(held).toBeGreaterThan(older);
  const newer = await held();
  await page.evaluate(
    ({ older, newer }) => {
      const probe = (window as TestWindow).__authority;
      probe.holdStates = false;
      for (let i = older; i < newer; i++) probe.heldStates[i]!();
    },
    { older, newer },
  );
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const before = await evidence(page);
  const completed = await page.evaluate((older) => {
    const probe = (window as TestWindow).__authority;
    for (let i = 0; i < older; i++) probe.heldStates[i]!();
    return probe.completedStates;
  }, older);
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__authority.completedStates),
    )
    .toBe(completed + older);
  // The late id-less answer did not take the project's identity back away.
  await page.getByTestId("project-select-polsia").click();
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});

test("durable map ignores old graph events, re-reads only itself on a map change, and opens the exact agent's card without touching sessions", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const before = await evidence(page);
  const counts = () =>
    page.evaluate(() => {
      const probe = (window as TestWindow).__authority;
      return [probe.states, probe.workflows];
    });
  const mapReads = () =>
    page.evaluate(
      () =>
        ((window as TestWindow).__HARNESS_TEST__.projectMapCalls as unknown[] | undefined)
          ?.length ?? 0,
    );
  const countsBefore = await counts();
  const readsBefore = await mapReads();
  await page.evaluate(() => {
    const win = window as TestWindow;
    for (const workspaceKey of [
      "workspace-mock-1",
      "workspace-mock-2",
      "unknown",
    ]) {
      win.__HARNESS_TEST__.publish({
        type: "system-graph.changed",
        workspaceKey,
        revision: 100,
        state: "ready",
      });
    }
  });
  // The retired message is dropped: no map read, no catalog or agent re-read.
  // A fixed wait is the only way to observe that nothing happens, and it
  // outlasts the 250 ms map debounce.
  await page.waitForTimeout(600);
  expect(await counts()).toEqual(countsBefore);
  expect(await mapReads()).toBe(readsBefore);

  // The current message re-reads the map and nothing else.
  const projectId = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  await page.evaluate((id) => {
    (window as TestWindow).__HARNESS_TEST__.publish({
      type: "project-map.changed",
      projectId: id,
    });
  }, projectId);
  await expect.poll(mapReads).toBe(readsBefore + 1);
  expect(await counts()).toEqual(countsBefore);

  await page.getByTestId("agent-map-node-screening").click();
  expect(await evidence(page)).toEqual(before);
  await page.getByTestId("agent-map-node-leasing").click();
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-state", "node");
  await expect(page.getByTestId("map-card-open-agent")).toBeVisible();
  await expect(page.getByTestId("agent-map-frame")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});
