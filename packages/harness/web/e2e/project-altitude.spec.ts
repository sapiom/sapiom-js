/**
 * SAP-2980 — a project is somewhere you WORK, and the canvas is one surface at
 * two altitudes.
 *
 * These are the criteria that cannot be proven by a unit test, because each one
 * is a claim about what is (and is not) on screen after a click. The pure rules
 * behind them are pinned in `lib/session-scope.test.ts` and
 * `lib/canvas-altitude.test.ts`; a unit test on a pure function cannot show
 * that `App.tsx` calls it, and the failure each rule prevents was visual.
 *
 * Every assertion below was mutation-tested: the handler it depends on was
 * stubbed to a no-op and the test confirmed to fail. A count-only assertion
 * passes when nothing happened, which is how "429 specs green, five defects in
 * a minute of real use" happens.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const activeSessionId = (page: Page): Promise<string | null> =>
  page.getByTestId("session-context").getAttribute("data-session-id");

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("E3.1/E3.6 — the project's map fills the RIGHT pane; the conversation keeps the centre", async ({
  page,
}) => {
  await expect(page.locator(".harness-terminal")).toBeVisible();
  const before = await activeSessionId(page);

  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

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
    page.getByTestId("workspace-graph-view").boundingBox(),
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

test("E3.3 — the tab strip is the PROJECT's sessions, including the ones bound to DIFFERENT agents", async ({
  page,
}) => {
  /* The reason `liveSessionsForProject` exists, in the one fixture shape that
     can tell the two rules apart. Since SAP-2927 every session boots at the
     project root, so a real project's sessions are mostly BOUND to its agents —
     and the agent rule (bound-to-this-path, or unbound-in-this-folder) claims
     none of them for a project subject. Under it, this project's strip is
     EMPTY while both of its conversations are running.

     Measured on the real 76-agent install: the very first session a project is
     given is auto-bound to one of its agents, so the empty strip is not an
     edge case — it is the default. */
  await page.goto("/?seed=0&mockFixtures=deep&mockNoLiveSessions=1");
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();

  await page.evaluate(() => {
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
        id: "sess-polsia-mailer",
        boundWorkflowPath:
          "/Users/demo/polsia/packages/harness/web/src/components/mailer",
        title: "mailer",
        createdAt: "2026-08-01T10:00:00.000Z",
        lastActiveAt: "2026-08-01T10:00:00.000Z",
      },
    });
    publish?.({
      type: "session.status",
      session: {
        ...base,
        id: "sess-polsia-rollup",
        boundWorkflowPath: "/Users/demo/polsia/scripts/tools/rollup",
        title: "rollup",
        createdAt: "2026-08-01T11:00:00.000Z",
        lastActiveAt: "2026-08-01T11:00:00.000Z",
      },
    });
  });

  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

  // Both, in tab order (oldest first — the order Cmd/Ctrl+1..9 selects).
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(
    page.getByTestId("session-tab-sess-polsia-mailer"),
  ).toBeVisible();
  await expect(
    page.getByTestId("session-tab-sess-polsia-rollup"),
  ).toBeVisible();

  // And they stay put when the selection drops to one agent's board: the tabs
  // are the PROJECT's, so a sibling selection cannot re-key them (E3.4).
  await page
    .getByTestId("system-graph-node-local:scripts/tools/rollup")
    .click();
  await expect(page.getByTestId("workflow-rollup")).toHaveClass(/is-focused/);
  await expect(tabs).toHaveCount(2);
  await expect(
    page.getByTestId("session-tab-sess-polsia-mailer"),
  ).toBeVisible();
});

test("E3.4 — selecting a sibling agent moves the right pane and NOTHING else", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
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
  await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
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

test("a project selected while ANOTHER project's agent was focused shows the CHAT, not that agent's absence", async ({
  page,
}) => {
  /* Measured on a real 76-agent install, not imagined. Selecting a project
     while some other project's agent was still focused rendered "No running
     session for <that agent>" in the centre, beside the project's own map —
     the conversation the map is meant to sit beside, hidden by a row nobody
     had selected. The rail already stopped highlighting that agent, so the
     centre and the rail disagreed about what was selected. */
  await page.getByTestId("workflow-rfq").locator(".workspace-row-main").click();
  await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-focused/);
  await expect(page.getByTestId("open-agent-empty")).toContainText(
    "No running session for rfq",
  );

  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.getByTestId("open-agent-empty")).toHaveCount(0);
  await expect(page.locator(".harness-terminal")).toBeVisible();
  // One selection: the project, and no agent alongside it — in the rail, and
  // in the verbs. The lifecycle cluster acts on an AGENT, so at map altitude it
  // is ABSENT rather than still aimed at whatever was selected before:
  // "talking about the project, deploying rfq" is SAP-2931's trap restated one
  // altitude up.
  await expect(page.locator(".workflow-item.is-focused")).toHaveCount(0);
  await expect(page.getByTestId("session-steps")).toHaveCount(0);
  await expect(page.getByTestId("project-row-acme-app")).toHaveClass(
    /is-selected/,
  );
});

test("E3.2 — a project whose ROOT is an agent says it is starting a session, not that the agent has none", async ({
  page,
}) => {
  /* The one shape where the map-altitude guard on the agent empty-state is the
     only thing standing between the user and a wrong sentence: `rfq-agent` is
     both a project and an agent, so selecting its map makes the selection a
     path that IS a registry agent. Ungoverned, the centre answers for the AGENT
     — "No running session for rfq" — while the pane beside it is drawing the
     PROJECT, and the session that will serve them both is already being
     created. Measured with the guard removed: `open-agent-empty` is what
     renders. */
  await page.goto("/?seed=0&mockNoLiveSessions=1");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("project-map-rfq-agent").click();
  await expect(page.getByTestId("project-session-starting")).toContainText(
    "Starting a session in rfq-agent",
  );
  await expect(page.getByTestId("open-agent-empty")).toHaveCount(0);

  // ...and it lands, in the project's own root.
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /^sess-mock-/,
  );
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
});

test("E3.5 — crossing to another project DOES hand the conversation over", async ({
  page,
}) => {
  // The rule `sessionForFocus` already encoded, reused verbatim for a project
  // subject rather than re-written beside it. A session rooted in acme-app
  // cannot see an agent in onboarding-flow: its cwd, its CLAUDE.md and its
  // skills all belong somewhere else.
  await page.getByTestId("project-select-acme-app").click();
  const inAcme = await activeSessionId(page);
  expect(inAcme).toBeTruthy();

  // `rfq-agent`'s row IS its root agent, so its map lives on the row's own
  // map control — the same `handleSelectWorkspace` door the label uses.
  await page.getByTestId("project-map-rfq-agent").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.locator(".workspace-graph-title")).toHaveText("rfq-agent");
  await expect(page.getByTestId("session-context")).not.toHaveAttribute(
    "data-session-id",
    inAcme!,
  );
});

test("E3.7/E3.8 — drilling from a map node cuts down and only the project name returns to the map", async ({
  page,
}) => {
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  // Map altitude: the PROJECT is selected and no agent is.
  await expect(page.getByTestId("project-row-acme-app")).toHaveClass(
    /is-selected/,
  );
  await expect(page.locator(".workflow-item.is-focused")).toHaveCount(0);
  await expect(page.getByTestId("canvas-altitude-up")).toHaveCount(0);

  await page.getByTestId("system-graph-node-leasing").click();

  // Board altitude: the AGENT is selected and the project row has let go.
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  await expect(page.getByTestId("project-row-acme-app")).not.toHaveClass(
    /is-selected/,
  );
  await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);

  await expect(page.getByTestId("canvas-altitude-up")).toHaveCount(0);
  await page.getByTestId("project-select-acme-app").click();

  // ...and back, with the rail agreeing again.
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.getByTestId("project-row-acme-app")).toHaveClass(
    /is-selected/,
  );
  await expect(page.locator(".workflow-item.is-focused")).toHaveCount(0);
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
  await page.getByTestId("system-graph-node-leasing").click();
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

test("Cmd/Ctrl+1..9 follows an exact ordinary session-tab activation", async ({
  page,
}) => {
  /* The key handler closes over its inputs, so it needs every input the strip
     has — the active session included. Clicking a tab now opens that exact
     session's ordinary subject; with `activeSessionId` missing from the
     effect's deps the listener kept the previous active session and resolved a
     different list, healing only on the next session event.

     Overlapping roots is what makes those lists actually differ: `~/polsia` and
     `~/polsia/services/workers` are both open, so the outer project's strip
     lists the nested project's sessions (it genuinely contains them) while the
     nested one lists only its own. */
  await page.goto("/?seed=0&mockFixtures=deep&mockNoLiveSessions=1");
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
  await page.evaluate(() => {
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
      status: "running" as const,
      ready: true,
      boundWorkflowPath: null,
    };
    publish?.({
      type: "session.status",
      session: {
        ...base,
        id: "sess-outer",
        cwd: "/Users/demo/polsia",
        title: "polsia",
        createdAt: "2026-08-01T10:00:00.000Z",
        // Most recently worked in, so selecting the project lands here.
        lastActiveAt: "2026-08-01T12:00:00.000Z",
      },
    });
    publish?.({
      type: "session.status",
      session: {
        ...base,
        id: "sess-nested",
        cwd: "/Users/demo/polsia/services/workers",
        title: "workers",
        createdAt: "2026-08-01T11:00:00.000Z",
        lastActiveAt: "2026-08-01T11:00:00.000Z",
      },
    });
  });

  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-outer",
  );
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);

  // Click the nested project's tab. The exact session becomes active and its
  // ordinary conversation/canvas replaces the project map.
  await page.getByTestId("session-tab-sess-nested").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-nested",
  );
  await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();
  // The strip re-keyed to the nested project, which holds only this session...
  await expect(tabs).toHaveCount(1);
  // ...so tab 1 is this session, and Cmd+1 must not reach past it into the
  // outer project's list.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-nested",
  );
});

test("the tab + and every tab click open an ordinary project session", async ({
  page,
}) => {
  /* The map is selected only through the project label. Tabs are real session
     handles, so choosing an existing tab or creating a sibling leaves the map
     and opens that exact conversation/canvas. */
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

  await page.getByTestId("session-tab-sess-leasing-2").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-leasing-2",
  );
  await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();

  await page.getByTestId("session-tab-new").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /^sess-mock-/,
  );
  await expect(page.getByTestId("workspace-graph-view")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(page.getByTestId("project-row-acme-app")).not.toHaveClass(
    /is-selected/,
  );
});
