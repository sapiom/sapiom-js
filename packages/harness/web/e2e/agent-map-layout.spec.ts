import { expect, test, type Page } from "@playwright/test";
import type { ElkNode } from "elkjs/lib/elk-api";

const url =
  "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1";
async function open(page: Page, query = "") {
  await page.goto(url + query);
  await page
    .getByTestId("workspace-group-acme-app")
    .getByTestId("project-select-acme-app")
    .click();
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

test("switches the same saved map through a lazy local worker with measured cards/labels and retained selection", async ({
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
  await open(page);
  expect(workers).toHaveLength(0);
  const before = await identities(page);
  const selected = page.locator(".agent-map-node").first();
  await page.locator(".agent-map-node-info").first().click();
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect(map(page)).toHaveAttribute("data-layout-engine", "elk");
  expect(await identities(page)).toEqual(before);
  expect(workers).toHaveLength(1);
  expect(new URL(workers[0]!).origin).toBe(new URL(page.url()).origin);
  expect(workers[0]).toContain("elk-worker.min");
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("agent-map-inspector")).toBeVisible();
  const dimensions = await page.evaluate(() => {
    const input = (window as unknown as { layoutInput: ElkNode }).layoutInput;
    const cards = [
      ...document.querySelectorAll<HTMLElement>(".agent-map-node"),
    ];
    const texts = [
      ...document.querySelectorAll<SVGTextElement>(".agent-map-edge-label"),
    ];
    return {
      cardsMatch: input.children!.every(
        (node, index) =>
          cards[index]!.offsetWidth === node.width &&
          cards[index]!.offsetHeight === node.height,
      ),
      labels: input.edges!.map((edge) => {
        const label = edge.labels![0]!,
          text = texts.find((text) => text.textContent === label.text)!;
        const box = text.getBBox(),
          padding = Number.parseFloat(getComputedStyle(text).strokeWidth) + 4;
        return {
          measured: label,
          actual: { width: box.width + padding, height: box.height + padding },
        };
      }),
    };
  });
  expect(dimensions.cardsMatch).toBe(true);
  for (const { measured, actual } of dimensions.labels) {
    expect(measured.width).toBeCloseTo(actual.width, 2);
    expect(measured.height).toBeCloseTo(actual.height, 2);
  }
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await expect(map(page)).toHaveAttribute("data-layout-engine", "classic");
  expect(await identities(page)).toEqual(before);
  await expect(selected).toHaveAttribute("aria-pressed", "true");
});

test("shows an identified Classic fallback after worker failure and recovers on the next selection", async ({
  page,
}) => {
  await open(page);
  await page.route("**/*elk-worker.min*", (route) => route.abort());
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect(map(page)).toHaveAttribute("data-layout-state", "fallback");
  await expect(
    page.getByRole("status").filter({ hasText: "Classic fallback" }),
  ).toBeVisible();
  const before = await identities(page);
  await page.unroute("**/*elk-worker.min*");
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await expect(map(page)).toHaveAttribute("data-layout-engine", "elk");
  expect(await identities(page)).toEqual(before);
  await page.reload();
  await expect(map(page)).toHaveAttribute("data-layout-engine", "elk");
});

test("fences layout selection and graph changes while the worker is pending", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: { cmd?: string; graph?: ElkNode }) {
        if (message.cmd === "layout") {
          document.documentElement.dataset.labelWidth = String(
            message.graph!.edges![0]!.labels![0]!.width,
          );
          setTimeout(() => super.postMessage(message), 200);
        } else super.postMessage(message);
      }
    };
  });
  await open(page, "&mapLayout=elk");
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  await expect(map(page)).toHaveAttribute("data-layout-engine", "classic");
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  const nodeId = "node_00000000-0000-7000-8000-000000001999";
  const viewport = page.getByTestId("agent-map-viewport");
  await viewport.evaluate((el) => ((el as HTMLElement).style.display = "none"));
  await page.evaluate((nodeId) => {
    const projectId = document
      .querySelector("[data-testid='agent-map-live']")!
      .getAttribute("data-project-id");
    (
      window as unknown as {
        __HARNESS_TEST__: { publish: (message: unknown) => void };
      }
    ).__HARNESS_TEST__.publish({
      type: "agent-map.proposal.changed",
      delta: {
        schemaVersion: 1,
        projectId,
        proposalId: "proposal_00000000-0000-7000-8000-000000000101",
        fromVersion: 1,
        version: 2,
        operationIds: ["operation_00000000-0000-7000-8000-000000001999"],
        operations: [
          {
            kind: "add-node",
            node: {
              id: nodeId,
              kind: "agent",
              name: "New agent",
              purpose: "New responsibility",
              ownerAgentId: null,
              contractRefs: [],
            },
          },
        ],
        actor: { userId: "user_mock", sessionId: "builder_mock" },
        acceptedAt: new Date().toISOString(),
      },
    });
  }, nodeId);
  await expect(page.getByTestId(`agent-map-node-${nodeId}`)).toHaveCount(1);
  await page.waitForTimeout(250);
  await viewport.evaluate((el) => ((el as HTMLElement).style.display = ""));
  await expect(map(page)).toHaveAttribute("data-layout-engine", "elk");
  await expect(page.getByTestId(`agent-map-node-${nodeId}`)).toBeVisible();
  expect(
    Number(await page.locator("html").getAttribute("data-label-width")),
  ).toBeGreaterThan(100);
});
