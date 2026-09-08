import { expect, test, type Page } from "@playwright/test";
import type { ElkNode } from "elkjs/lib/elk-api";
import { agentMapPackingFixture } from "./agent-map-packing-fixture";

declare global {
  interface Window {
    layoutJobs: { graph: ElkNode; ms: number }[];
  }
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.addInitScript(() => {
    window.layoutJobs = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: { cmd: string; id: number; graph: ElkNode }) {
        if (message.cmd === "layout") {
          const job = { graph: message.graph, ms: 0 },
            start = performance.now();
          window.layoutJobs.push(job);
          this.addEventListener("message", (event) => {
            if (event.data.id === message.id)
              job.ms = performance.now() - start;
          });
        }
        super.postMessage(message);
      }
    };
  });
});
async function delta(page: Page, operations: unknown[], fromVersion: number) {
  await page.evaluate(
    ({ operations, fromVersion }) => {
      const projectId = document
        .querySelector('[data-testid="agent-map-live"]')!
        .getAttribute("data-project-id");
      (
        window as unknown as {
          __HARNESS_TEST__: { publish(message: unknown): void };
        }
      ).__HARNESS_TEST__.publish({
        type: "agent-map.proposal.changed",
        delta: {
          schemaVersion: 1,
          projectId,
          proposalId: "proposal_00000000-0000-7000-8000-000000000101",
          fromVersion,
          version: fromVersion + 1,
          operations,
          operationIds: operations.map(
            (_, i) =>
              `operation_00000000-0000-7000-8000-${String(i + fromVersion * 1000).padStart(12, "0")}`,
          ),
          actor: { userId: "user_mock", sessionId: "builder_mock" },
          acceptedAt: new Date().toISOString(),
        },
      });
    },
    { operations, fromVersion },
  );
  await expect(page.locator(".agent-map-live-header")).toContainText(
    `Version ${fromVersion + 1}`,
  );
}
async function openPacking(page: Page) {
  await page.goto(
    "/?seed=0&mockFixtures=deep&mockStudioProjects=present&mockAgentMapGolden=1",
  );
  await page
    .getByTestId("workspace-group-acme-app")
    .getByTestId("project-select-acme-app")
    .click();
  await expect(page.getByTestId("agent-map-live")).toBeVisible();
  const removals = await page.evaluate(() => {
    const remove = (
      selector: string,
      prefix: string,
      kind: string,
      key: string,
    ) =>
      [...document.querySelectorAll(selector)].map((el) => ({
        kind,
        [key]: el.getAttribute("data-testid")!.slice(prefix.length),
      }));
    return [
      ...remove(
        '[data-testid^="agent-map-edge-"]',
        "agent-map-edge-",
        "remove-relationship",
        "relationshipId",
      ),
      ...remove(".agent-map-node", "agent-map-node-", "remove-node", "nodeId"),
    ];
  });
  const fixture = agentMapPackingFixture();
  await delta(
    page,
    [
      ...removals,
      ...fixture.nodes.map((node) => ({ kind: "add-node", node })),
      ...fixture.relationships.map((relationship) => ({
        kind: "add-relationship",
        relationship,
      })),
    ],
    1,
  );
  await expect(page.locator(".agent-map-node")).toHaveCount(34);
  return fixture;
}
async function arranged(page: Page, aspect: string) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.layoutJobs.at(-1)?.graph.layoutOptions?.["elk.aspectRatio"],
      ),
    )
    .toBe(aspect);
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-state",
    "ready",
  );
  await expect(page.getByTestId("agent-map-canvas")).toHaveAttribute(
    "data-layout-engine",
    "elk",
  );
}
async function metrics(page: Page) {
  return page.evaluate(() => {
    const subject = document.querySelector<HTMLElement>(".agent-map-subject")!,
      viewport = document.querySelector<HTMLElement>(".agent-map-viewport")!;
    const area = viewport.getBoundingClientRect();
    const labels = [...document.querySelectorAll(".agent-map-edge-label")].map(
      (el) => el.getBoundingClientRect(),
    );
    const cards = [...document.querySelectorAll(".agent-map-node")].map((el) =>
      el.getBoundingClientRect(),
    );
    const intersects = (a: DOMRect, b: DOMRect) =>
      a.left < b.right &&
      b.left < a.right &&
      a.top < b.bottom &&
      b.top < a.bottom;
    return {
      bounds: [
        parseFloat(subject.style.width),
        parseFloat(subject.style.height),
      ],
      viewport: [viewport.clientWidth, viewport.clientHeight],
      fit: Number(subject.style.transform.match(/scale\(([^)]+)\)/)![1]),
      clippedLabels: labels.filter(
        (box) =>
          box.left < area.left ||
          box.right > area.right ||
          box.top < area.top ||
          box.bottom > area.bottom,
      ).length,
      overlappingLabels: labels.filter((box, i) =>
        [...cards, ...labels.slice(i + 1)].some((other) =>
          intersects(box, other),
        ),
      ).length,
    };
  });
}

test("packs every disconnected node in normal and expanded panes", async ({
  page,
}, info) => {
  await openPacking(page);
  const normalClassic = await metrics(page);
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await arranged(page, "0.5");
  const normalVertical = await metrics(page);
  await page.getByTestId("canvas-expand").click();
  await arranged(page, "1.5");
  const expandedVertical = await metrics(page);
  await page.getByRole("button", { name: "Classic", exact: true }).click();
  const expandedClassic = await metrics(page);
  expect(normalVertical.fit).toBeGreaterThan(Math.max(0.28, normalClassic.fit));
  expect(expandedVertical.fit).toBeGreaterThanOrEqual(expandedClassic.fit);
  for (const result of [normalVertical, expandedVertical]) {
    expect(result.clippedLabels).toBe(0);
    expect(result.overlappingLabels).toBe(0);
  }
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await arranged(page, "1.5");
  await expect
    .poll(() => page.evaluate(() => window.layoutJobs.at(-1)?.ms ?? 0))
    .toBeGreaterThan(0);
  const jobs = await page.evaluate(() => window.layoutJobs);
  const measurements = {
    normalClassic,
    normalVertical,
    expandedClassic,
    expandedVertical,
    workerMs: jobs.map((job) => job.ms),
  };
  console.log(JSON.stringify(measurements));
  await info.attach("packing-metrics", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
  expect(await page.locator(".agent-map-node").count()).toBe(34);
  expect(await page.locator('[data-testid^="agent-map-edge-"]').count()).toBe(
    13,
  );
});

test("keeps manual view and selection through unrelated updates and topology changes", async ({
  page,
}) => {
  const fixture = await openPacking(page);
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await arranged(page, "0.5");
  const selected = fixture.nodes[33]!;
  await page.getByTestId(`agent-map-node-${selected.id}`).click();
  await arranged(page, "0.25");
  await page.getByRole("button", { name: "Reset Agent Map view" }).click();
  const viewport = page.getByTestId("agent-map-viewport"),
    subject = page.getByTestId("agent-map-subject");
  await viewport.focus();
  await page.keyboard.press("ArrowRight");
  const transform = await subject.getAttribute("style"),
    count = await page.evaluate(() => window.layoutJobs.length);
  await delta(
    page,
    [
      {
        kind: "update-node",
        nodeId: selected.id,
        changes: { name: "Updated agent" },
      },
    ],
    2,
  );
  await delta(
    page,
    [
      {
        kind: "update-relationship",
        relationshipId: fixture.relationships[0]!.id,
        changes: { description: "Status changed" },
      },
    ],
    3,
  );
  await page.setViewportSize({ width: 1504, height: 1100 });
  await page.setViewportSize({ width: 1500, height: 1100 });
  // Cross the debounce window while proving unrelated updates never request work.
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.layoutJobs.length)).toBe(count);
  await expect(subject).toHaveAttribute("style", transform!);
  const added = ["agent", "resource", "artifact"].map((kind, i) => ({
    ...selected,
    id: `node_00000000-0000-7000-8000-${String(100 + i).padStart(12, "0")}`,
    kind,
    name: `New ${kind}`,
  }));
  await delta(
    page,
    added.map((node) => ({ kind: "add-node", node })),
    4,
  );
  await expect
    .poll(() => page.evaluate(() => window.layoutJobs.length))
    .toBe(count + 1);
  await arranged(page, "0.25");
  expect(
    await subject.evaluate((el) => (el as HTMLElement).style.transform),
  ).toBe(transform!.match(/transform: ([^;]+)/)![1]);
  await expect(
    page.getByTestId(`agent-map-node-${selected.id}`),
  ).toHaveAttribute("aria-pressed", "true");
  await delta(
    page,
    [
      {
        kind: "update-relationship",
        relationshipId: fixture.relationships[0]!.id,
        changes: { executionMode: "human-triggered" },
      },
    ],
    5,
  );
  await expect
    .poll(() => page.evaluate(() => window.layoutJobs.length))
    .toBe(count + 2);
  await arranged(page, "0.25");
  await delta(
    page,
    [...added, selected].map((node) => ({
      kind: "remove-node",
      nodeId: node.id,
    })),
    6,
  );
  await expect(page.getByTestId("agent-map-inspector")).toHaveCount(0);
  await arranged(page, "0.5");
  await page.getByRole("button", { name: "Fit Agent Map to view" }).click();
  await page.getByRole("button", { name: "Reset Agent Map view" }).click();
  const first = page.locator(".agent-map-node").first();
  await first.focus();
  const card = await first.boundingBox(),
    area = await viewport.boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(area!.x);
  expect(card!.y).toBeGreaterThanOrEqual(area!.y);
  expect(card!.x + card!.width).toBeLessThanOrEqual(area!.x + area!.width);
  expect(card!.y + card!.height).toBeLessThanOrEqual(area!.y + area!.height);
  await page.getByTestId("canvas-expand").click();
  await arranged(page, "1.5");
  await page.getByTestId("canvas-expand-exit").click();
  await arranged(page, "0.5");
});

for (const mode of ["Classic", "Vertical"]) {
  test(`${mode} keeps auto-fit after selecting a visible node`, async ({
    page,
  }) => {
    const fixture = await openPacking(page);
    await page.getByRole("button", { name: mode, exact: true }).click();
    if (mode === "Vertical") await arranged(page, "0.5");
    await page.getByTestId(`agent-map-node-${fixture.nodes[0]!.id}`).click();
    const larger = agentMapPackingFixture(undefined, 2);
    await delta(
      page,
      [
        ...larger.nodes.slice(34).map((node) => ({ kind: "add-node", node })),
        ...larger.relationships
          .slice(13)
          .map((relationship) => ({ kind: "add-relationship", relationship })),
      ],
      2,
    );
    if (mode === "Vertical") await arranged(page, "0.25");
    await expect(page.locator(".agent-map-node")).toHaveCount(68);
    const automatic = await metrics(page);
    await page.getByRole("button", { name: "Fit Agent Map to view" }).click();
    expect((await metrics(page)).fit).toBe(automatic.fit);
  });
}

test("attaches aspect observation after a malformed map recovers", async ({
  page,
}) => {
  await page.goto("/e2e/agent-map-recovery.html?mapLayout=elk");
  for (const width of [600, 900]) {
    await expect(page.getByTestId("agent-map-layout-error")).toBeVisible();
    await page.getByRole("button", { name: "Repair map" }).click();
    await page.locator("#map").evaluate((el, width) => {
      el.style.width = `${width}px`;
    }, width);
    await arranged(page, width === 600 ? "0.75" : "1");
    await expect(page.locator(".agent-map-node")).toHaveCount(34);
    await page.getByRole("button", { name: "Break map" }).click();
  }
});
