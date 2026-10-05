/**
 * The agent modal's board, verbs and run evidence are about ONE agent: the
 * agent it was opened on, by path (flow-map-chat-overlay.md 4.2b, 4.4b;
 * design-map-chat.md I3). An agent is looked at in its modal over its
 * project's map; opening it never moves the selected session.
 *
 * What SAP-2931 protected still holds and is asserted in a browser, on a real
 * undeployed agent: the verbs' enabled state AND their targets read the same
 * agent the board draws, so a modal on an undeployed agent leaves no verb live
 * against a deployed one. They assert `disabled`, `aria-label` AND
 * `data-tooltip`: a disabled control without its reason is mute.
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
 * No fixture session is rooted in polsia, which is deliberate: looking at its
 * agents must never need one.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { activeSessionId, openAgentModal } from "./mock-navigation";

/** The board document in the agent modal. */
const modalBoard = (page: Page) =>
  page.getByTestId("agent-modal-panel-canvas").locator(".canvas-iframe");

/** Close the modal, back to the map it was opened over. */
async function closeModal(page: Page): Promise<void> {
  await page.getByTestId("agent-modal-close").click();
  await expect(page.getByTestId("agent-modal")).toHaveCount(0);
}

/** Another agent on the map that is already showing: pick, Open agent. */
async function openFromMap(page: Page, agent: string): Promise<void> {
  await page.getByTestId(`map-agent-${agent}`).click();
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", agent);
  await page.getByTestId("map-card-open-agent").click();
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", agent);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
});

test.describe("the modal is about the agent it was opened on", () => {
  test("looking at another agent's board leaves the session alone", async ({
    page,
  }) => {
    // Work in the selected session while reading outreach's board: the board
    // is in a modal over the map, and the selected session does not move.
    const selected = await activeSessionId(page);
    expect(selected).toBeTruthy();
    await openAgentModal(page, "polsia", "outreach");
    await expect(modalBoard(page)).toHaveAttribute(
      "srcdoc",
      /outreach — mock agent board/,
    );
    // The rail still says which session is selected, and one click brings it
    // back once the modal is closed.
    await expect(page.getByTestId(`rail-session-${selected}`)).toHaveAttribute(
      "data-selected",
      "true",
    );
    await closeModal(page);
    await page.getByTestId(`rail-session-select-${selected}`).click();
    await expect.poll(() => activeSessionId(page)).toBe(selected);
  });
});

test.describe("verb gating", () => {
  test("a modal on an undeployed agent disables Run, with the reason in aria-label AND data-tooltip", async ({
    page,
  }) => {
    await openAgentModal(page, "polsia", "mailer");
    const prod = page.getByTestId("agent-modal-prod-run");
    await expect(prod).toBeEnabled();
    await expect(prod).toHaveAccessibleName("Run");
    await closeModal(page);

    await openFromMap(page, "sender");
    // Run (the cloud target): disabled, and its reason readable from BOTH
    // channels.
    await expect(prod).toBeDisabled();
    await expect(prod).toHaveAccessibleName("Run: Not deployed yet");
    await expect(prod).toHaveAttribute("data-tooltip", "Not deployed yet");

    // Run locally and Deploy stay available: they are precisely what you CAN
    // do to an undeployed agent.
    await expect(page.getByTestId("agent-modal-run-local")).toBeEnabled();
    await expect(page.getByTestId("agent-modal-deploy")).toBeEnabled();

    // Back on mailer the gate follows, rather than latching once.
    await closeModal(page);
    await openFromMap(page, "mailer");
    await expect(page.getByTestId("agent-modal-prod-run")).toBeEnabled();
  });

  test("the run sheet opens on the modal's agent", async ({ page }) => {
    await openAgentModal(page, "polsia", "mailer");
    await closeModal(page);
    await openFromMap(page, "sender");
    await page.getByTestId("agent-modal-run-local").click();
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
    // Opened from its map, its board is served from `sapiom.json` alone
    // (IA-01's workflow-keyed route), with no session started for it.
    await openAgentModal(page, "polsia", "gateway");
    // A document is really mounted — asserted from INSIDE the frame, so a
    // rendered empty state or a stranded skeleton cannot pass for a board.
    const frame = page
      .getByTestId("agent-modal-panel-canvas")
      .frameLocator(".canvas-iframe");
    await expect(frame.getByTestId("mock-workflow-board")).toBeVisible();
    await expect(modalBoard(page)).toHaveAttribute(
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
    await openAgentModal(page, "polsia", "gateway");
    // A calm placeholder document, not an error panel.
    await expect(
      page
        .getByTestId("agent-modal-panel-canvas")
        .frameLocator(".canvas-iframe")
        .getByTestId("mock-workflow-message"),
    ).toContainText("Preparing your agent");
    await expect(page.getByTestId("canvas-empty-route-error")).toHaveCount(0);
    await expect(page.getByTestId("canvas-empty-route-empty")).toHaveCount(0);

    await seed(
      "empty",
      "This agent has no sapiom.json, so there is no graph to render yet.",
    );
    await closeModal(page);
    await openFromMap(page, "rollup");
    await expect(page.getByTestId("canvas-empty-route-empty")).toContainText(
      "no sapiom.json",
    );

    await seed("error", "esbuild: could not resolve ./steps");
    await closeModal(page);
    await openFromMap(page, "gateway");
    await expect(page.getByTestId("canvas-empty-route-error")).toContainText(
      "could not resolve ./steps",
    );
  });
});

/** A board that echoes the run state the pane posts into it, so the test can
 *  see which run the modal draws. */
const ECHO_BOARD = `<!DOCTYPE html><html><body><script>
window.addEventListener("message", function (e) {
  var d = e && e.data;
  if (d && d.type === "sapiom:run-state")
    parent.postMessage({ type: "sapiom:run-state-received", status: d.status, target: d.target }, "*");
});
</script></body></html>`;

/** Swap the modal's board for the echo board and count what it receives. */
async function runStatesReceived(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const win = window as unknown as { __RECEIPTS__: number };
    win.__RECEIPTS__ = 0;
    window.addEventListener("message", (e) => {
      if ((e.data as { type?: string } | null)?.type === "sapiom:run-state-received")
        win.__RECEIPTS__ += 1;
    });
  });
  await page.evaluate((doc) => {
    (document.querySelector(".agent-modal .canvas-iframe") as HTMLIFrameElement).srcdoc = doc;
  }, ECHO_BOARD);
  return () =>
    page.evaluate(() => (window as unknown as { __RECEIPTS__: number }).__RECEIPTS__);
}

test.describe("run evidence", () => {
  test("a run shows on its agent's board and on no other agent's", async ({
    page,
  }) => {
    // Evidence is attributed to the AGENT. A run of `leasing` (the session
    // that started it is bound to it) must never draw over `gateway`'s
    // structure, or any other agent's — a false account of what ran, in the surface whose whole job
    // is to say what ran.
    await page.evaluate(() => {
      (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId: "exec-evidence-1",
        target: "prod",
      });
    });

    await openAgentModal(page, "polsia", "gateway");
    await expect(modalBoard(page)).toBeVisible();
    await expect(page.locator(".agent-modal .canvas-loading--overlay")).toHaveCount(0, { timeout: 8_000 });
    const otherReceipts = await runStatesReceived(page);
    await page.waitForTimeout(600);
    expect(await otherReceipts()).toBe(0);
    await closeModal(page);

    // Still true, still `leasing`'s: the run was filtered out, never dropped.
    await openAgentModal(page, "acme-app", "leasing");
    await expect(modalBoard(page)).toBeVisible();
    await expect(page.locator(".agent-modal .canvas-loading--overlay")).toHaveCount(0, { timeout: 8_000 });
    const leasingReceipts = await runStatesReceived(page);
    await expect.poll(leasingReceipts, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test("the run picker offers exactly the agent's runs", async ({ page }) => {
    // The count in the picker's own accessible name is where the prototype's
    // unbounded merge surfaced ("309 observed" against a 200 window). The cap
    // itself needs 200+ runs and is pinned in `session-scope.test.ts`; what a
    // browser can prove is that the list is the AGENT's and no one else's.
    const publish = (executionId: string): Promise<void> =>
      page.evaluate((id) => {
        (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
          type: "execution.started",
          harnessSessionId: "sess-boot",
          executionId: id,
          target: "prod",
        });
      }, executionId);
    await publish("exec-picker-1");
    await publish("exec-picker-2");

    await openAgentModal(page, "acme-app", "leasing");
    await expect(page.getByTestId("canvas-run-chip")).toHaveAccessibleName(
      "Pick a run to inspect (2 observed)",
    );
    await closeModal(page);

    await openAgentModal(page, "polsia", "gateway");
    await expect(modalBoard(page)).toBeVisible();
    await expect(page.getByTestId("canvas-run-chip")).toHaveCount(0);
  });
});
