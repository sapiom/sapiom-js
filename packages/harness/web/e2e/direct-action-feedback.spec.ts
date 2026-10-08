/**
 * Feedback on the agent modal's direct verbs (flow-map-chat-overlay.md 4.2b,
 * 4.4b): Deploy reports in flight and lands on success or failure, and Run
 * (cloud) says why it is unavailable.
 */
import { expect, test, type Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";

async function load(page: Page, query = "?seed=0", project = "acme-app", agent = "leasing"): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openAgentModal(page, project, agent);
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
  const deploy = page.getByTestId("agent-modal-deploy");
  const progress = page.getByTestId("agent-modal-progress");
  await deploy.click();
  await expect(progress).toHaveAttribute("data-tone", /busy|done/);
  await expect(page.getByTestId("toast")).toContainText("Deployed to Sapiom.", { timeout: 5_000 });
  await expect(progress).toHaveText("Deployed");
  await expect(progress).toHaveAttribute("data-tone", "done");
  await expect(deploy).toBeEnabled();

  await load(page, "?seed=0&mockError=deploy");
  const failingDeploy = page.getByTestId("agent-modal-deploy");
  await failingDeploy.click();
  await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });
  await expect(page.getByTestId("agent-modal-progress")).toHaveAttribute("data-tone", "failed");
  await expect(page.getByTestId("agent-modal-progress")).toContainText("Deploy failed");
  await expect(failingDeploy).toBeEnabled();
});

test("a failed draft deploy keeps Cloud unavailable with a specific reason", async ({ page }) => {
  await load(page, "?seed=0&mockError=deploy", "rfq-agent", "rfq");
  const cloud = page.getByTestId("agent-modal-prod-run");
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("data-tooltip", "Not deployed yet");

  await page.getByTestId("agent-modal-deploy").click();
  await expect(page.getByTestId("toast")).toContainText("Deploy failed", { timeout: 5_000 });
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("data-tooltip", /Last deploy failed — retry Deploy/);
});

test("disconnect disables Deploy and Cloud but leaves the unified Local run available", async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await disconnect(page);
  await openAgentModal(page, "acme-app", "leasing");

  const deploy = page.getByTestId("agent-modal-deploy");
  await expect(deploy).toBeDisabled();
  await expect(deploy).toHaveAttribute("data-tooltip", /Connect your account first/);
  const cloud = page.getByTestId("agent-modal-prod-run");
  await expect(cloud).toBeDisabled();
  await expect(cloud).toHaveAttribute("data-tooltip", /Connect your account first/);
  await expect(page.getByTestId("agent-modal-run-local")).toBeEnabled();
});
