/**
 * The agent modal's rev 5 surfaces (flow-map-chat-overlay.md 4.7.1, 4.7.2,
 * 4.7.6; mock design-eng #240): Canvas | Runs | Secrets, the Runs tab's run
 * list, `</>` in the header strip, and no breadcrumbs or project view inside
 * the modal. I1 and I9 hold across all of them.
 */
import { expect, test, type Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";

/** A run the boot session announces: filed under its bound agent, leasing. */
async function announceRun(
  page: Page,
  executionId: string,
  status: "completed" | "failed",
): Promise<void> {
  await page.evaluate(
    ([id, runStatus]) => {
      const win = window as unknown as {
        __MOCK_RUN_STATE__?: Record<string, unknown>;
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      };
      win.__MOCK_RUN_STATE__ = {
        ...(win.__MOCK_RUN_STATE__ ?? {}),
        [id]: {
          executionId: id,
          status: runStatus,
          output: { id },
          steps: [{ id: "intake-1", name: "intake", status: "passed" }],
        },
      };
      win.__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId: id,
        target: "local",
      });
    },
    [executionId, status] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("the modal's tabs are Canvas, Runs and Secrets, in that order", async ({ page }) => {
  await openAgentModal(page, "acme-app", "leasing");
  await expect(page.getByRole("tablist", { name: "leasing" }).getByRole("tab")).toHaveText([
    "Canvas",
    "Runs",
    "Secrets",
  ]);
  await page.getByTestId("agent-modal-tab-runs").click();
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-tab", "runs");
  await expect(page.getByTestId("agent-modal-tab-runs")).toHaveAttribute("aria-selected", "true");
  // The board stays mounted behind Runs, as it does behind Secrets.
  await expect(page.getByTestId("agent-modal-panel-canvas")).toBeHidden();
  await expect(page.getByTestId("agent-modal-panel-canvas")).toHaveCount(1);
});

test("an agent with no runs says so on Runs", async ({ page }) => {
  await openAgentModal(page, "rfq-agent", "rfq");
  await page.getByTestId("agent-modal-tab-runs").click();
  const empty = page.getByTestId("runs-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No runs yet");
  await expect(page.getByTestId("runs-list")).toHaveCount(0);
});

test("Runs lists the agent's runs newest first, and a row picks the run shown", async ({
  page,
}) => {
  await openAgentModal(page, "acme-app", "leasing");
  await page.getByTestId("agent-modal-tab-runs").click();
  await announceRun(page, "exec-first", "failed");
  await expect(page.getByTestId("runs-row-exec-first")).toBeVisible({ timeout: 8_000 });
  await announceRun(page, "exec-second", "completed");
  await expect(page.getByTestId("runs-row-exec-second")).toBeVisible({ timeout: 8_000 });

  const rows = page.getByTestId("runs-list").locator("[data-testid^='runs-row-']");
  await expect(rows).toHaveCount(2);
  expect(
    await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid"))),
  ).toEqual(["runs-row-exec-second", "runs-row-exec-first"]);
  // The latest is shown until another is picked.
  await expect(page.getByTestId("runs-row-exec-second")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("runs-row-exec-second")).toContainText("local run completed");
  await expect(page.getByTestId("run-artifact")).toContainText("exec-second", { timeout: 8_000 });

  await page.getByTestId("runs-row-exec-first").click();
  await expect(page.getByTestId("runs-row-exec-first")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("runs-row-exec-second")).not.toHaveAttribute("aria-current", "true");
  await expect(page.locator(".run-workspace-status")).toContainText("Failed", { timeout: 8_000 });
});

test("Escape closes the modal from a Runs tab showing a run: its timeline is the modal's, not a layer above", async ({
  page,
}) => {
  await openAgentModal(page, "acme-app", "leasing");
  await page.getByTestId("agent-modal-tab-runs").click();
  await announceRun(page, "exec-escape", "completed");
  await expect(page.getByTestId("run-timeline")).toBeVisible({ timeout: 8_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-modal")).toHaveCount(0);
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", "leasing");
});

test("I1 and I9: Runs and </> leave the map's width alone, and closing returns to the map as it was", async ({
  page,
}) => {
  await openAgentModal(page, "acme-app", "leasing");
  await page.getByTestId("agent-modal-close").click();
  const map = page.getByTestId("project-map-pane");
  const before = await map.boundingBox();
  expect(before).not.toBeNull();

  await page.getByTestId("map-card-open-agent").click();
  await page.getByTestId("agent-modal-tab-runs").click();
  await page.getByTestId("agent-modal-snippets").click();
  await expect(page.getByTestId("agent-modal-snippets-popover")).toBeVisible();
  expect(await map.boundingBox()).toEqual(before);

  // Escape unwinds one layer: the popover, then the modal.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-modal-snippets-popover")).toHaveCount(0);
  await expect(page.getByTestId("agent-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-modal")).toHaveCount(0);
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-subject", "leasing");
  await expect(page.getByTestId("map-card")).toHaveAttribute("data-state", "node");
  expect(await map.boundingBox()).toEqual(before);
});

test("no breadcrumbs: nothing in the modal renders a project view inside it (4.7.6)", async ({
  page,
}) => {
  await openAgentModal(page, "acme-app", "leasing");
  const modal = page.getByTestId("agent-modal");
  const noProjectInside = async (): Promise<void> => {
    await expect(modal.locator("[data-testid^='canvas-trail']")).toHaveCount(0);
    await expect(modal.locator("nav[aria-label*='readcrumb' i]")).toHaveCount(0);
    await expect(modal.getByTestId("project-map-pane")).toHaveCount(0);
    await expect(modal.getByTestId("session-context")).toHaveCount(0);
    await expect(modal.getByTestId("map-card")).toHaveCount(0);
  };
  await noProjectInside();
  // The project's name appears nowhere in the modal as a control.
  await expect(modal.getByRole("button", { name: "acme-app", exact: true })).toHaveCount(0);
  await expect(modal.getByRole("link", { name: "acme-app", exact: true })).toHaveCount(0);

  // Every tab, and `</>`, keep it that way.
  for (const tab of ["runs", "secrets", "canvas"]) {
    await page.getByTestId(`agent-modal-tab-${tab}`).click();
    await expect(modal).toHaveAttribute("data-tab", tab);
    await noProjectInside();
  }
  await page.getByTestId("agent-modal-snippets").click();
  await expect(page.getByTestId("agent-modal-snippets-popover")).toBeVisible();
  await noProjectInside();
  // The map is still the one centre, exactly once, underneath.
  await expect(page.getByTestId("project-map-pane")).toHaveCount(1);
});

test("a launched child agent opened in the modal shows no crumb and no project view (4.7.6)", async ({
  page,
}) => {
  await openAgentModal(page, "acme-app", "leasing");
  const modal = page.getByTestId("agent-modal");
  await expect(page.locator(".agent-modal .canvas-iframe")).toBeVisible();
  // leasing's board posts a graph whose entry launches rfq, then a pick of
  // the launched node: the same messages a generated board sends.
  const post = (message: unknown): Promise<void> =>
    page
      .frameLocator(".agent-modal .canvas-iframe")
      .locator("body")
      .evaluate((_, payload) => window.parent.postMessage(payload, "*"), message);
  await post({
    type: "sapiom-canvas:graph",
    graph: {
      name: "leasing",
      entry: "intake",
      nodes: [
        { id: "intake", kind: "entry", label: "intake", capabilities: [] },
        { id: "launch:rfq", kind: "launched-workflow", label: "rfq", capabilities: [] },
      ],
      edges: [{ from: "intake", to: "launch:rfq", kind: "launch", label: "launch()" }],
    },
  });
  await post({ type: "sapiom:node-click", stepName: "rfq" });
  await page.getByTestId("step-card-open-agent").click();

  // The child takes the modal's place: no crumb back to leasing or the
  // project, and the map stays the one centre underneath.
  await expect(modal).toHaveAttribute("data-agent", "rfq");
  await expect(modal.locator("[data-testid^='canvas-trail']")).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "leasing", exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "acme-app", exact: true })).toHaveCount(0);
  await expect(modal.getByTestId("project-map-pane")).toHaveCount(0);
  await expect(modal.getByTestId("session-context")).toHaveCount(0);
  await expect(page.getByTestId("project-map-pane")).toHaveCount(1);
  for (const tab of ["runs", "secrets", "canvas"]) {
    await page.getByTestId(`agent-modal-tab-${tab}`).click();
    await expect(modal.getByTestId("project-map-pane")).toHaveCount(0);
    await expect(modal.locator("[data-testid^='canvas-trail']")).toHaveCount(0);
  }
});
