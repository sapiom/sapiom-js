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
// Add dialog: scaffold, scan, registry picker, MCP prompts
// ---------------------------------------------------------------------------

test.describe("add to Studio (detection-driven)", () => {
  test("a non-existent folder offers the scaffold action, which starts a session and prompts the agent", async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    const modal = page.locator(".modal-start");
    await expect(modal).toBeVisible();

    // Detection is reactive — no "Continue": the action appears once the picker
    // resolves the typed path.
    await modal.getByTestId("dir-picker-input").fill("/Users/demo/brand-new-agent");

    // A folder that doesn't exist can't be registered — only created.
    await expect(modal.getByTestId("aw-result")).toContainText("doesn't exist yet");
    await expect(modal.getByTestId("aw-add")).toHaveCount(0);
    await expect(modal.getByTestId("aw-add-anyway")).toHaveCount(0);

    await modal.getByTestId("aw-scaffold-here").click();
    await expect(modal).toBeHidden();

    // The new session is live and the scaffold prompt reached its pty.
    await expect(page.getByTestId("session-context-title")).toContainText("brand-new-agent");
    await page.waitForFunction(() => {
      const test = (window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: { req: { text: string } } } })
        .__HARNESS_TEST__;
      return test?.lastInjectInput?.req.text.includes("sapiom_dev_agents_scaffold") ?? false;
    });
    const scaffoldPrompt = await page.evaluate(() =>
      (window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: { req: { text: string } } } })
        .__HARNESS_TEST__?.lastInjectInput?.req.text,
    );
    expect(scaffoldPrompt).toContain(
      '{"dir":"/Users/demo/brand-new-agent","template":"default"}',
    );
    expect(scaffoldPrompt).toContain("define the first agent");
    expect(scaffoldPrompt?.toLowerCase()).not.toContain("workflow");
  });

  test("a root holding several projects offers to add them all, and toasts the count", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    const modal = page.locator(".modal-start");
    await modal.getByTestId("dir-picker-input").fill("/Users/demo");

    // Bulk discovery is no longer a permanent button: it is what the dialog
    // OFFERS once the picked folder turns out to contain projects. Two of the
    // three fixture workflows sit directly under /Users/demo (the third is
    // nested in acme-app), so that is what detection reports here.
    await expect(modal.getByTestId("aw-add-all")).toContainText("Add all 2");
    await modal.getByTestId("aw-add-all").click();
    await expect(modal).toBeHidden();
    // The scan itself is recursive, so it finds all three.
    await expect(page.locator(".toast")).toContainText("Found 3 agent projects.");
  });

  test("the MCP setup prompt is copyable and fires mcp.install", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("add-workspace").click();
    // Contextual now, not permanent: the offer exists only where it applies —
    // a folder that exists and has no Sapiom wiring.
    const modal = page.locator(".modal-start");
    await modal.getByTestId("dir-picker-input").fill("/Users/demo/scratch");

    const block = page.getByTestId("mcp-install");
    await expect(block).toBeVisible();

    const copyClaude = page.getByTestId("mcp-install-copy-claude-code");
    await copyClaude.click();
    await expect(copyClaude).toHaveText("Copied");

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("claude mcp add sapiom");

    // The analytics event rode POST /api/track (intercepted in mock mode).
    const events = await page.evaluate(
      () =>
        (window as unknown as { __HARNESS_TEST__?: { trackEvents?: { event: string }[] } }).__HARNESS_TEST__
          ?.trackEvents ?? [],
    );
    expect(events.some((e) => e.event === "mcp.install")).toBe(true);
  });

  test("the harness picker renders from the adapter registry", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    // The agent picker shows only in session-starting states — point at a folder
    // that scaffolds so it appears.
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch/new-agent");
    const trigger = page.getByTestId("harness-select");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("Claude Code");

    // The mock registry mirrors the upstream adapter list: five entries in
    // registry order, claude-code first.
    await trigger.click();
    const menu = page.getByTestId("harness-select-menu");
    const rows = menu.getByRole("menuitemradio");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("Claude Code");

    // The active row carries its leading check and no suffix text; adapters
    // the Studio can't launch render disabled with the reason on hover.
    await expect(menu.getByTestId("harness-option-claude-code")).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByTestId("harness-option-pi")).toHaveAttribute("aria-disabled", "true");
    await expect(menu.getByTestId("harness-option-conductor")).toHaveAttribute("aria-disabled", "true");
    // A disabled row never takes the pick (force: Playwright itself refuses
    // aria-disabled targets — the click still lands on the DOM).
    await menu.getByTestId("harness-option-conductor").click({ force: true });
    await expect(menu.getByTestId("harness-option-conductor")).toHaveAttribute("aria-checked", "false");

    // Picking the other spawnable adapter closes the menu and updates the trigger.
    await menu.getByTestId("harness-option-codex").click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toContainText("Codex");
  });
});

// ---------------------------------------------------------------------------
// Recent-path chips
// ---------------------------------------------------------------------------

test("recent-path chips middle-truncate long paths and keep the full path in the tooltip", async ({ page }) => {
  await page.getByTestId("add-workspace").click();

  const chip = page.locator(".recent-dir-chip").first();
  await expect(chip).toHaveText("/Users/…/acme-app");
  await expect(chip).toHaveAttribute("title", "/Users/demo/acme-app");
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

  await page.getByTestId("add-workspace").click();

  const err = page.getByTestId("dir-picker-error");
  await expect(err).toBeVisible();
  const retry = page.getByTestId("dir-picker-retry");
  await expect(retry).toBeVisible();

  // The fault persists, so retrying lands back on the same honest error.
  await retry.click();
  await expect(page.getByTestId("dir-picker-error")).toBeVisible();
});
