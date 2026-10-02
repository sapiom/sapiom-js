/**
 * The right pane, the lifecycle verbs and the run evidence are about ONE agent:
 * the selected session's bound agent (flow-navigation.md 4.2.2, Q5; design.md
 * I3). An agent with no session is looked at on its project's map, where Open
 * canvas enters its board in the centre (4.4).
 *
 * This replaced SAP-2931's "the right pane follows the rail SELECTION": the
 * rail lists no agents now (Q3), so the only things on the right are the
 * session's own. What SAP-2931 protected still holds and is asserted in a
 * browser, on a real undeployed agent: the verbs' enabled state AND their
 * targets read the same agent the board draws, so selecting a session bound to
 * an undeployed agent leaves no verb live against a deployed one. They assert
 * `disabled`, `aria-label` AND `data-tooltip` — a disabled control without its
 * reason is mute.
 *
 * Runs against `?mockFixtures=deep`, the fixture with several agents inside ONE
 * project:
 *
 *   /Users/demo/polsia                      project root
 *     backend/src/agents/ads                undeployed
 *     backend/src/agents/outreach           undeployed
 *     packages/harness/web/src/components/mailer    DEPLOYED (ready build)
 *     packages/harness/web/src/components/sender    undeployed
 *     services/gateway                      undeployed, no session ever
 *
 * No fixture session is rooted in polsia, which is deliberate: each test that
 * needs one starts it through the UI (Start chat on the agent's map panel).
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  activeSessionId,
  openAgentCanvas,
  selectSession,
  startChatWithAgent,
} from "./mock-navigation";

/** A new chat bound to `name`, from its panel on polsia's map. */
const chatWith = (page: Page, name: string): Promise<string> =>
  startChatWithAgent(page, "polsia", name);

/** The right pane, open and on the Steps tab. */
async function openSteps(page: Page): Promise<void> {
  const expand = page.getByTestId("right-expand");
  if ((await expand.count()) > 0) await expand.click();
  await page.getByTestId("right-tab-steps").click();
}

/** The agent the right pane says it is about (Steps surface). */
const paneSubject = (page: Page) =>
  page.getByTestId("right-panel-canvas").locator(".workflow-actions-name");

/** The board document in the CENTRE (an agent entered from its map). */
const centreBoard = (page: Page) =>
  page.getByTestId("project-map-pane").locator(".canvas-iframe");

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
});

test.describe("the right pane follows the selected session's agent", () => {
  test("switching sessions switches the agent; the session list does not move", async ({
    page,
  }) => {
    const ads = await chatWith(page, "ads");
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("ads");

    const outreach = await chatWith(page, "outreach");
    expect(outreach).not.toBe(ads);
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("outreach");

    // One click back: the pane is the selected session's agent again.
    await selectSession(page, ads);
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("ads");
    await expect(page.getByTestId("agent-view")).toBeVisible();
  });

  test("looking at another agent's board leaves the session alone", async ({
    page,
  }) => {
    // Work on ads while reading outreach's board: the board is in the centre,
    // entered from the map, and the selected session does not move.
    const ads = await chatWith(page, "ads");
    await openAgentCanvas(page, "polsia", "outreach");
    await expect(centreBoard(page)).toHaveAttribute(
      "srcdoc",
      /outreach — mock agent board/,
    );
    // The header names the project view, so the rail says which session is
    // still selected, and one click brings it back.
    await expect(page.getByTestId(`rail-session-${ads}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await page.getByTestId(`rail-session-select-${ads}`).click();
    await expect.poll(() => activeSessionId(page)).toBe(ads);
  });
});

test.describe("verb gating", () => {
  test("a session bound to an undeployed agent disables Prod and Run, with the reason in aria-label AND data-tooltip", async ({
    page,
  }) => {
    const mailer = await chatWith(page, "mailer");
    const prod = page.getByTestId("session-step-prod");
    await expect(prod).toBeEnabled();
    await expect(prod).toHaveAccessibleName(
      "Open mailer in the Sapiom dashboard",
    );
    await page.getByRole("button", { name: "Choose run target" }).click();
    await expect(page.getByTestId("session-step-run")).toBeEnabled();
    await page.keyboard.press("Escape");

    await chatWith(page, "sender");
    // Prod: disabled, and its reason readable from BOTH channels.
    await expect(prod).toBeDisabled();
    await expect(prod).toHaveAccessibleName("Prod: Not deployed yet");
    await expect(prod).toHaveAttribute(
      "data-tooltip",
      "Prod: Not deployed yet",
    );

    // Run (the cloud target): same.
    await page.getByRole("button", { name: "Choose run target" }).click();
    const cloud = page.getByTestId("session-step-run");
    await expect(cloud).toBeDisabled();
    await expect(cloud).toHaveAccessibleName("Cloud: Not deployed yet");
    await expect(cloud).toHaveAttribute("data-tooltip", "Not deployed yet");
    await page.keyboard.press("Escape");

    // Test and Deploy stay available: they are precisely what you CAN do to an
    // undeployed agent.
    await expect(page.getByTestId("session-step-local")).toBeEnabled();
    await expect(page.getByTestId("session-step-deploy")).toBeEnabled();

    // Back on the mailer session the gate follows, rather than latching once.
    await selectSession(page, mailer);
    await expect(page.getByTestId("session-step-prod")).toBeEnabled();
  });

  test("the run sheet opens on the session's agent", async ({ page }) => {
    await chatWith(page, "mailer");
    await chatWith(page, "sender");
    await page.getByTestId("session-step-local").click();
    await expect(
      page.getByRole("dialog", { name: "Run sender" }),
    ).toBeVisible();
  });
});

test.describe("boards for agents with no session", () => {
  test("an agent that has never hosted a session shows a REAL board", async ({
    page,
  }) => {
    // No fixture session is rooted in polsia, so `gateway` has never had one.
    // Entered from its map, its board is served from `sapiom.json` alone
    // (IA-01's workflow-keyed route), with no session started for it.
    await openAgentCanvas(page, "polsia", "gateway");
    // A document is really mounted — asserted from INSIDE the frame, so a
    // rendered empty state or a stranded skeleton cannot pass for a board.
    const frame = page
      .getByTestId("project-map-pane")
      .frameLocator(".canvas-iframe");
    await expect(frame.getByTestId("mock-workflow-board")).toBeVisible();
    await expect(centreBoard(page)).toHaveAttribute(
      "srcdoc",
      /gateway — mock agent board/,
    );
    // The theme bridge: a `srcdoc` frame has no URL, so the served document's
    // `?theme=` reader has nothing to read and the app hands it the theme in an
    // appended script instead. Without it the board uses the light product
    // default and can come up light inside a dark app.
    await expect(frame.locator("html")).toHaveAttribute(
      "data-canvas-theme",
      /light|dark/,
    );
    // No session was started to look at it.
    await expect(page.getByTestId("rail-project-polsia").locator(".rail-session-row")).toHaveCount(0);
    await expect(page.getByTestId("canvas-empty-no-session")).toHaveCount(0);
  });

  test("`preparing`, `empty` and `error` are three distinct honest states", async ({
    page,
  }) => {
    // Not one generic failure: `preparing` is a fresh scaffold with no deps
    // installed and must never surface a build error to someone who has just
    // created an agent; `empty` is a registered agent with no readable
    // sapiom.json (absent ⇒ empty); `error` is an extraction that ran and
    // failed. Collapsing them was how the first became the third.
    const seed = async (
      status: string,
      reason: string | null,
    ): Promise<void> => {
      await page.evaluate(
        ({ status, reason }) => {
          (
            window as unknown as {
              __MOCK_WORKFLOW_GRAPH__?: Record<
                string,
                { status: string; reason: string | null }
              >;
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
    await openAgentCanvas(page, "polsia", "gateway");
    // A calm placeholder document, not an error panel.
    await expect(
      page
        .getByTestId("project-map-pane")
        .frameLocator(".canvas-iframe")
        .getByTestId("mock-workflow-message"),
    ).toContainText("Preparing your agent");
    await expect(page.getByTestId("canvas-empty-route-error")).toHaveCount(0);
    await expect(page.getByTestId("canvas-empty-route-empty")).toHaveCount(0);

    await seed(
      "empty",
      "This agent has no sapiom.json, so there is no graph to render yet.",
    );
    await page.getByTestId("project-map-back").click();
    await page.getByTestId("map-agent-rollup").click();
    await page.getByTestId("map-agent-open-canvas").click();
    await expect(page.getByTestId("canvas-empty-route-empty")).toContainText(
      "no sapiom.json",
    );

    await seed("error", "esbuild: could not resolve ./steps");
    await page.getByTestId("project-map-back").click();
    await page.getByTestId("map-agent-gateway").click();
    await page.getByTestId("map-agent-open-canvas").click();
    await expect(page.getByTestId("canvas-empty-route-error")).toContainText(
      "could not resolve ./steps",
    );
  });
});

test.describe("run evidence", () => {
  test("a run stops showing the moment the agent changes, and comes back with it", async ({
    page,
  }) => {
    // Evidence is attributed to the AGENT. The run announced for `mailer` must
    // never draw over `sender`'s structure — a false account of what ran, in
    // the surface whose whole job is to say what ran.
    const mailer = await chatWith(page, "mailer");
    await page.getByTestId("session-step-local").click();
    await expect(
      page.getByRole("dialog", { name: "Run mailer" }),
    ).toBeVisible();
    await page.getByTestId("run-sheet-submit").click();
    await openSteps(page);
    await expect(page.getByTestId("run-workspace")).toBeVisible();
    await expect(page.getByTestId("canvas-run-chip")).toBeVisible();

    await chatWith(page, "sender");
    await openSteps(page);
    await expect(paneSubject(page)).toHaveText("sender");
    await expect(page.getByTestId("canvas-run-chip")).toHaveCount(0);
    await expect(page.getByTestId("run-workspace")).toHaveCount(0);

    // Still true, still `mailer`'s: the run was filtered out, never dropped.
    await selectSession(page, mailer);
    await openSteps(page);
    await expect(page.getByTestId("canvas-run-chip")).toBeVisible();
  });

  test("the run picker offers exactly the agent's runs", async ({ page }) => {
    // The count in the picker's own accessible name is where the prototype's
    // unbounded merge surfaced ("309 observed" against a 200 window). The cap
    // itself needs 200+ runs and is pinned in `session-scope.test.ts`; what a
    // browser can prove is that the list is the AGENT's and no one else's.
    await chatWith(page, "mailer");
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

    await chatWith(page, "sender");
    await openSteps(page);
    await expect(page.getByTestId("canvas-run-chip")).toHaveCount(0);
  });
});
