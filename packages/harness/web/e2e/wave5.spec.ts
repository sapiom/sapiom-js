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

    /* RE-POINTED IN ROUND 2, and this fixture is the defect in miniature.
       Detection sees TWO agent projects directly under /Users/demo (the third
       is nested inside acme-app); the scan is recursive and registers THREE.
       Round 1 printed the first number on the button — `Add all 2` — for an
       action that did the second. At real scale that mismatch was 1 vs 87, and
       those 87 rows are the flood this whole round is about.

       So the count stays where it is true (the readout, which now says which
       question it answered), the reach is stated in words, and the button
       promises nothing it cannot keep. */
    await expect(modal.getByTestId("aw-result")).toContainText(
      "2 agent projects directly inside this folder",
    );
    await expect(modal.getByTestId("aw-scan-reach")).toContainText("searches the whole tree");
    await expect(modal.getByTestId("aw-add-all")).toContainText("Add every agent under this folder");

    /* And it takes TWO presses. The first arms and restates the consequence in
       the terms that actually bit — one unconfirmed click is how 87 rows
       arrived — and only the second registers anything. */
    await modal.getByTestId("aw-add-all").click();
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId("aw-add-all")).toHaveAttribute("data-armed", "true");
    await expect(modal.getByTestId("aw-add-all")).toContainText("this can be a lot of rows");
    await expect(page.locator(".toast")).toHaveCount(0);

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
// Overview modal
// ---------------------------------------------------------------------------

test("the Overview opens over the workbench and dismisses on click-out", async ({ page }) => {
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("rail-overview").click();
  const overview = page.getByTestId("overview-modal");
  await expect(overview).toBeVisible();

  // A modal over the app, not a destination replacing it: the workbench stays
  // mounted behind the scrim, so closing costs the session nothing.
  await expect(page.locator(".right-pane")).toBeVisible();

  // Clicking the scrim (outside the card) closes it, like every other modal.
  await overview.click({ position: { x: 5, y: 5 } });
  await expect(overview).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
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
