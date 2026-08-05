/**
 * Coverage — dialogs, palette, skills, error/empty states:
 *   - scaffold path from the add dialog's Project mode
 *   - palette section headers + fuzzy-match highlighting + past sessions
 *   - MCP install prompts surfaced (copy fires mcp.install)
 *   - registry-driven harness picker
 *   - scan-folder-for-agents bulk discovery
 *   - recent-path chips middle-truncate instead of hard-clipping
 *   - dead-session metadata + exited canvas state
 *   - no duplicated skill title, soft breaks stay one paragraph
 *   - retry affordances on skills detail + directory picker errors
 *   - overview mode shows the fresh-install canvas state
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

test.describe("command palette sections and highlighting", () => {
  test("mixed result types render under section headers, past sessions included", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    const list = page.getByTestId("command-palette-list");
    await expect(list).toBeVisible();

    // Fixed section order: Sessions, then Past sessions, Agents, Folders.
    const sections = page.getByTestId("command-palette-section");
    await expect(sections.first()).toHaveText("Sessions");
    await expect(sections.filter({ hasText: "Past sessions" })).toHaveCount(1);
    await expect(sections.filter({ hasText: "Agents" })).toHaveCount(1);
    await expect(page.getByTestId("command-palette-input")).toHaveAttribute(
      "placeholder",
      "Jump to a session, agent, or path…",
    );

    // The exited fixture session is reachable from the palette now.
    await expect(list).toContainText("Build the leasing pipeline");
  });

  test("the query's matched characters are bolded and name matches outrank path matches", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("leasing");

    const first = page.getByTestId("command-palette-item-0");
    await expect(first).toContainText("leasing");
    // The workflow's NAME carries the highlight (a label match), not just
    // its hidden path.
    await expect(first.locator(".command-palette-item-label .palette-match").first()).toBeVisible();
  });

  test("activating a past session opens its review pane, never a silent resume", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("Build the leasing");
    await page.getByTestId("command-palette-item-0").click();

    // The exited registry session lands on the dead-session review pane.
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Add existing agents dialog: detection + bulk scan
// ---------------------------------------------------------------------------

test.describe("add existing agents (detection-driven)", () => {
  test("a root holding several projects offers to add them all, and toasts the count", async ({ page }) => {
    await page.getByTestId("add-existing-agents").click();
    const modal = page.locator(".modal-start");
    await modal.getByTestId("dir-picker-input").fill("/Users/demo");

    // Bulk discovery is what the dialog OFFERS once the picked folder turns out
    // to contain projects. Two of the three fixture workflows sit directly under
    // /Users/demo (the third is nested in acme-app), so that is what detection
    // reports here.
    await expect(modal.getByTestId("aw-add-all")).toContainText("Add all 2");
    await modal.getByTestId("aw-add-all").click();
    await expect(modal).toBeHidden();
    // The scan itself is recursive, so it finds all three.
    await expect(page.locator(".toast")).toContainText("Found 3 agent projects.");
  });
});

// ---------------------------------------------------------------------------
// Dead session context
// ---------------------------------------------------------------------------

test("the dead-session pane shows the record's real metadata and the canvas invites a resume", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  // Past sessions live in a flyout sub-card that opens on hover of its row.
  await page.getByTestId("past-sessions-trigger").hover();
  await expect(page.getByTestId("past-sessions-card")).toBeVisible();
  await page.getByTestId("exited-session-sess-leasing").click();

  const detail = page.getByTestId("dead-session-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Coding agent");
  await expect(detail).toContainText("Claude Code");
  await expect(detail).toContainText("Ended");

  // The right pane stops inviting a Visualize that cannot run.
  await expect(page.getByTestId("canvas-empty-exited")).toContainText("Session ended");
  await expect(page.getByTestId("canvas-empty-exited")).toContainText(
    "Resume the session to see the agent's diagram here.",
  );
  await expect(page.getByTestId("canvas-visualize-cta")).toHaveCount(0);

  await page.getByTestId("right-tab-steps").click();
  await expect(page.getByTestId("canvas-empty-exited")).toContainText(
    "Resume the session to see the agent's steps here.",
  );
});

// ---------------------------------------------------------------------------
// Overview mode canvas
// ---------------------------------------------------------------------------

test("the composer home hides the canvas, not showing the previous session's board", async ({
  page,
}) => {
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("rail-overview").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  // No canvas while composing — the previous session's board is not on show,
  // and there is nothing to Visualize because there is no session yet.
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);
  await expect(page.getByTestId("canvas-visualize-cta")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Directory picker error retry
// ---------------------------------------------------------------------------

test("the directory picker's read failure carries its own Retry", async ({ page }) => {
  await page.goto("/?mockError=listDir");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("add-existing-agents").click();

  const err = page.getByTestId("dir-picker-error");
  await expect(err).toBeVisible();
  const retry = page.getByTestId("dir-picker-retry");
  await expect(retry).toBeVisible();

  // The fault persists, so retrying lands back on the same honest error.
  await retry.click();
  await expect(page.getByTestId("dir-picker-error")).toBeVisible();
});
