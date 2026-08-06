/**
 * The canvas pane follows the ACTIVE session's board: shown whenever the
 * session has one, and (re)opened the moment a live render delivers a board —
 * even a pane the user had collapsed. This is the simple "populated ⇒ shown"
 * contract that replaced the composer-only, one-shot auto-reveal, so a resumed
 * session that builds an agent (a canvas.reload arrives), or a switch to an
 * already-populated agent, shows its board without a manual open. All mock mode.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

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

test("a live render re-opens a pane the user had collapsed", async ({ page }) => {
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);

  // Fold it away to focus on the terminal.
  await page.getByTestId("right-collapse").click();
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // The agent renders a board — a finished build, or any re-render. The pane
  // pops back open on its own: content, once present, is shown. This is the
  // behaviour the old composer-only, one-shot reveal missed for a resumed
  // session.
  await publishReload(page, "sess-boot");
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});
