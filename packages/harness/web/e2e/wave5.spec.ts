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

    // Fixed section order: Sessions, then Past sessions, Workflows, Folders.
    const sections = page.getByTestId("command-palette-section");
    await expect(sections.first()).toHaveText("Sessions");
    await expect(sections.filter({ hasText: "Past sessions" })).toHaveCount(1);
    await expect(sections.filter({ hasText: "Workflows" })).toHaveCount(1);

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

test.describe("add dialog (Project mode)", () => {
  test("a non-existent folder offers the scaffold action, which starts a session and prompts the agent", async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    const modal = page.locator(".modal-add-workspace");
    await expect(modal).toBeVisible();

    await modal.getByTestId("dir-picker-input").fill("/Users/demo/brand-new-agent");
    const cta = modal.getByTestId("modal-scaffold-cta");
    await expect(cta).toBeVisible();
    await expect(modal.getByRole("button", { name: "Add project" })).toBeDisabled();

    await cta.click();
    await expect(modal).toBeHidden();

    // The new session is live and the scaffold prompt reached its pty.
    await expect(page.getByTestId("session-context-title")).toContainText("brand-new-agent");
    await page.waitForFunction(() => {
      const test = (window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: { req: { text: string } } } })
        .__HARNESS_TEST__;
      return test?.lastInjectInput?.req.text.includes("sapiom agents init") ?? false;
    });
  });

  test("scan folder for agents registers everything under the root and toasts the count", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    const modal = page.locator(".modal-add-workspace");
    await modal.getByTestId("dir-picker-input").fill("/Users/demo");

    await modal.getByTestId("modal-scan-btn").click();
    await expect(modal).toBeHidden();
    // All three fixture workflows live under /Users/demo.
    await expect(page.locator(".toast")).toContainText("Found 3 agent projects.");
  });

  test("the MCP setup prompts are copyable and fire mcp.install", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("add-workspace").click();
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
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("new-session-btn").click();
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
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();

  const chip = page.locator(".recent-dir-chip").first();
  await expect(chip).toHaveText("/Users/…/acme-app");
  await expect(chip).toHaveAttribute("title", "/Users/demo/acme-app");
});

// ---------------------------------------------------------------------------
// Dead session context
// ---------------------------------------------------------------------------

test("the dead-session pane shows the record's real metadata and the canvas invites a resume", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("exited-session-sess-leasing").click();

  const detail = page.getByTestId("dead-session-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Agent");
  await expect(detail).toContainText("Claude Code");
  await expect(detail).toContainText("Ended");

  // The right pane stops inviting a Visualize that cannot run.
  await expect(page.getByTestId("canvas-empty-exited")).toContainText("Session ended");
  await expect(page.getByTestId("canvas-visualize-cta")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Overview mode canvas
// ---------------------------------------------------------------------------

test("overview mode shows the fresh-install canvas state, not the previous session's empty state", async ({
  page,
}) => {
  await page.getByTestId("brand-identity").click();
  await page.getByTestId("rail-overview").click();
  await expect(page.getByTestId("welcome-panel")).toBeVisible();

  await expect(page.locator(".canvas-empty")).toContainText("Start a session to see its canvas here.");
  await expect(page.getByTestId("canvas-visualize-cta")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Skills detail
// ---------------------------------------------------------------------------

test.describe("skills detail", () => {
  test("the body drops its duplicate H1 and soft breaks stay one paragraph", async ({ page }) => {
    await page.getByTestId("right-tab-skills").click();
    await page.getByTestId("skill-card-frontend-design").click();

    const detail = page.getByTestId("skill-detail");
    await expect(detail).toBeVisible();
    // The header names the skill; the body must not repeat it as an H1.
    await expect(detail.locator(".skill-detail-body h1")).toHaveCount(0);
    // The fixture's soft-broken sentence renders as ONE paragraph.
    const paragraph = detail.locator(".chat-paragraph", { hasText: "aesthetic direction" });
    await expect(paragraph).toContainText("(component, page, or application) and describe");
  });

  test("a failed detail fetch offers a Retry alongside the back affordance", async ({ page }) => {
    await page.goto("/?mockError=skill");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-skills").click();
    await page.getByTestId("skill-card-code-review").click();

    const errorView = page.getByTestId("skill-detail-error");
    await expect(errorView).toBeVisible();
    await expect(errorView).toContainText("Could not load this skill");

    // Retry refires the fetch (still failing here — the error state stays,
    // which is the honest outcome while the fault persists).
    await page.getByTestId("skill-detail-retry").click();
    await expect(page.getByTestId("skill-detail-error")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Directory picker error retry
// ---------------------------------------------------------------------------

test("the directory picker's read failure carries its own Retry", async ({ page }) => {
  await page.goto("/?mockError=listDir");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();

  const err = page.getByTestId("dir-picker-error");
  await expect(err).toBeVisible();
  const retry = page.getByTestId("dir-picker-retry");
  await expect(retry).toBeVisible();

  // The fault persists, so retrying lands back on the same honest error.
  await retry.click();
  await expect(page.getByTestId("dir-picker-error")).toBeVisible();
});
