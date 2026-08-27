/**
 * SAP-2931 — the canvas, the lifecycle verbs and the run evidence follow the
 * rail SELECTION.
 *
 * `session-scope.test.ts` pins every decision as a pure function. What a unit
 * test cannot see is whether `App.tsx` calls them, and that is exactly where
 * this went wrong before: in the reference prototype the verb HANDLERS were
 * rewired to the selection while their enabled/disabled state stayed derived
 * from the bound agent, so selecting an undeployed agent left Prod and Run live
 * against a deployed one — talking about B, looking at F, deploying B. It was
 * reported met. So the gating claims below are made in a browser, on a real
 * undeployed agent, after a real selection change, and they assert `disabled`,
 * `aria-label` AND `data-tooltip` — a disabled control without its reason is
 * mute.
 *
 * Runs against `?mockFixtures=deep`, the only fixture with several agents
 * inside ONE project (so a same-project selection is expressible at all) and a
 * second root that is itself an agent (so a cross-project one is too):
 *
 *   /Users/demo/polsia                      project root
 *     backend/src/agents/ads                undeployed
 *     backend/src/agents/outreach           undeployed
 *     packages/harness/web/src/components/mailer    DEPLOYED (ready build)
 *     packages/harness/web/src/components/sender    undeployed
 *     services/gateway                      undeployed, no session ever
 *   /Users/demo/dashboard-keeper            a root that IS an agent
 *
 * No fixture session is rooted in polsia, which is deliberate: each test that
 * needs one starts it through the UI, so "the session did not move" is a claim
 * about a session this test watched come into existence.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Select a rail row by the agent's display name. Only agents that appear ONCE
 *  in this fixture are used — `services/workers` is opened as its own project
 *  as well as nested, so its agents have two rows each. */
const select = async (page: Page, name: string): Promise<void> => {
  await page.getByTestId(`workflow-${name}`).locator(".workflow-item-trigger").click();
  await expect(page.getByTestId(`workflow-${name}`)).toHaveClass(/is-focused/);
};

/** The harness session id the workbench is showing, or null. */
const activeSessionId = (page: Page): Promise<string | null> =>
  page.getByTestId("session-context").getAttribute("data-session-id");

/**
 * The right pane, open and on the Steps tab.
 *
 * Two reasons this is explicit. The pane auto-collapses for a board with
 * nothing in it, and in mock mode only the seeded boot session ships a
 * session-keyed document — so a session started here has an empty board and
 * folds the pane. And the pane names its subject only on the Steps surface
 * (`WorkflowActionsHeader` renders the name + count there); the Canvas surface
 * is a pure board, so its subject is read off the document instead.
 */
async function openSteps(page: Page): Promise<void> {
  const expand = page.getByTestId("right-expand");
  if ((await expand.count()) > 0) await expand.click();
  await page.getByTestId("right-tab-steps").click();
}

/** The agent the pane says it is about (Steps surface). */
const paneSubject = (page: Page) =>
  page.getByTestId("right-panel-canvas").locator(".workflow-actions-name");

/**
 * The document mounted in the board frame.
 *
 * A workflow-keyed board arrives as JSON and renders through `srcdoc` (the
 * route is behind the token middleware, so it cannot be an iframe `src`), and
 * the fixture stamps the agent's name into its `<title>`. So this attribute is
 * a direct answer to "whose board is on screen" — and its mere presence proves
 * the workflow-keyed route served it, which only happens when the subject and
 * the session's binding differ.
 */
const boardFrame = (page: Page) => page.locator(".canvas-iframe");

/**
 * Select `name` and start a session for it — the create+bind path, which roots
 * the session at the agent's PROJECT ROOT (SAP-2927). Resolves the new
 * session's id, so a later assertion can name the session it is watching.
 */
async function startSessionOn(page: Page, name: string): Promise<string> {
  await select(page, name);
  await page.getByTestId("open-agent-start-session").click();
  await expect(page.getByTestId("session-steps")).toBeVisible();
  const id = await activeSessionId(page);
  expect(id).toBeTruthy();
  return id!;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
});

test.describe("the board follows the selection; the session does not", () => {
  test("a sibling selection changes the board and leaves the active session untouched", async ({
    page,
  }) => {
    // THE case this ticket exists for: work on B while reading F's board.
    const sessionId = await startSessionOn(page, "ads");

    await select(page, "outreach");

    // The board is `outreach`'s, served by the workflow-keyed route — which is
    // reached ONLY when the subject and the session's binding differ, so this
    // attribute is itself the proof that they have.
    await expect(boardFrame(page)).toHaveAttribute("srcdoc", /outreach — mock workflow board/);
    // …while the session below it is untouched. Both halves matter: either one
    // alone is satisfied by the old coupled behaviour.
    expect(await activeSessionId(page)).toBe(sessionId);
    // The terminal is still there, with its own tab controls — keyed to the
    // selection, the strip emptied itself under a running session.
    await expect(page.getByTestId("agent-view")).toBeVisible();
    await expect(page.getByTestId("session-menu")).toBeVisible();
  });

  test("Steps and Canvas resolve the SAME subject", async ({ page }) => {
    // They are projections of one value; if they can disagree that is a bug by
    // contract, so the assertion is that one name serves both surfaces.
    await startSessionOn(page, "ads");
    await select(page, "outreach");
    // Canvas: the document on screen is outreach's.
    await expect(boardFrame(page)).toHaveAttribute("srcdoc", /outreach — mock workflow board/);
    // Steps: the same agent, read from the other projection.
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("outreach");
    await expect(page.getByTestId("canvas-steps-count")).toHaveText("2 steps · 1 exit");
  });

  test("a selection in another project MOVES the active session, and back again", async ({
    page,
  }) => {
    const polsia = await startSessionOn(page, "ads");
    // `dashboard-keeper` is its own root, so it is a different session scope: a
    // session rooted in polsia cannot see it, and leaving it active would mean
    // typing into one project while looking at another.
    const keeper = await startSessionOn(page, "dashboard-keeper");
    expect(keeper).not.toBe(polsia);

    // Back across the boundary: the session follows into polsia's scope, onto
    // that project's own session rather than a fresh one or none.
    await select(page, "outreach");
    expect(await activeSessionId(page)).toBe(polsia);

    // And a further move WITHIN polsia does not touch it again.
    await select(page, "mailer");
    expect(await activeSessionId(page)).toBe(polsia);

    await select(page, "dashboard-keeper");
    expect(await activeSessionId(page)).toBe(keeper);
  });
});

test.describe("verb gating", () => {
  test("selecting an undeployed sibling disables Prod and Run, with the reason in aria-label AND data-tooltip", async ({
    page,
  }) => {
    // The session is bound to `mailer`, which HAS a ready build — so every
    // assertion below fails if any gate is still reading the binding. This is
    // the prototype's exact mis-target, inverted into a test.
    await startSessionOn(page, "mailer");
    const prod = page.getByTestId("session-step-prod");
    await expect(prod).toBeEnabled();
    await expect(prod).toHaveAccessibleName("Open mailer in the Sapiom dashboard");
    await page.getByRole("button", { name: "Choose run target" }).click();
    await expect(page.getByTestId("session-step-run")).toBeEnabled();
    await page.keyboard.press("Escape");

    // Same project, so the session does NOT move — the verbs' subject changes
    // underneath a session that is still bound to the deployed agent.
    const sessionId = await activeSessionId(page);
    await select(page, "sender");
    await expect(boardFrame(page)).toHaveAttribute("srcdoc", /sender — mock workflow board/);
    // The session did not move, so the binding is still the DEPLOYED agent.
    expect(await activeSessionId(page)).toBe(sessionId);

    // Prod: disabled, and its reason readable from BOTH channels.
    await expect(prod).toBeDisabled();
    await expect(prod).toHaveAccessibleName("Prod: Not deployed yet");
    await expect(prod).toHaveAttribute("data-tooltip", "Prod: Not deployed yet");

    // Run (the cloud target): same.
    await page.getByRole("button", { name: "Choose run target" }).click();
    const cloud = page.getByTestId("session-step-run");
    await expect(cloud).toBeDisabled();
    await expect(cloud).toHaveAccessibleName("Cloud: Not deployed yet");
    await expect(cloud).toHaveAttribute("data-tooltip", "Not deployed yet");
    await page.keyboard.press("Escape");

    // Test and Deploy stay available: they are precisely what you CAN do to an
    // undeployed agent, and disabling them would be honest about nothing.
    await expect(page.getByTestId("session-step-local")).toBeEnabled();
    await expect(page.getByTestId("session-step-deploy")).toBeEnabled();

    // Selecting back re-enables them — the gate follows the selection in both
    // directions, rather than latching once.
    await select(page, "mailer");
    await expect(page.getByTestId("session-step-prod")).toBeEnabled();
  });

  test("the run sheet opens on the SELECTION, not on the bound agent", async ({ page }) => {
    // Gating is only half of it: the action target has to move too, and the
    // sheet's own title is the honest readout of which agent is about to run.
    await startSessionOn(page, "mailer");
    await select(page, "sender");
    await page.getByTestId("session-step-local").click();
    await expect(page.getByRole("dialog", { name: "Run sender" })).toBeVisible();
  });
});

test.describe("boards for agents with no session", () => {
  test("an agent that has never hosted a session shows a REAL board", async ({ page }) => {
    // No fixture session is rooted in polsia, so `gateway` has never had one:
    // before IA-01's workflow-keyed route this pane could only say "no running
    // session for gateway". The board is now served from `sapiom.json` alone.
    await select(page, "gateway");
    await expect(page.getByTestId("open-agent-empty")).toContainText(
      "No running session for gateway",
    );
    // A document is really mounted — asserted from INSIDE the frame, so a
    // rendered empty state or a stranded skeleton cannot pass for a board.
    await expect(
      page.frameLocator(".canvas-iframe").getByTestId("mock-workflow-board"),
    ).toBeVisible();
    await expect(boardFrame(page)).toHaveAttribute("srcdoc", /gateway — mock workflow board/);
    // …and it posted its graph, which is what the pane's reveal gate waits for:
    // the count is read from the posted graph, not from the document's markup.
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("gateway");
    await expect(page.getByTestId("canvas-steps-count")).toHaveText("2 steps · 1 exit");
    // The state this replaces is gone, not merely covered up.
    await expect(page.getByTestId("canvas-empty-no-session")).toHaveCount(0);
  });

  test("`preparing`, `empty` and `error` are three distinct honest states", async ({ page }) => {
    // Not one generic failure: `preparing` is a fresh scaffold with no deps
    // installed and must never surface a build error to someone who has just
    // created an agent; `empty` is a registered agent with no readable
    // sapiom.json (absent ⇒ empty); `error` is an extraction that ran and
    // failed. Collapsing them was how the first became the third.
    const seed = async (status: string, reason: string | null): Promise<void> => {
      await page.evaluate(
        ({ status, reason }) => {
          (
            window as unknown as {
              __MOCK_WORKFLOW_GRAPH__?: Record<string, { status: string; reason: string | null }>;
            }
          ).__MOCK_WORKFLOW_GRAPH__ = {
            "/Users/demo/polsia/services/gateway": { status, reason },
            "/Users/demo/polsia/scripts/tools/rollup": { status, reason },
          };
        },
        { status, reason },
      );
    };

    await seed("preparing", null);
    await select(page, "gateway");
    // A calm placeholder document, not an error panel.
    await expect(page.frameLocator(".canvas-iframe").locator("body")).toBeVisible();
    await expect(page.getByTestId("canvas-empty-route-error")).toHaveCount(0);
    await expect(page.getByTestId("canvas-empty-route-empty")).toHaveCount(0);

    await seed("empty", "This agent has no sapiom.json, so there is no graph to render yet.");
    await select(page, "rollup");
    await expect(page.getByTestId("canvas-empty-route-empty")).toContainText(
      "no sapiom.json",
    );

    await seed("error", "esbuild: could not resolve ./steps");
    await select(page, "gateway");
    await expect(page.getByTestId("canvas-empty-route-error")).toContainText(
      "could not resolve ./steps",
    );
  });
});

test.describe("run evidence", () => {
  test("a run stops showing the moment the subject changes, and comes back with it", async ({
    page,
  }) => {
    // Evidence is attributed to the SUBJECT. Left keyed to the session, the run
    // announced for `mailer` kept drawing over `sender`'s structure — a false
    // account of what ran, in the surface whose whole job is to say what ran.
    await startSessionOn(page, "mailer");
    await page.getByTestId("session-step-local").click();
    await expect(page.getByRole("dialog", { name: "Run mailer" })).toBeVisible();
    await page.getByTestId("run-sheet-submit").click();
    await openSteps(page);
    await expect(page.getByTestId("run-workspace")).toBeVisible();
    await expect(page.getByTestId("canvas-run-chip")).toBeVisible();

    await select(page, "sender");
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("sender");
    await expect(page.getByTestId("canvas-run-chip")).toHaveCount(0);
    await expect(page.getByTestId("run-workspace")).toHaveCount(0);

    // Still true, still `mailer`'s: the run was filtered out, never dropped.
    await select(page, "mailer");
    await openSteps(page);
    await expect(page.getByTestId("canvas-run-chip")).toBeVisible();
  });

  test("the run picker offers exactly the subject's runs", async ({ page }) => {
    // The count in the picker's own accessible name is where the prototype's
    // unbounded merge surfaced ("309 observed" against a 200 window). The cap
    // itself needs 200+ runs and is pinned in `session-scope.test.ts`; what a
    // browser can prove is that the list is the SUBJECT's and no one else's.
    await startSessionOn(page, "mailer");
    for (const topic of ["one", "two"]) {
      await page.getByTestId("session-step-local").click();
      await page.getByLabel(/Topic/).fill(topic);
      await page.getByTestId("run-sheet-submit").click();
      await openSteps(page);
      await expect(page.getByTestId("run-workspace")).toBeVisible();
    }
    await expect(page.getByTestId("canvas-run-chip")).toHaveAccessibleName(
      "Pick a run to inspect (2 observed)",
    );

    await select(page, "sender");
    await openSteps(page);
    await expect(page.getByTestId("canvas-run-chip")).toHaveCount(0);
  });
});
