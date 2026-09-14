import { expect, type Page } from "@playwright/test";
import path from "node:path";
import type { HarnessApi } from "../src/lib/api";

export type DeploymentProbe = {
  ready: boolean;
  failure: string;
  lists: number;
  workflowPath: string;
  delayList: boolean;
  release: (() => void) | null;
};
export type DeploymentWindow = Window & {
  __deployment: DeploymentProbe;
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    [key: string]: unknown;
  };
};
export const patch = (
  page: Page,
  value: Partial<DeploymentProbe> & Record<string, unknown>,
  event: unknown = { type: "workflows.changed" },
) =>
  page.evaluate(
    ({ value, event }) => {
      Object.assign((window as DeploymentWindow).__deployment, value);
      if (event) (window as DeploymentWindow).__HARNESS_TEST__.publish(event);
    },
    { value, event },
  );
export const release = (page: Page) =>
  page.evaluate(() => (window as DeploymentWindow).__deployment.release!());
export const held = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as DeploymentWindow).__deployment.release),
      ),
    )
    .toBe(true);

/** Exercise the real shared hook with controlled list responses and bus events. */
export async function openDeploymentStudio(page: Page, query = "") {
  await page.goto(
    `/?seed=0&mockFixtures=deep&mockStudioProjects=present${query}`,
  );
  await expect(page.getByTestId("session-context")).toBeVisible();
  return page.evaluate(async () => {
    const modulePath = performance
      .getEntriesByType("resource")
      .find(
        (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
      )!.name;
    const { MockApi } = await import(modulePath);
    const prototype = MockApi.prototype as HarnessApi;
    const list = prototype.listWorkflows;
    const state: DeploymentProbe = {
      ready: true,
      failure: "none",
      lists: 0,
      workflowPath: "",
      delayList: false,
      release: null,
    };
    (window as DeploymentWindow).__deployment = state;
    prototype.listWorkflows = async function () {
      state.lists++;
      const rows = (await list.call(this)).map((row) => ({
        ...row,
        definitionId: 42,
        activeBuildRunId: state.failure === "nested" ? null : "build-1",
        activeBuildRunStatus:
          state.failure === "nested"
            ? null
            : state.ready
              ? "ready"
              : "building",
        deploymentLookup: {
          lastConfirmedDeployed: state.ready,
          unavailable: state.failure === "nested",
        },
      }));
      state.workflowPath = rows[0]?.path ?? "";
      if (state.delayList) {
        state.delayList = false;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      } else if (state.failure === "list") throw new Error("offline");
      return rows;
    };
    return modulePath;
  });
}
export async function rail(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as DeploymentWindow).__deployment.workflowPath,
      ),
    )
    .not.toBe("");
  const workflowPath = await page.evaluate(
    () => (window as DeploymentWindow).__deployment.workflowPath,
  );
  return page.getByTestId(`workflow-status-${workflowPath}`);
}
export async function screenshot(page: Page, name: string) {
  if (process.env.SAP3085_SCREENSHOTS)
    await page.screenshot({
      path: path.resolve("../../.github/screenshots/SAP-3085", `${name}.png`),
      fullPage: true,
    });
}
