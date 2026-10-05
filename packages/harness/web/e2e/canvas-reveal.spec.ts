/**
 * An agent's board shows the moment its entered page opens, with no manual
 * render step. The pane beside a session, and its user-owned open/closed
 * state, are gone (flow-map-chat-overlay.md §5); the entered agent page is
 * the interim way into an agent's board until the agent modal. All mock mode.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { openAgentCanvas } from "./mock-navigation";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("an agent's entered page shows its board on load — no manual open", async ({ page }) => {
  await openAgentCanvas(page, "acme-app", "leasing");
  await expect(
    page.getByTestId("project-map-pane").locator(".canvas-iframe"),
  ).toBeVisible();
});
