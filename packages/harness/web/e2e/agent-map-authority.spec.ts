import { expect, test, type Page } from "@playwright/test";

type Probe = {
  identity: "ready" | "missing-id" | "missing-project";
  reads: number;
  refreshes: number;
  navigation: number;
  invalidations: number;
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

async function open(
  page: Page,
  identity: Probe["identity"] = "ready",
  project = "acme-app",
) {
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
  // Instrument entry to each legacy API method, before cache hits/delays. A
  // successful map alone cannot prove an obsolete background read didn't run.
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
for (const method of ["getSystemGraph", "getSystemGraphNavigation", "getState", "getStudioCurrentWorkspace", "listWorkflows"]) {
  if (typeof MockApi.prototype[method] !== "function") {
    throw new Error("Authority fixture: missing MockApi." + method);
  }
}
const authority = window.__authority = {
  identity: ${JSON.stringify(identity)}, reads: 0, refreshes: 0,
  navigation: 0, invalidations: 0, states: 0, workflows: 0,
  projects: {}, preferenceReads: [], holdStates: false, heldStates: [], completedStates: 0,
};
const graphRead = MockApi.prototype.getSystemGraph;
MockApi.prototype.getSystemGraph = function(key, options) {
  authority[options?.refresh ? "refreshes" : "reads"]++;
  return graphRead.call(this, key, options);
};
const navigationRead = MockApi.prototype.getSystemGraphNavigation;
MockApi.prototype.getSystemGraphNavigation = function(...args) {
  authority.navigation++;
  return navigationRead.apply(this, args);
};
const stateRead = MockApi.prototype.getState;
MockApi.prototype.getState = async function() {
  authority.states++;
  const identity = authority.identity;
  const state = await stateRead.call(this);
  authority.projects = Object.fromEntries(state.studioProjects.map(p => [p.displayName, p.projectId]));
  if (identity === "missing-project") state.studioProjects = [];
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
      "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
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
  return page.evaluate(() => {
    const win = window as TestWindow;
    return {
      legacy: [
        win.__authority.reads,
        win.__authority.refreshes,
        win.__authority.navigation,
      ],
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
}

for (const identity of ["missing-id", "missing-project"] as const) {
  test(`current project with ${identity} offers identity recovery without legacy fallback or session actions`, async ({
    page,
  }) => {
    await open(page, identity);
    await expect(
      page.getByTestId("agent-map-identity-unavailable"),
    ).toBeVisible();
    await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
    const before = await evidence(page);
    expect(before.legacy).toEqual([0, 0, 0]);
    expect(before.actions).toEqual([0, 0, 0, 0]);
    expect(before.session).toBe("sess-boot");

    // The scope still cannot resolve: a retry reads the project catalog only.
    await page.getByTestId("agent-map-reload-projects").click();
    await expect(
      page.getByTestId("agent-map-identity-unavailable"),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as TestWindow).__authority.identity = "ready";
    });
    await page.getByTestId("agent-map-reload-projects").click();
    await expect(page.getByTestId("agent-map-live")).toBeVisible();
    expect(await evidence(page)).toEqual(before);
    await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
  });
}

test("recovering another project cannot restore the active conversation's project over it", async ({
  page,
}) => {
  await open(page, "missing-project", "polsia");
  await expect(
    page.getByTestId("agent-map-identity-unavailable"),
  ).toBeVisible();
  const before = await evidence(page);
  expect(before.session).toBe("sess-boot");
  const selectedId = await page.evaluate(() => {
    const probe = (window as TestWindow).__authority;
    probe.identity = "ready";
    return probe.projects["polsia"];
  });
  await page.getByTestId("agent-map-reload-projects").click();
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

for (const identity of ["missing-id", "missing-project"] as const) {
  test(`keyboard session selection matches the visible unresolved project's tabs with ${identity}`, async ({
    page,
  }) => {
    await open(page, identity, "polsia");
    await expect(
      page.getByTestId("agent-map-identity-unavailable"),
    ).toBeVisible();
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
          createdAt: "2026-08-01T10:00:00.000Z",
          lastActiveAt: "2026-08-01T10:00:00.000Z",
          agentMapIdentity: {
            projectId: win.__authority.projects.polsia,
            userId: "user_mock",
            sessionId: "sess-authority-polsia",
          },
        },
      });
    });
    const firstTab = page.locator('[data-testid^="session-tab-main-"]').first();
    await expect(firstTab).toBeVisible();
    const sessionId = (await firstTab.getAttribute("data-testid"))!.replace(
      "session-tab-main-",
      "",
    );
    expect(sessionId).not.toBe("sess-boot");
    await page.keyboard.press("ControlOrMeta+1");
    await expect
      .poll(async () => (await evidence(page)).session)
      .toBe(sessionId);
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      sessionId,
    );
    await expect(
      page.getByTestId("agent-map-identity-unavailable"),
    ).toHaveCount(0);
    // A session with no bundled Canvas document uses the normal collapsed
    // pane. Its controls must still open that exact session's Canvas/Steps.
    const expand = page.getByRole("button", {
      name: "Expand canvas panel",
      exact: true,
    });
    if (await expand.isVisible()) await expand.click();
    await expect(page.getByTestId("right-panel-board")).toBeVisible();
    await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
    const after = await evidence(page);
    expect(after.actions).toEqual(before.actions);
    expect(after.legacy).toEqual([0, 0, 0]);
  });
}

test("an established map keeps its exact identity and catalog retry after catalog loss", async ({
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
  await expect(
    page.getByTestId("agent-map-identity-unavailable"),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as TestWindow).__authority.identity = "ready";
  });
  await page.getByTestId("agent-map-reload-projects").click();
  await expect(page.getByTestId("agent-map-live")).toHaveAttribute(
    "data-project-id",
    projectId!,
  );
  expect(await evidence(page)).toEqual(before);
});

test("an older failed catalog response cannot replace a newer successful retry", async ({
  page,
}) => {
  await open(page, "missing-project");
  await page.evaluate(() => {
    (window as TestWindow).__authority.holdStates = true;
  });
  await page.getByTestId("agent-map-reload-projects").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__authority.heldStates.length),
    )
    .toBe(1);
  await page.evaluate(() => {
    (window as TestWindow).__authority.identity = "ready";
  });
  await page.getByTestId("agent-map-reload-projects").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__authority.heldStates.length),
    )
    .toBe(2);
  await page.evaluate(() => {
    (window as TestWindow).__authority.heldStates[1]!();
  });
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const before = await evidence(page);
  const completed = await page.evaluate(() => {
    const probe = (window as TestWindow).__authority;
    probe.heldStates[0]!();
    return probe.completedStates;
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__authority.completedStates),
    )
    .toBe(completed + 1);
  await expect(page.getByTestId("agent-map-identity-unavailable")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});

test("durable map ignores old graph events and keeps exact navigation and sessions", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const before = await evidence(page);
  const eventsBefore = await page.evaluate(async () => {
    const win = window as TestWindow;
    const { systemGraphLoader } =
      await import("/src/lib/system-graph-loader.ts");
    const invalidate = systemGraphLoader.invalidate.bind(systemGraphLoader);
    systemGraphLoader.invalidate = (...args: unknown[]) => {
      win.__authority.invalidations++;
      return invalidate(...args);
    };
    const counts = [win.__authority.states, win.__authority.workflows];
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
    return counts;
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as TestWindow).__authority.invalidations),
    )
    .toBe(0);
  expect(
    await page.evaluate(() => {
      const probe = (window as TestWindow).__authority;
      return [probe.states, probe.workflows];
    }),
  ).toEqual(eventsBefore);

  const id = "node_00000000-0000-7000-8000-000000000101";
  await page.getByTestId(`agent-map-info-${id}`).click();
  expect(await evidence(page)).toEqual(before);
  await page.getByTestId(`agent-map-node-${id}`).click();
  await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
  await expect(page.getByTestId("right-panel-board")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  expect(await evidence(page)).toEqual(before);
});
