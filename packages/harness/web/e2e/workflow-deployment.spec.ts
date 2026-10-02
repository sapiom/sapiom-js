/**
 * Deployment state beside a session: the right pane's cloud tag for the
 * session's bound agent.
 *
 * This file used to pin the rail agent row's cloud glyph (`workflow-status-*`).
 * Agents left the rail with their deploy glyphs (flow-navigation.md Q3,
 * design-eng D42), so the per-row glyph and its auth-invalidation tooltip are
 * gone with it; the map's own deployment indicator is pinned in
 * `agent-map-deployment.spec.ts`. What survives here is the right pane's tag,
 * driven by the same shared workflow list.
 */
import { expect, test } from "@playwright/test";
import { openDeploymentStudio, patch } from "./workflow-deployment.fixture";

const tag = (page: import("@playwright/test").Page) =>
  page.getByTestId("workflow-dashboard-link");

test("a list outage keeps the bound agent's cloud tag, and a refresh recovers it", async ({
  page,
}) => {
  await openDeploymentStudio(page);
  await patch(page, {});
  await expect(tag(page)).toHaveAttribute("data-deployment-state", "ready");
  await expect(tag(page)).toHaveText("deployed");

  // The outage never drops the tag: the last known link stays on screen.
  await patch(page, { failure: "list" });
  await expect(tag(page)).toHaveAttribute("data-deployment-state", "linked");

  // A later successful list brings the real state back.
  await patch(page, { failure: "none", ready: false });
  await expect(tag(page)).toHaveAttribute("data-deployment-state", "building");
  await patch(page, { failure: "none", ready: true });
  await expect(tag(page)).toHaveAttribute("data-deployment-state", "ready");
});
