import { expect, test, type Page } from "@playwright/test";

import { focusRfqAgent } from "./mock-navigation";

async function load(page: Page, query = "?seed=0"): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("session-steps")).toBeVisible();
}

async function cloudTarget(page: Page) {
  await page.getByRole("button", { name: "Choose run target" }).click();
  return page.getByRole("menuitemradio", { name: /Cloud/ });
}

async function disconnect(page: Page): Promise<void> {
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("settings-trigger").click();
  await page.getByTestId("settings-disconnect-btn").click();
  await expect(page.getByTestId("settings-connect-btn")).toBeVisible();
  await page.keyboard.press("Escape");
}

test("Deploy pending feedback clears on both success and failure", async ({ page }) => {
  await load(page);
  const deploy = page.getByTestId("session-step-deploy");
  await deploy.click();
  await expect(deploy).toHaveAttribute("data-pending", "true");
  await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });
  await expect(deploy).not.toHaveAttribute("data-pending");

  await load(page, "?seed=0&mockError=deploy");
  const failingDeploy = page.getByTestId("session-step-deploy");
  await failingDeploy.click();
  await expect(failingDeploy).toHaveAttribute("data-pending", "true");
  await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });
  await expect(failingDeploy).not.toHaveAttribute("data-pending");
});

test("a failed draft deploy keeps Cloud unavailable with a specific reason", async ({ page }) => {
  await load(page, "?seed=0&mockError=deploy");
  await focusRfqAgent(page);
  await page.getByTestId("open-agent-start-session").click();

  let cloud = await cloudTarget(page);
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("title", /Not deployed yet/);
  await page.keyboard.press("Escape");

  await page.getByTestId("session-step-deploy").click();
  await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });
  cloud = await cloudTarget(page);
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("title", /Last deploy failed — retry Deploy/);
  await expect(page.getByTestId("session-step-deploy")).toHaveClass(/session-action-primary/);
});

test("disconnect disables Deploy and Cloud but leaves the unified Local run available", async ({ page }) => {
  await load(page);
  await disconnect(page);

  await expect(page.getByTestId("session-step-deploy")).toBeDisabled();
  await expect(page.getByTestId("session-step-deploy")).toHaveAccessibleName(/Connect your account first/);
  const cloud = await cloudTarget(page);
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("title", /Connect your account first/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-step-local")).toBeEnabled();
  await expect(page.getByTestId("session-step-local")).toHaveAccessibleName("Run using Local");
});

test("the split control reflects the real local execution lifetime", async ({ page }) => {
  await load(page);
  await page.getByTestId("session-step-local").click();
  await page.getByTestId("run-sheet-submit").click();
  const split = page.locator(".session-run-split");
  await expect(split).toHaveAttribute("data-running", "true", { timeout: 3_000 });
  await expect(page.locator(".run-workspace-status")).toContainText("Completed", { timeout: 8_000 });
  await expect(split).not.toHaveAttribute("data-running");
});
