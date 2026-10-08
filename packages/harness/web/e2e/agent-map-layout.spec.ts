import { expect, test, type Page } from "@playwright/test";
import type { ElkNode } from "elkjs/lib/elk-api";

const url =
  "/?seed=0&mockFixtures=deep&mockStudioProjects=present";
async function open(page: Page, query = "") {
  await page.goto(url + query);
  await page.getByTestId("project-select-acme-app").click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
}
const map = (page: Page) => page.getByTestId("agent-map-canvas");
async function identities(page: Page) {
  return page
    .locator(".agent-map-node, [data-testid^='agent-map-edge-']")
    .evaluateAll((elements) =>
      elements
        .map((el) => [el.getAttribute("data-testid"), el.textContent])
        .sort(),
    );
}

test("renders the computed map through a lazy local worker with measured cards and retained selection", async ({
  page,
}) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: { cmd?: string; graph?: ElkNode }) {
        if (message.cmd === "layout")
          (window as unknown as { layoutInput: unknown }).layoutInput =
            message.graph;
        super.postMessage(message);
      }
    };
  });
  await page.goto(url);
  expect(workers).toHaveLength(0);
  await page.getByTestId("project-select-acme-app").click();
  await expect(map(page)).toHaveAttribute("data-layout-state", "ready");
  const before = await identities(page);
  // An agent Studio cannot open: a pick that selects it and resolves nothing,
  // so its card's text is the same before and after.
  const selected = page.getByTestId("agent-map-node-screening");
  await selected.click();
  // The map is the centre at full width (flow-navigation.md 4.3), so there is
  // no separate full view: folding the rail is the pane resize that remains.
  await page.getByTestId("rail-collapse").click();
  await expect(map(page)).toHaveAttribute("data-layout-engine", "elk");
  expect(await identities(page)).toEqual(before);
  expect(workers).toHaveLength(1);
  expect(new URL(workers[0]!).origin).toBe(new URL(page.url()).origin);
  expect(workers[0]).toContain("elk-worker.min");
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  const sizes = await page.evaluate(() => {
    const input = (window as unknown as { layoutInput: ElkNode }).layoutInput;
    const requested = new Map<string, { width?: number; height?: number }>();
    for (const child of input.children!) {
      if (child.children)
        for (const member of child.children) requested.set(member.id, member);
      else requested.set(child.id, child);
    }
    return [
      ...document.querySelectorAll<HTMLElement>(".agent-map-node"),
    ].map((card) => {
      const want = requested.get(
        card.dataset.testid!.replace("agent-map-node-", ""),
      );
      return {
        id: card.dataset.testid,
        width: [card.offsetWidth, want?.width],
        height: [card.offsetHeight, want?.height],
      };
    });
  });
  // Every card is drawn at the size the layout was asked to place.
  expect(sizes).toHaveLength(4);
  for (const size of sizes) {
    expect(size.width[0], size.id).toBe(size.width[1]);
    expect(size.height[0], size.id).toBe(size.height[1]);
  }
  await page.getByTestId("rail-expand").click();
  await expect(map(page)).toHaveAttribute("data-layout-state", "ready");
  expect(await identities(page)).toEqual(before);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
});

test("shows a retryable layout error after worker failure and recovers without changing the map", async ({
  page,
}) => {
  await page.goto(url);
  const project = page.getByTestId("project-select-acme-app");
  await expect(project).toBeVisible();
  await page.route("**/*elk-worker.min*", (route) => route.abort());
  await project.click();
  await expect(map(page)).toHaveAttribute("data-layout-state", "error");
  await expect(page.getByTestId("agent-map-layout-error")).toBeVisible();
  await expect(page.locator(".agent-map-node")).toHaveCount(0);
  await page.unroute("**/*elk-worker.min*");
  await page.getByRole("button", { name: "Retry layout", exact: true }).click();
  await expect(map(page)).toHaveAttribute("data-layout-state", "ready");
  const before = await identities(page);
  expect(before.length).toBeGreaterThan(0);
  await page.reload();
  // The view is not persisted; the map is computed again from the same code.
  await page.getByTestId("project-select-acme-app").click();
  await expect(map(page)).toHaveAttribute("data-layout-state", "ready");
  expect(await identities(page)).toEqual(before);
});

test("a map change while the viewport is hidden lays out once it is visible again", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: { cmd?: string }) {
        if (message.cmd === "layout") {
          (window as unknown as { layouts: number }).layouts =
            ((window as unknown as { layouts?: number }).layouts ?? 0) + 1;
          setTimeout(() => super.postMessage(message), 200);
        } else super.postMessage(message);
      }
    };
  });
  await open(page);
  await expect(map(page)).toHaveAttribute("data-layout-state", "ready");
  const viewport = page.getByTestId("agent-map-viewport");
  await viewport.evaluate((el) => ((el as HTMLElement).style.display = "none"));
  const before = await identities(page);
  const projectId = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  await page.evaluate((projectId) => {
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({ type: "project-map.changed", projectId });
  }, projectId);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__: { projectMapCalls?: unknown[] };
            }
          ).__HARNESS_TEST__.projectMapCalls?.length,
      ),
    )
    .toBe(2);
  await viewport.evaluate((el) => ((el as HTMLElement).style.display = ""));
  await expect(map(page)).toHaveAttribute("data-layout-state", "ready");
  await expect(page.locator(".agent-map-node")).toHaveCount(4);
  expect(await identities(page)).toEqual(before);
});
