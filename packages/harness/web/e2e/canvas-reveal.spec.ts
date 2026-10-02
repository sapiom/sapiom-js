/**
 * The right pane is the selected session's bound agent, and its open/closed
 * state is the USER's (flow-navigation.md 4.2.2, design.md I3). It used to
 * re-open itself the moment a render delivered a board and fold itself for an
 * empty one, which overwrote the user's choice on every probe; a closed pane
 * now stays closed through a live render, and the board inside it still
 * updates for when it is opened. All mock mode.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { startChatWithAgent } from "./mock-navigation";

// The mock bus test hook: simulate the server's canvas.reload for a session,
// the same event a finished render/build broadcasts.
const publishReload = (page: Page, sessionId: string): Promise<void> =>
  page.evaluate((id) => {
    (
      window as unknown as { __HARNESS_TEST__?: { publish?: (m: unknown) => void } }
    ).__HARNESS_TEST__?.publish?.({ type: "canvas.reload", harnessSessionId: id });
  }, sessionId);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("a populated session shows its board on load — no manual open", async ({ page }) => {
  // sess-boot ships a board and is the active session at boot, so the pane is
  // open straight away.
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});

test("a live render leaves a pane the user closed closed, and the board is there when it opens", async ({
  page,
}) => {
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
  await page.getByTestId("right-collapse").click();
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // The agent renders a board — a finished build, or any re-render.
  await publishReload(page, "sess-boot");
  // The assertion is the ABSENCE of a reveal, so it has to outlast the load.
  await page.waitForTimeout(750);
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // The user opens it, and the rendered board is in it.
  await page.getByTestId("right-expand").click();
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
  await expect(page.locator(".right-pane .canvas-iframe")).toBeVisible();
});

test("an empty board does not fold a pane the user left open", async ({ page }) => {
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
  // A new chat bound to an agent with no rendered board yet.
  await startChatWithAgent(page, "acme-app", "leasing");
  await page.waitForTimeout(750);
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});
