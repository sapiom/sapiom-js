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
  await expect(page.getByTestId("session-tab-sess-polsia-mailer")).toBeVisible();
  await expect(page.getByTestId("session-tab-sess-polsia-rollup")).toBeVisible();

  // And they stay put when the selection drops to one agent's board: the tabs
  // are the PROJECT's, so a sibling selection cannot re-key them (E3.4).
  await page.getByTestId("system-graph-node-local:scripts/tools/rollup").click();
  await expect(page.getByTestId("workflow-rollup")).toHaveClass(/is-focused/);
  await expect(tabs).toHaveCount(2);
  await expect(page.getByTestId("session-tab-sess-polsia-mailer")).toBeVisible();
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

test("E3.7/E3.8 — drilling from a map node cuts down and the way back cuts up, rail following both", async ({
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

  const up = page.getByTestId("canvas-altitude-up");
  await expect(up).toHaveAttribute("aria-label", "Back to the acme-app map");
  await up.click();

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
  // The map is what the Canvas tab shows at this altitude, so the tab set never
  // grows a fourth peer for it.
  await expect(page.getByTestId("right-tab-canvas")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("right-tab-code")).toHaveCount(0);
  await expect(page.locator(".right-pane-tab")).toHaveCount(2);

  // The held Steps intent is not destroyed by the trip up — it is restored on
  // the way back down.
  await page.getByTestId("system-graph-node-leasing").click();
  await expect(page.getByTestId("right-tab-steps")).toBeEnabled();
  await expect(page.getByTestId("right-tab-steps")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("the tab + and a tab click stay INSIDE the project — the map does not close under them", async ({
  page,
}) => {
  /* Measured, because it is one line of state away from being wrong: every
     session door used to clear the project selection unconditionally, so
     starting one of the project's own tabs closed the map it was started
     beside — the same mode switch, one click later. */
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

  await page.getByTestId("session-tab-sess-leasing-2").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-leasing-2",
  );
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();

  await page.getByTestId("session-tab-new").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /^sess-mock-/,
  );
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.getByTestId("project-row-acme-app")).toHaveClass(
    /is-selected/,
  );
});
