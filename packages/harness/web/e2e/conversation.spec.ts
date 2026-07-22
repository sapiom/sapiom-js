/**
 * Conversation pane Playwright smoke tests — mock-mode UI (VITE_MOCK=1).
 *
 * The pane is a preview surface reached with `?pane=conversation` (mock only —
 * see api.isConversationPreview). It is the right-region Assistant ⇄ CLI slot
 * from SAP-1806: Assistant is the default, renders turns streamed from the mock
 * stream; CLI is the existing pty terminal, unchanged, one toggle away.
 *
 * Coverage:
 *   - Assistant is the default view; the CLI tab is present but inactive
 *   - The Assistant renders streamed turns (user prompt + streamed answer)
 *   - Toggling to CLI reveals the unchanged terminal and hides the Assistant
 *   - Toggling back keeps the already-streamed turns (panel is kept alive)
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?pane=conversation");
  await expect(page.getByTestId("conversation-pane")).toBeVisible();
});

test("Assistant is the default view; CLI is present but not active", async ({
  page,
}) => {
  await expect(page.getByTestId("conversation-tab-assistant")).toHaveClass(
    /is-active/,
  );
  await expect(page.getByTestId("conversation-tab-cli")).not.toHaveClass(
    /is-active/,
  );
  await expect(page.getByTestId("conversation-panel-assistant")).toBeVisible();
  // The terminal is not mounted until the CLI side is first revealed.
  await expect(page.locator(".harness-terminal")).toHaveCount(0);
});

test("the Assistant renders streamed turns from the mock stream", async ({
  page,
}) => {
  // The user's own prompt arrives whole; the assistant's answer streams in as
  // deltas and settles to a completed turn with accumulated content.
  const userTurn = page.getByTestId("assistant-turn-u1");
  await expect(userTurn).toContainText("What does this agent do?", {
    timeout: 5_000,
  });

  const assistantTurn = page.getByTestId("assistant-turn-a1");
  await expect(assistantTurn).toContainText("This agent", { timeout: 5_000 });
  // Once the stream closes the turn is marked complete (no more caret).
  await expect(assistantTurn).toHaveAttribute("data-status", "complete", {
    timeout: 5_000,
  });
  await expect(page.getByTestId("assistant-streaming")).toHaveCount(0);

  await page.screenshot({
    path: "web/e2e/screenshots/conversation-assistant.png",
    fullPage: true,
  });
});

test("toggling to CLI reveals the unchanged terminal and hides the Assistant", async ({
  page,
}) => {
  await page.getByTestId("conversation-tab-cli").click();

  await expect(page.getByTestId("conversation-tab-cli")).toHaveClass(
    /is-active/,
  );
  await expect(page.getByTestId("conversation-panel-cli")).toBeVisible();
  // The existing pty Terminal component, unchanged.
  await expect(page.locator(".harness-terminal")).toBeVisible();
  // The Assistant panel stays in the DOM (kept alive) but is not visible.
  await expect(page.getByTestId("conversation-panel-assistant")).toBeAttached();
  await expect(
    page.getByTestId("conversation-panel-assistant"),
  ).not.toBeVisible();

  await page.screenshot({
    path: "web/e2e/screenshots/conversation-cli.png",
    fullPage: true,
  });
});

test("toggling back to Assistant keeps the turns that already streamed", async ({
  page,
}) => {
  // Let the mock stream produce its turns first.
  await expect(page.getByTestId("assistant-turn-a1")).toContainText(
    "This agent",
    {
      timeout: 5_000,
    },
  );

  await page.getByTestId("conversation-tab-cli").click();
  await expect(page.locator(".harness-terminal")).toBeVisible();

  await page.getByTestId("conversation-tab-assistant").click();
  await expect(page.getByTestId("conversation-panel-assistant")).toBeVisible();
  // The turns were not torn down by the round-trip.
  await expect(page.getByTestId("assistant-turn-u1")).toContainText(
    "What does this agent do?",
  );
  await expect(page.getByTestId("assistant-turn-a1")).toContainText(
    "This agent",
  );
});
