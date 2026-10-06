/**
 * The agent modal's Canvas reads the agent's steps from the project map
 * (plans/agent-map-rebuild/design.md M6; design-eng agent-studio-v2
 * AGENT-MAP.md "Modal Canvas", D74): its steps, and every agent it calls or
 * that calls it as a card at the board's border, an edge leaving the step that
 * makes the call. Mock: acme-app's leasing launches screening from
 * `request-screening`; screening is called by leasing and emits to
 * applicant-notifier.
 */
import { expect, test, type FrameLocator, type Page } from "@playwright/test";

const BASE = "/?seed=0&mockFixtures=deep&mockStudioProjects=present";

type TestWindow = Window & {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    workflowGraphCalls?: Array<{ path: string; map: { map: { steps: unknown; calls: unknown[]; calledBy: unknown[] }; atRef: boolean } | null }>;
  };
};

async function openModal(page: Page, slug: string): Promise<FrameLocator> {
  await page.goto(BASE);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute("data-layout-state", "ready");
  await page.getByTestId(`agent-map-node-${slug}`).dblclick();
  await expect(page.getByTestId("agent-modal")).toBeVisible();
  return page.frameLocator(".agent-modal iframe");
}

const graphCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as TestWindow).__HARNESS_TEST__.workflowGraphCalls ?? []);

test("leasing's Canvas is its map steps, with screening at the border leaving request-screening", async ({ page }) => {
  const board = await openModal(page, "leasing");
  for (const step of ["apply", "request-screening", "confirm"])
    await expect(board.locator(`[data-node-id="${step}"]`)).toBeVisible();
  await expect(board.locator('[data-node-id="agent:screening"]')).toBeVisible();
  await expect(
    board.locator('[data-edge-from="request-screening"][data-edge-to="agent:screening"]'),
  ).toHaveCount(1);
  // The other agents in its system are not on its board: it touches only screening.
  await expect(board.locator('[data-node-id="agent:applicant-notifier"]')).toHaveCount(0);

  const call = (await graphCalls(page)).at(-1)!;
  expect(call.path).toBe("/Users/demo/acme-app/leasing");
  expect(call.map?.atRef).toBe(false);
  expect(call.map?.map.calls).toEqual([
    { to: "screening", kind: "launch", fromStep: "request-screening" },
  ]);
  expect(call.map?.map.calledBy).toEqual([]);
});

test("a map change re-reads the open board with the map", async ({ page }) => {
  await openModal(page, "leasing");
  await expect.poll(async () => (await graphCalls(page)).length).toBeGreaterThan(0);
  const before = (await graphCalls(page)).length;
  const projectId = await page.getByTestId("agent-map-live").getAttribute("data-project-id");
  await page.evaluate(
    (id) => (window as unknown as TestWindow).__HARNESS_TEST__.publish({ type: "project-map.changed", projectId: id }),
    projectId,
  );
  await expect.poll(async () => (await graphCalls(page)).length).toBeGreaterThan(before);
  expect((await graphCalls(page)).at(-1)!.map).not.toBeNull();
});

test("the map at a ref is drawn at that ref", async ({ page }) => {
  await page.goto(BASE);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute("data-layout-state", "ready");
  await page.getByTestId("project-map-ref").click();
  await page.getByTestId("project-map-ref-main").click();
  await expect(page.getByTestId("project-map-ref")).toHaveAttribute("data-ref", "main");
  await expect(page.getByTestId("project-map-refresh")).not.toHaveAttribute("data-refreshing", "true");
  await page.getByTestId("agent-map-node-leasing").dblclick();
  const board = page.frameLocator(".agent-modal iframe");
  await expect(board.locator('[data-node-id="agent:screening"]')).toBeVisible();
  expect((await graphCalls(page)).at(-1)!.map?.atRef).toBe(true);
});
