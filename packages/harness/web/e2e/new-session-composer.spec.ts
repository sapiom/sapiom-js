/**
 * The composer-first "new session" home (NewSessionComposer): describe an
 * outcome (or pick a template) and a session starts, seeded with that outcome —
 * the same create+inject path the "start from an idea" door uses. The screen
 * then gives way to the terminal, and the canvas stays hidden until it has
 * content. All in mock mode; the injected prompt is recorded on
 * window.__HARNESS_TEST__.lastInjectInput.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const lastInjectText = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: { req?: { text?: string } } } })
        .__HARNESS_TEST__?.lastInjectInput?.req?.text) ?? "",
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("Create new opens the composer with no terminal or canvas, and a chip prefills the box", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  // No terminal, no canvas while composing.
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // A quick-idea chip prefills the box (editable), it doesn't submit.
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveValue("");
  await page.getByTestId("composer-chip-research-digest").click();
  await expect(input).toHaveValue(/digest/i);
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
});

test("describing an outcome starts a session and hands the agent that outcome", async ({ page }) => {
  await page.getByTestId("rail-create-new").click();
  await page
    .getByTestId("composer-input")
    .fill("Diff our competitors' pricing pages every morning.");
  await page.getByTestId("composer-send").click();

  // The composer gives way to the live workbench (a new session).
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();

  // The typed outcome rode into the scaffold prompt handed to the agent.
  await expect
    .poll(() => lastInjectText(page))
    .toContain("Diff our competitors' pricing pages");
});

test("a new session opens terminal-only; the canvas stays hidden until it has content", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
  await page.getByTestId("composer-input").fill("Build a small thing.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("agent-view")).toBeVisible();

  // Terminal-only: a fresh mock session has no bundled doc, so the auto-reveal
  // never fires and the pane stays collapsed — but the manual show is offered.
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);
  await expect(page.getByTestId("right-expand")).toBeVisible();
  // Manual override still works both ways.
  await page.getByTestId("right-expand").click();
  await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/);
});

test("Back returns to the session the composer was opened over", async ({ page }) => {
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  await page.getByTestId("composer-back").click();
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
});

test("the agent selector lists the coding agents", async ({ page }) => {
  await page.getByTestId("rail-create-new").click();
  const select = page.getByTestId("composer-harness-select");
  await expect(select).toContainText("Claude Code");

  await select.click();
  await expect(page.getByTestId("composer-harness-menu")).toBeVisible();
  await expect(page.getByTestId("composer-harness-option-claude-code")).toBeVisible();
  await expect(page.getByTestId("composer-harness-option-codex")).toBeVisible();
});
