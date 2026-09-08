import { expect, test } from "@playwright/test";
import {
  openDeploymentStudio,
  patch,
  rail,
  held,
  release,
  screenshot,
} from "./workflow-deployment.fixture";

test("list outages retain the cloud badge and background refreshes recover it", async ({
  page,
}) => {
  await openDeploymentStudio(page);
  await patch(page, {});
  await expect
    .poll(async () => (await rail(page)).getAttribute("data-deployment-state"))
    .toBe("ready");
  await patch(page, { failure: "list" });
  const cloud = await rail(page);
  await expect(cloud).toHaveAttribute("data-deployed", "true");
  await expect(cloud).toHaveAttribute("data-deployment-unavailable", "true");
  await expect(cloud).toHaveAttribute("data-deployment-state", "linked");
  await expect(cloud).toHaveAttribute("title", /last confirmed status/);
  await cloud.hover();
  await expect(page.locator(".app-tooltip")).toContainText(
    "last confirmed status",
  );
  await screenshot(page, "rail-retained");
  await patch(page, { failure: "none", ready: false });
  await expect(cloud).toHaveAttribute("data-deployed", "false");
  await expect(cloud).toHaveAttribute("data-deployment-unavailable", "false");
});

test("auth invalidation clears evidence before replacement lookup and rejects an old success", async ({
  page,
}) => {
  await openDeploymentStudio(page);
  await patch(page, {});
  await expect
    .poll(async () => (await rail(page)).getAttribute("data-deployment-state"))
    .toBe("ready");
  await patch(page, { delayList: true });
  await held(page);
  const cloud = await rail(page);
  await patch(
    page,
    { failure: "list" },
    { type: "auth.changed", authenticated: false, organizationName: null },
  );
  await expect(cloud).toHaveAttribute("data-deployed", "false");
  await expect(cloud).toHaveAttribute("title", "Deployment status unavailable");
  await release(page);
  await expect(cloud).toHaveAttribute("data-deployment-state", "linked");
});
