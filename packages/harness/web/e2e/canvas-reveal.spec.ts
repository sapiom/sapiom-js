/**
 * An agent's board shows the moment its modal opens, with no manual render
 * step. The pane beside a session, and its user-owned open/closed state, are
 * gone (flow-map-chat-overlay.md §5); the agent modal is the way into an
 * agent's board (4.2b). All mock mode.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("an agent's modal shows its board on load — no manual open", async ({ page }) => {
  await openAgentModal(page, "acme-app", "leasing");
  await expect(
    page.getByTestId("agent-modal-panel-canvas").locator(".canvas-iframe"),
  ).toBeVisible();
});
