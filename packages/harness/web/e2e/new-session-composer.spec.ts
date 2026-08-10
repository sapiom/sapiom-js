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
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: { req?: { text?: string } } };
        }
      ).__HARNESS_TEST__?.lastInjectInput?.req?.text ?? "",
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

test("describing an outcome starts a session and hands the agent that outcome", async ({
  page,
}) => {
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

test("holds the prompt until the session is ready (Claude signed in), then sends it", async ({
  page,
}) => {
  // Make the next session never reach ready on its own — the stand-in for a
  // user still on Claude's login/onboarding screen, where SessionStart (and so
  // session.ready) never fires until they finish signing in.
  await page.addInitScript(() => {
    (window as unknown as { __MOCK_WITHHOLD_READY__?: boolean }).__MOCK_WITHHOLD_READY__ = true;
  });
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("rail-create-new").click();
  await page.getByTestId("composer-input").fill("Summarise my inbox every morning.");
  await page.getByTestId("composer-send").click();

  // The session exists (workbench shown) but the prompt is HELD, not injected,
  // because the session never became ready.
  await expect(page.getByTestId("agent-view")).toBeVisible();
  expect(await lastInjectText(page)).toBe("");

  // A hint appears pointing the user at the terminal login; the prompt is still
  // held while it shows.
  await expect(page.getByTestId("toast")).toContainText(/sign in to claude/i, {
    timeout: 8_000,
  });
  expect(await lastInjectText(page)).toBe("");

  // The user finishes signing in → the session reports ready → the held prompt
  // fires itself, carrying the original intent.
  await page.evaluate(() =>
    (
      window as unknown as { __HARNESS_TEST__?: { promoteReady?: () => void } }
    ).__HARNESS_TEST__?.promoteReady?.(),
  );
  await expect.poll(() => lastInjectText(page)).toContain("Summarise my inbox every morning.");
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
  // Manual override still works. The new session settles asynchronously (mock
  // create → running/ready promotion), and an expand click landing inside that
  // ~1s transition can be undone by the settle before it takes — a real CI
  // flake, not a broken affordance (the trace shows the pane open for a frame
  // then snap shut). The button stays offered, so retry until the pane holds
  // open, exactly as a user would; once the session is settled it sticks.
  await expect(async () => {
    if (
      (await page.locator(".right-pane").getAttribute("class"))?.includes(
        "is-collapsed",
      )
    ) {
      await page.getByTestId("right-expand").click();
    }
    await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/, {
      timeout: 1_500,
    });
  }).toPass({ timeout: 10_000 });
});

test("the new agent's folder appears in the rail at once and is never lost mid-creation", async ({
  page,
}) => {
  const groups = page.locator(".rail-list .workspace-group");
  const before = await groups.count();

  await page.getByTestId("rail-create-new").click();
  await page
    .getByTestId("composer-input")
    .fill("Diff competitor pricing pages every morning.");
  await page.getByTestId("composer-send").click();

  // It shows up immediately — before the session POST resolves and the workbench
  // settles — as a focusable "creating agent" placeholder, so switching away
  // mid-creation can never strand the in-progress agent.
  const pending = page.locator('[data-testid^="workspace-pending-"]').first();
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("aria-busy", "true");

  // And it stays: as the session lands the placeholder becomes a real folder
  // row — one more group than before, continuously present (no vanish/flicker).
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(groups).toHaveCount(before + 1);
});

test("Back returns to the session the composer was opened over", async ({
  page,
}) => {
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  await page.getByTestId("composer-back").click();
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
});

test("the agent selector lists the coding agents", async ({ page }) => {
  await page.getByTestId("rail-create-new").click();
  const select = page.getByTestId("composer-harness-select");
  await expect(select).toContainText("Claude Code");

  await select.click();
  await expect(page.getByTestId("composer-harness-menu")).toBeVisible();
  await expect(
    page.getByTestId("composer-harness-option-claude-code"),
  ).toBeVisible();
  await expect(page.getByTestId("composer-harness-option-codex")).toBeVisible();
});
