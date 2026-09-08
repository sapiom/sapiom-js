import { expect, test, type Page } from "@playwright/test";
import {
  openDeploymentStudio,
  patch,
  release,
  held,
  rail,
  screenshot,
  type DeploymentProbe,
  type DeploymentWindow,
} from "./workflow-deployment.fixture";
import type { HarnessApi } from "../src/lib/api";
import type { AgentMapImplementationsResponse } from "../../src/shared/agent-map";

type Probe = DeploymentProbe & {
  resolution: "bound" | "missing" | "unbound";
  revision: number;
  targets: number;
  bulks: number;
  delayBulk: boolean;
};
type TestWindow = DeploymentWindow & { __deployment: Probe };
const id = (n = 101) =>
  `node_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const node = (page: Page, n = 101) =>
  page.getByTestId(`agent-map-node-${id(n)}`);
const inspector = (page: Page) => page.getByTestId("agent-map-inspector");
async function open(page: Page) {
  const modulePath = await openDeploymentStudio(page, "&mockAgentMapGolden=1");
  await page.evaluate(async (modulePath) => {
    const { MockApi } = await import(modulePath);
    const prototype = MockApi.prototype as HarnessApi;
    const workflows = (await new MockApi().getState()).workflows;
    const bulk = prototype.getAgentMapImplementations;
    const target = prototype.getAgentMapNodeImplementation;
    const state = (window as TestWindow).__deployment;
    Object.assign(state, {
      resolution: "bound",
      revision: 1,
      targets: 0,
      bulks: 0,
      delayBulk: false,
    });
    prototype.getAgentMapImplementations = async function (projectId) {
      state.bulks++;
      if (state.failure === "bulk") throw new Error("offline");
      const response = await bulk.call(this, projectId);
      const first = response.bindings[0];
      state.workflowPath =
        workflows.find((row) =>
          row.studioBindings?.some(
            (binding) =>
              binding.projectId === projectId &&
              binding.agentId === first?.agentId,
          ),
        )?.path ?? "";
      const reply: AgentMapImplementationsResponse = {
        ...response,
        bindings: response.bindings.map((binding, index) => ({
          ...binding,
          revision: state.revision,
          resolution: index === 0 ? state.resolution : "unbound",
          agentId:
            index === 0 && state.resolution !== "unbound"
              ? binding.agentId
              : null,
        })),
      };
      if (state.delayBulk) {
        state.delayBulk = false;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      return reply;
    };
    prototype.getAgentMapNodeImplementation = function (...args) {
      state.targets++;
      return target.apply(this, args);
    };
  }, modulePath);
  const expand = page.getByTestId("rail-expand");
  if (await expand.isVisible()) await expand.click();
  await page.getByTestId("project-select-acme-app").click();
  await expect(node(page)).toHaveAttribute("data-deployment-state", "deployed");
  await expect(node(page)).toHaveAttribute(
    "data-deployment-unavailable",
    "false",
  );
}
async function evidence(page: Page) {
  return page.evaluate(() => {
    const calls = (window as TestWindow).__HARNESS_TEST__;
    return [
      "createSessionCalls",
      "resumeSessionCalls",
      "bindWorkflowCalls",
      "injectInputCalls",
    ].map((key) => (calls[key] as unknown[] | undefined)?.length ?? 0);
  });
}
test("mixed badges agree with the rail and inspector and refresh without changing the map", async ({
  page,
}) => {
  await open(page);
  await expect(node(page, 102)).toHaveAttribute(
    "data-deployment-state",
    "draft",
  );
  await expect(node(page, 106)).toHaveAttribute(
    "data-deployment-state",
    "draft",
  );
  for (const n of [103, 104, 105]) {
    await expect(node(page, n)).not.toHaveAttribute("data-deployment-state");
    await expect(node(page, n)).not.toHaveAccessibleName(
      /Draft|Deployed|Proposed/,
    );
  }
  await page.getByTestId(`agent-map-info-${id()}`).click();
  await expect(inspector(page).locator(".status-tag")).toHaveText("Deployed");
  await expect(await rail(page)).toHaveAttribute("data-deployed", "true");
  await page.getByTestId("canvas-expand").click();
  await screenshot(page, "desktop");
  const before = await evidence(page);
  const transform = await page
    .getByTestId("agent-map-subject")
    .getAttribute("style");
  await patch(page, { ready: false });
  await expect(node(page)).toHaveAttribute("data-deployment-state", "draft");
  await expect(inspector(page).locator(".status-tag")).toHaveText("Draft");
  await expect(await rail(page)).toHaveAttribute("data-deployed", "false");
  await patch(page, { ready: true });
  await expect(node(page)).toHaveAttribute("data-deployment-state", "deployed");
  expect(
    await page.getByTestId("agent-map-subject").getAttribute("style"),
  ).toBe(transform);
  expect(await evidence(page)).toEqual(before);
  expect(
    await page.evaluate(() => (window as TestWindow).__deployment.targets),
  ).toBe(0);
  await page.getByTestId("canvas-expand-exit").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("right-expand").click();
  await expect(inspector(page)).toBeVisible();
  await screenshot(page, "mobile");
});

for (const failure of ["bulk", "list", "nested"] as const) {
  test(`retains status during ${failure} failures and retries without reloading the graph`, async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId(`agent-map-info-${id()}`).click();
    await page.getByTestId("canvas-expand").click();
    const before = await evidence(page);
    const transform = await page
      .getByTestId("agent-map-subject")
      .getAttribute("style");
    await patch(page, { failure });
    await expect(node(page)).toHaveAttribute(
      "data-deployment-state",
      "deployed",
    );
    await expect(node(page)).toHaveAttribute(
      "data-deployment-unavailable",
      "true",
    );
    await expect(page.getByTestId("agent-map-deployment-error")).toContainText(
      "last confirmed status",
    );
    await expect(inspector(page)).toContainText("last confirmed status");
    expect(
      await page.getByTestId("agent-map-subject").getAttribute("style"),
    ).toBe(transform);
    if (failure === "list") {
      await expect(await rail(page)).toHaveAttribute("data-deployed", "true");
      await expect(await rail(page)).toHaveAttribute(
        "data-deployment-unavailable",
        "true",
      );
      await screenshot(page, "retained-error");
    }
    if (failure === "bulk") {
      await patch(page, { ready: false });
      await expect(node(page)).toHaveAttribute(
        "data-deployment-state",
        "draft",
      );
    }
    await patch(
      page,
      { failure: "none", ready: true },
      failure === "nested" ? { type: "workflows.changed" } : null,
    );
    if (failure !== "nested")
      await page
        .getByRole("button", { name: "Retry status", exact: true })
        .click();
    await expect(node(page)).toHaveAttribute(
      "data-deployment-unavailable",
      "false",
    );
    await expect(page.getByTestId("agent-map-deployment-error")).toHaveCount(0);
    expect(
      await page.getByTestId("agent-map-subject").getAttribute("style"),
    ).toBe(transform);
    expect(await evidence(page)).toEqual(before);
  });
}

test("an older bulk result cannot undo a rebind or a live map edit", async ({
  page,
}) => {
  await open(page);
  await patch(page, { delayBulk: true, resolution: "missing" });
  await held(page);
  await patch(
    page,
    { resolution: "unbound", revision: 2 },
    {
      type: "agent-map.proposal.changed",
      delta: {
        schemaVersion: 1,
        projectId: await page
          .getByTestId("agent-map-live")
          .getAttribute("data-project-id"),
        proposalId: "proposal_00000000-0000-7000-8000-000000000101",
        fromVersion: 1,
        version: 2,
        operationIds: ["operation_00000000-0000-7000-8000-000000009999"],
        operations: [
          {
            kind: "update-node",
            nodeId: id(),
            changes: { name: "Updated Research" },
          },
        ],
        actor: { userId: "user_mock", sessionId: "planner_mock" },
        acceptedAt: new Date().toISOString(),
      },
    },
  );
  await expect(node(page)).toHaveAttribute("data-deployment-state", "draft");
  await release(page);
  await expect(node(page)).toHaveAccessibleName(
    /Updated Research, agent, Draft/,
  );
  await patch(page, { resolution: "missing", revision: 3 });
  await expect(node(page)).not.toHaveAttribute("data-deployment-state");
  await expect(node(page)).toHaveAccessibleName(
    /Deployment status unavailable/,
  );
});

test("auth changes discard held ready responses and old display evidence", async ({
  page,
}) => {
  await open(page);
  await patch(page, { delayList: true });
  await held(page);
  await patch(
    page,
    { failure: "list" },
    { type: "auth.changed", authenticated: false, organizationName: null },
  );
  await expect(node(page)).not.toHaveAttribute("data-deployment-state");
  await release(page);
  await expect(node(page)).toHaveAccessibleName(
    /Deployment status unavailable/,
  );
  await expect(await rail(page)).toHaveAttribute("data-deployed", "false");
});

test("a held binding reply cannot carry a badge into another project", async ({
  page,
}) => {
  await open(page);
  await patch(page, { delayBulk: true });
  await held(page);
  const previousProject = await page
    .getByTestId("agent-map-live")
    .getAttribute("data-project-id");
  await patch(page, { resolution: "missing" }, null);
  await page.getByTestId("project-select-dashboard-keeper").click();
  await expect(page.getByTestId("agent-map-live")).not.toHaveAttribute(
    "data-project-id",
    previousProject!,
  );
  await expect(node(page)).toHaveAccessibleName(
    /Deployment status unavailable/,
  );
  await release(page);
  await expect(node(page)).not.toHaveAttribute("data-deployment-state");
});
