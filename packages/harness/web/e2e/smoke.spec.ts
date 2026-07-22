/**
 * Mock-mode UI smoke test — runs against `vite dev` with VITE_MOCK=1 (see
 * playwright.config.ts), no harness server required. Fixtures live in
 * ../src/lib/mock-data.ts: 3 workflows (one deployed), a running "boot"
 * session (the server auto-creates one at launch), a second running
 * background session ("scratch", not the active tab on load — demonstrates
 * the tab strip and busy pulse), and 2 exited sessions kept around as
 * resumable history, 5 macros, and a small fake filesystem for the
 * new-session directory picker.
 */
import { expect, test } from "@playwright/test";

// The mock demo seeds a run + auto-plays the chat conversation on load (see
// the demo spec). These smoke tests exercise mechanics from a clean slate, so
// they opt out with ?seed=0 — the seeded end-state has its own coverage.
test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("renders the three panes plus the brand header, with no separate action rail", async ({ page }) => {
  await expect(page.locator(".brand-header")).toBeVisible();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeVisible();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".canvas-pane")).toBeVisible();

  // The action rail is retired — actions live on the selected workflow's
  // inline macro row in the rail, not in a standalone column.
  await expect(page.locator(".rail-actions")).toHaveCount(0);

  await page.screenshot({ path: "web/e2e/screenshots/app-shell.png", fullPage: true });
});

test("viewport-locked shell: the page never scrolls even when terminal content overflows", async ({ page }) => {
  // Simulate a terminal that's rendered far more than the pane can show —
  // injected as a raw sibling in .terminal-slot (bypassing Terminal.tsx's own
  // overflow:hidden wrapper) so this also exercises the grid/flex containment
  // chain above it (.app, .center-pane), not just the terminal's own clipping.
  await page.evaluate(() => {
    const slot = document.querySelector(".terminal-slot");
    const filler = document.createElement("div");
    filler.setAttribute("data-testid", "scroll-stress-filler");
    filler.style.height = "6000px";
    slot?.appendChild(filler);
  });

  const root = await page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(root.scrollHeight).toBe(root.clientHeight);
});

test("theme: defaults to dark, toggles to light, and the choice persists across reload", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "web/e2e/screenshots/theme-dark.png", fullPage: true });

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "web/e2e/screenshots/theme-light.png", fullPage: true });

  await page.reload();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test.describe("theme — system preference", () => {
  // The design-eng skin boots dark by default (matching the draft-1 reference)
  // regardless of the OS scheme, until the user makes an explicit choice.
  test.use({ colorScheme: "light" });

  test("defaults to dark even when the system prefers light, absent a stored choice", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test("brand header shows the Sapiom wordmark and the demo-workspace identity", async ({ page }) => {
  await expect(page.locator(".brand-name")).toHaveText("Sapiom");
  await expect(page.locator(".brand-product")).toHaveText("Studio");
  // Mock mode is the static demo build: it must never claim a connected
  // Sapiom account — the identity chip reads "Demo workspace" instead.
  const identity = page.getByTestId("brand-identity");
  await expect(identity).toContainText("Demo workspace");
  await expect(page.locator(".identity-dot")).toHaveAttribute("data-authenticated", "false");
});

test("auto-selects the running boot session on initial load", async ({ page }) => {
  // The server auto-creates a session in launchDir at boot — the app should
  // never open to an empty terminal pane.
  await expect(page.locator(".terminal-empty")).toHaveCount(0);
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");
  await expect(header.locator(".session-dot")).toHaveAttribute("data-status", "running");
});

test("session header: compact identity (name only; path in the tooltip); New session opens from the rail's history menu", async ({
  page,
}) => {
  const header = page.getByTestId("session-context");
  const title = header.getByTestId("session-context-title");
  await expect(title).toContainText("acme-app");
  // The full path never renders inline (it would bleed) — it lives in the
  // hover tooltip alongside the workspace label.
  await expect(header).not.toContainText("/Users/demo/acme-app");
  await expect(title).toHaveAttribute("data-tooltip", /\/Users\/demo\/acme-app/);

  await page.screenshot({ path: "web/e2e/screenshots/session-header.png" });

  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();
  await expect(page.locator(".modal-new-session")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("Cmd/Ctrl+1..9 selects the nth tab of the focused agent", async ({ page }) => {
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");

  // Leasing is focused on load and carries two tabs, oldest-first: boot is 1,
  // the second leasing session is 2 — Cmd+2 jumps straight to it.
  await page.keyboard.press("Meta+2");
  await expect(header).toHaveAttribute("data-session-id", "sess-leasing-2");

  await page.keyboard.press("Meta+1");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");
});

test("a background tab shows a busy pulse that clears once output goes quiet", async ({ page }) => {
  // mock-data's MOCK_ACTIVITY_SESSION_ID ("sess-leasing-2") gets one simulated
  // session.activity ping shortly after load — see lib/events.ts. It is the
  // focused agent's SECOND (background) tab, so the pulse shows on that tab
  // while boot stays the active one — activity you are not looking at.
  const busyTab = page.getByTestId("session-tab-busy-sess-leasing-2");
  await expect(busyTab).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
  await page.screenshot({ path: "web/e2e/screenshots/session-tab-busy.png" });

  // The busy window (3s) clears once no further activity arrives — the tab
  // returns to its plain live dot.
  await expect(busyTab).toHaveCount(0, { timeout: 6_000 });
});

test("Overview heads the account menu, shows the intro panel, and any session leaves it", async ({ page }) => {
  // Reference material lives in the account menu now, not as a pinned rail
  // row — one click deep but always available, not just on first run.
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  const item = page.getByTestId("rail-overview");
  await expect(item).toBeVisible();
  await item.click();

  // Selection closes the menu and swaps the main slot to the intro.
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);
  await expect(page.getByTestId("welcome-panel")).toBeVisible();
  await expect(page.getByTestId("session-context-title")).toHaveText("Overview");
  // No session options while the intro is up — destructive actions beside
  // "Overview" would read as closing the view.
  await expect(page.getByTestId("session-menu")).toHaveCount(0);

  // Reopening the menu shows the current selection, then Escape closes it.
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("rail-overview")).toHaveClass(/is-selected/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("profile-menu")).toHaveCount(0);

  // Opening the leasing agent returns to the terminal — acme-app's one live
  // session is bound to it, so opening the agent attaches to that session.
  await page.getByTestId("workflow-leasing").locator(".workflow-item-trigger").click();
  await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
});

test("creation IA: the rail + adds projects; the tab strip + adds a session to the focused agent", async ({
  page,
}) => {
  // The rail's + is the PROJECT entry: the dialog opens in Project mode with
  // no mode tabs at all — the entry point fixed the intent (docs/IA.md).
  await page.getByTestId("add-workspace").click();
  const modal = page.locator(".modal-add-workspace");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".modal-header")).toContainText("Add project");
  await expect(modal.getByTestId("add-mode-session")).toHaveCount(0);
  await expect(modal.getByTestId("add-mode-project")).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Add project" })).toBeVisible();
  await expect(modal.getByTestId("harness-select")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toHaveCount(0);

  // Session creation lives in the tab strip: the trailing + opens a NEW
  // session on the focused agent (leasing), no dialog. Leasing has two tabs
  // on load; the + makes it three, and the new one becomes active.
  const newTab = page.getByTestId("session-tab-new");
  await expect(newTab).toHaveAttribute("aria-label", "New session on leasing");
  await expect(page.locator(".session-tab")).toHaveCount(2);
  await newTab.click();
  await expect(page.locator(".session-tab")).toHaveCount(3);
  await expect(page.getByTestId("session-workflow-chip")).toContainText("leasing");
  // No dialog — the + is a direct action.
  await expect(page.locator(".modal-new-session")).toHaveCount(0);
});

test("workflows rail lists the fixtures and the FOCUSED one drives macro gating", async ({ page }) => {
  await expect(page.locator(".workflow-item")).toHaveCount(3);

  // "leasing" is deployed (has a definitionId) and is the focused agent /
  // active tab's binding — the deploy-link macro is live.
  const openProd = page.getByTestId("macro-open_prod");
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  await expect(openProd).toBeEnabled();

  // Focusing "rfq" (no live session) does NOT rebind the boot session or start
  // one silently — the main panel shows the honest "start a session" state, so
  // there is no macro bar to gate yet.
  await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
  await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-focused/);
  await expect(page.getByTestId("open-agent-empty")).toContainText("No running session for rfq");
  await expect(openProd).toHaveCount(0);

  // Starting the session binds rfq (undeployed) and brings the macro bar live,
  // now gated with a reason distinct from "no workflow selected".
  await page.getByTestId("open-agent-start-session").click();
  await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");
  await expect(openProd).toBeDisabled();
  await expect(openProd).toHaveAttribute("aria-label", "Open prod: Not deployed yet");

  // The gating reason survives the disabled state through the app tooltip
  // (data-tooltip) and the aria-label above — no hover-reveal panel involved.
  await expect(openProd).toHaveAttribute("data-tooltip", "Open prod: Not deployed yet");
  await page.screenshot({ path: "web/e2e/screenshots/workflow-macros-gated.png" });
});

test("inject macros are enabled once the boot session and a deployed workflow are active", async ({ page }) => {
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  await expect(page.getByTestId("session-step-local")).toBeEnabled();
  await expect(page.getByTestId("session-step-deploy")).toBeEnabled();
});

test.describe("three-zone IA (rail explorer, tab strip, right pane)", () => {
  test("rail is workspace > agent only, with no session rows", async ({ page }) => {
    // Zone 1 is a pure explorer: workspace folder headers and agent rows, no
    // sessions anywhere in the tree.
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("workspace-group-rfq-workflows")).toBeVisible();
    await expect(page.getByText("No workspace")).toBeVisible();

    // Agents carry a deployed/draft cloud state; no session dot, no expander.
    await expect(page.getByTestId("workflow-status-leasing")).toHaveAttribute("data-deployed", "true");
    await expect(page.getByTestId("workflow-status-rfq")).toHaveAttribute("data-deployed", "false");
    await expect(page.locator("[data-testid^='workflow-session-dot-']")).toHaveCount(0);
    await expect(page.locator("[data-testid^='workflow-expander-']")).toHaveCount(0);
    await expect(page.locator("[data-testid^='rail-session-']")).toHaveCount(0);

    // A folder with live sessions but no agent (scratch) is the one focusable
    // folder row — its sessions live in the tab strip, not the rail.
    await expect(page.getByTestId("workspace-focus-scratch")).toBeVisible();

    // Exactly one filled selection: the focused agent (leasing on load).
    await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
    await expect(
      page.locator(".rail-list .workflow-item.is-focused, .rail-list .workspace-row.is-selected"),
    ).toHaveCount(1);

    await page.screenshot({ path: "web/e2e/screenshots/rail-explorer.png", fullPage: true });
  });

  test("focusing an agent with sessions shows a tab strip with the right count", async ({ page }) => {
    // Leasing is focused on load and carries two live sessions — the tab strip
    // shows both, active tab first (sess-boot). Each tab is closable.
    await expect(page.getByTestId("session-tabs")).toBeVisible();
    await expect(page.locator(".session-tab")).toHaveCount(2);
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveClass(/is-active/);
    await expect(page.getByTestId("session-tab-close-sess-boot")).toHaveAttribute("aria-label", /Close /);
    await expect(page.getByTestId("session-tab-new")).toBeVisible();
    await page.screenshot({ path: "web/e2e/screenshots/session-tab-strip.png", fullPage: true });
  });

  test("clicking a tab switches the active session AND the right panel", async ({ page }) => {
    // Zone 3 keys off the active tab. sess-boot ships a bundled doc (board);
    // the second leasing session ships none (empty state) — so the right pane
    // visibly swaps between them.
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    await page.getByTestId("session-tab-main-sess-leasing-2").click();
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-leasing-2");
    await expect(page.getByTestId("session-tab-sess-leasing-2")).toHaveClass(/is-active/);
    await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");

    // The Steps projection follows the same active tab.
    await page.getByTestId("right-tab-steps").click();
    await expect(page.locator(".canvas-empty")).toContainText("No steps yet");

    // Back to the board tab and the right pane returns to the board.
    await page.getByTestId("session-tab-main-sess-boot").click();
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("the + opens a new session tab on the focused agent", async ({ page }) => {
    await expect(page.locator(".session-tab")).toHaveCount(2);
    await page.getByTestId("session-tab-new").click();

    // A third tab joins, bound to the same agent, and becomes active.
    await expect(page.locator(".session-tab")).toHaveCount(3);
    await expect(page.getByTestId("session-workflow-chip")).toContainText("leasing");
    await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  });

  test("closing the active tab confirms, then falls back to another tab", async ({ page }) => {
    // Ending a session kills a PTY, so the × opens the shared confirm first.
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
    await page.getByTestId("session-tab-close-sess-boot").click();
    const confirm = page.getByTestId("end-session-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("kills the live terminal");

    // Keep cancels — nothing dies, the tab stays.
    await page.getByRole("button", { name: "Keep session" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator(".session-tab")).toHaveCount(2);

    // Confirming ends the active tab; the workbench falls back to the other
    // leasing tab, which is now active.
    await page.getByTestId("session-tab-close-sess-boot").click();
    await page.getByTestId("end-session-confirm-btn").click();
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(0);
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-leasing-2");
    await expect(page.locator(".session-tab")).toHaveCount(1);
    // Leasing stays focused throughout — closing a tab never moves the rail.
    await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  });

  test("focusing an agent with no session shows the start empty state", async ({ page }) => {
    // rfq-workflows has no live session in the fixtures, so focusing rfq cannot
    // render a board (the canvas is served per session). The workbench names
    // the absence and offers the one move; no tab strip renders.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-focused/);
    await expect(page.getByTestId("session-tabs")).toHaveCount(0);

    const start = page.getByTestId("open-agent-empty");
    await expect(start).toContainText("No running session for rfq");
    await expect(start).toContainText("Start a session to map, run, and inspect this agent.");
    await expect(page.getByTestId("open-agent-start-session")).toBeVisible();

    // The session bar names the same agent with an honest "no session" tag, and
    // the right pane echoes the state instead of another agent's board.
    await expect(page.getByTestId("session-context-title")).toHaveText("rfq");
    await expect(page.getByTestId("session-status-tag")).toContainText("no session");
    await expect(page.getByTestId("canvas-empty-no-session")).toContainText("No running session for rfq");

    // Focusing rfq never touched the boot session's binding.
    await expect(
      page.locator(".rail-list .workflow-item.is-focused, .rail-list .workspace-row.is-selected"),
    ).toHaveCount(1);

    // Start runs the create+bind path in rfq's OWN folder (never borrowing the
    // acme-app session), and the workbench goes live.
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-context-title")).toHaveText("rfq-workflows");
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.locator(".session-tab")).toHaveCount(1);
  });

  test("the mapping invariant: focused agent == active tab's agent == right-panel subject", async ({
    page,
  }) => {
    // On load: rail focuses leasing, the active tab is bound to leasing, and
    // the right pane renders leasing's board.
    await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
    await expect(page.getByTestId("session-workflow-chip")).toContainText("leasing");
    await expect(page.getByTestId("workflow-actions-header")).toContainText("leasing");
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // Focus rfq and start its session: all four move together to rfq.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-focused/);
    await expect(page.getByTestId("workflow-leasing")).not.toHaveClass(/is-focused/);
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");
    await expect(page.getByTestId("workflow-actions-header")).toContainText("rfq");
    // Still exactly one filled row.
    await expect(
      page.locator(".rail-list .workflow-item.is-focused, .rail-list .workspace-row.is-selected"),
    ).toHaveCount(1);
  });

  test("session naming: rename from the header menu, persisted across reloads", async ({ page }) => {
    // Header ⋯ menu → Rename session: the title becomes an inline input.
    await page.getByTestId("session-menu").click();
    await page.getByTestId("session-rename").click();
    const input = page.getByTestId("session-rename-input");
    await expect(input).toHaveValue("acme-app");
    await input.fill("Leasing revamp");
    await input.press("Enter");
    await expect(page.getByTestId("session-context-title")).toHaveText("Leasing revamp");
    // The active tab's label follows the rename.
    await expect(page.getByTestId("session-tab-sess-boot")).toContainText("Leasing revamp");

    // Client-side persistence (docs/GAPS.md): survives a reload.
    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-context-title")).toHaveText("Leasing revamp");
  });

  test("the boot session's default binding shows a chip on load", async ({ page }) => {
    // Fixture: sess-boot is pre-bound to leasing, so the chip renders without
    // any interaction — useful for anyone eyeballing mock mode, not just tests.
    const chip = page.getByTestId("session-workflow-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("leasing");
  });

  test("the binding is per-session: an exited session under review shows no binding chip", async ({ page }) => {
    await expect(page.getByTestId("session-workflow-chip")).toContainText("leasing");

    // Select an exited session that never had anything bound (from the merged
    // past-sessions list) — it opens as a dead session with no binding chip.
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();
    await expect(page.getByTestId("session-workflow-chip")).toHaveCount(0);
  });
});

test("add project: the rail's + opens the same directory-picker dialog and registers the path", async ({ page }) => {
  await page.getByTestId("add-workspace").click();

  // Same dialog anatomy as new-session, its own identity: no harness picker,
  // workspace title and CTA.
  const modal = page.locator(".modal-add-workspace");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Add project");
  await expect(modal.getByTestId("harness-select")).toHaveCount(0);

  const input = modal.getByTestId("dir-picker-input");
  await input.fill("/Users/demo/scratch");
  await modal.getByRole("button", { name: "Add project" }).click();

  await expect(modal).toBeHidden();
  // The connected path joins the rail as a workspace-owned workflow row.
  await expect(page.getByTestId("workflow-scratch")).toBeVisible();
});

test("new-session modal: directory picker navigates and validates", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();
  await expect(page.locator(".modal-new-session")).toBeVisible();

  const startButton = page.getByRole("button", { name: "Start session" });
  const input = page.getByTestId("dir-picker-input");

  // Seeded from launchDir; browsing shows its subdirectories.
  await expect(input).toHaveValue("/Users/demo/acme-app");
  await expect(page.getByTestId("dir-picker-item-leasing")).toBeVisible();

  // Type-ahead: an unrecognized tail filters the nearest real ancestor's children.
  await input.fill("/Users/demo/rf");
  await expect(page.getByTestId("dir-picker-item-rfq-workflows")).toBeVisible();
  await expect(page.getByTestId("dir-picker-item-onboarding-flow")).toHaveCount(0);

  // Clicking a listed directory drills into it.
  await page.getByTestId("dir-picker-item-rfq-workflows").click();
  await expect(input).toHaveValue("/Users/demo/rfq-workflows");
  await expect(page.getByTestId("dir-picker-item-src")).toBeVisible();

  // "Up" walks to the parent.
  await page.getByTestId("dir-picker-up").click();
  await expect(input).toHaveValue("/Users/demo");
  await expect(page.getByTestId("dir-picker-item-acme-app")).toBeVisible();

  await page.screenshot({ path: "web/e2e/screenshots/new-session-modal.png" });

  await input.fill("");
  await expect(startButton).toBeDisabled();
  await input.fill("/tmp/example-project");
  await expect(startButton).toBeEnabled();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".modal-new-session")).toBeHidden();
});

test("new-session modal: a failed directory read shows an error, not an empty listing", async ({ page }) => {
  // ?mockError=listDir makes the filesystem probe reject.
  await page.goto("/?mockError=listDir&seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();
  await expect(page.locator(".modal-new-session")).toBeVisible();

  const err = page.getByTestId("dir-picker-error");
  await expect(err).toBeVisible({ timeout: 3_000 });
  await expect(err).toContainText("Couldn't read that directory");

  // On error the listing shows neither directory items nor the "no
  // subdirectories" empty — the error replaces both.
  await expect(page.getByTestId("dir-picker-item-leasing")).toHaveCount(0);
});

test("command palette: a failed path read shows an error but still offers the typed path", async ({ page }) => {
  await page.goto("/?mockError=listDir&seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();

  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("/Users/demo");

  const err = page.getByTestId("command-palette-error");
  await expect(err).toBeVisible({ timeout: 3_000 });
  await expect(err).toContainText("Couldn't read that path");

  // The "open this path" confirm row is still available despite the failure.
  await expect(page.getByTestId("command-palette-item-0")).toContainText("Open this path");
});

test("a past-session row opens the dead-session pane first; Resume is the explicit action (UX-06)", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("exited-session-sess-leasing").click();

  // One click = review the dead session. Nothing resumes silently.
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-leasing");

  await page.getByTestId("dead-session-resume").click();
  await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
  await expect(header).toHaveAttribute("data-session-id", "sess-leasing");
  await expect(header.getByTestId("session-context-title")).toContainText("Build the leasing pipeline");

  // The resumed session is unbound and now lives as a tab in the workbench;
  // sessions are not a rail concern, so no session rows appear in the rail.
  await expect(page.locator("[data-testid^='rail-session-']")).toHaveCount(0);
  await expect(page.getByTestId("session-tab-sess-leasing")).toContainText("Build the leasing pipeline");
});

test("the sessions menu is ONE merged past-sessions list with status tags and rich meta", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  const menu = page.getByTestId("history-menu");
  await expect(menu).toBeVisible();

  // One section — the old Exited/History split is gone.
  await expect(menu.getByText("Past sessions", { exact: true })).toBeVisible();
  await expect(menu.getByText("Exited", { exact: true })).toHaveCount(0);
  await expect(menu.getByText("History", { exact: true })).toHaveCount(0);

  // The registry's exited session renders ONCE (deduped against its own
  // history mirror) and is tagged resumable in text, not a color-only dot.
  const exited = page.getByTestId("exited-session-sess-leasing");
  await expect(exited).toBeVisible();
  await expect(page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f")).toHaveCount(0);
  await expect(menu.getByText("Build the leasing pipeline")).toHaveCount(1);
  await expect(exited.locator(".past-session-tag")).toHaveText("resumable");

  // WB-05: the list is global — rfq-workflows' past session shows without
  // switching directories.
  await expect(page.getByTestId("exited-session-sess-rfq")).toBeVisible();

  // UP-06 / SAP-1632: a transcript entry carries branch, turn count, and
  // relative time; and it is tagged archived.
  const transcript = page.getByTestId("history-2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33");
  await expect(transcript.locator(".past-session-tag")).toHaveText("archived");
  await expect(transcript).toContainText("feat/screening-webhook");
  await expect(transcript).toContainText("12 turns");
  await expect(transcript).toContainText("ago");

  await page.screenshot({ path: "web/e2e/screenshots/past-sessions-menu.png" });

  // Clicking the transcript entry opens the review pane — nothing starts
  // silently; starting fresh is the pane's explicit, honestly-labeled action.
  await transcript.click();
  const pane = page.getByTestId("past-session-pane");
  await expect(pane).toBeVisible();
  await expect(page.getByTestId("session-context-title")).toHaveText("Wire the screening webhook");
  await expect(page.getByTestId("past-session-start")).toHaveText("New session here");
  await expect(page.getByTestId("past-session-reason")).toContainText("fresh session");

  await page.getByTestId("past-session-start").click();
  await expect(page.getByTestId("past-session-pane")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", /sess-mock/);
});

test.describe("dead sessions never trap the user", () => {
  test("an exited session is reachable from the history menu and shows a dead-session pane, not a stuck terminal", async ({
    page,
  }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();

    const pane = page.getByTestId("dead-session-pane");
    await expect(pane).toBeVisible();
    await expect(pane).toContainText("Session exited");
    await expect(pane).toContainText("exit code 0");
    await expect(page.locator(".harness-terminal")).toHaveCount(0);

    await page.screenshot({ path: "web/e2e/screenshots/dead-session-pane.png", fullPage: true });
  });

  test("Resume on a dead session starts it running again and stays active in the header", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-resume").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    const header = page.getByTestId("session-context");
    await expect(header).toHaveAttribute("data-session-id", "sess-leasing");
    await expect(header.getByTestId("session-context-title")).toContainText("Build the leasing pipeline");
  });

  test("Close on a dead session removes it and falls back to another running session", async ({ page }) => {
    // The boot session is running, so falling back to it is always possible here.
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-close").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.locator(".terminal-empty")).toHaveCount(0);
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");

    await page.getByTestId("history-trigger").click();
    await expect(page.getByTestId("exited-session-sess-leasing")).toHaveCount(0);
  });
});

test("one view only: there is no folders/groups toggle in the agent-primary rail", async ({ page }) => {
  // The rail is a single agent-primary tree now — the old projection toggle
  // and the custom-groups view are gone entirely (docs/IA.md).
  await expect(page.getByTestId("rail-view-toggle")).toHaveCount(0);
  await expect(page.locator("[data-testid^='custom-group-']")).toHaveCount(0);
  // Orphan agents still render as first-class agent rows under "No workspace".
  await expect(page.getByText("No workspace", { exact: true })).toBeVisible();
  await expect(page.getByTestId("workflow-onboarding-flow")).toBeVisible();
});

test.describe("held arrangement (WB-05)", () => {
  test("workspace collapse, right tab, and right-pane collapse survive a reload", async ({ page }) => {
    // Collapse the rfq workspace group (plain header toggles on click).
    await page.getByTestId("workspace-group-rfq-workflows").locator(".workspace-row-main").click();
    await expect(page.getByTestId("workflow-rfq")).toHaveCount(0);

    // Pick the Steps tab, then fold the right pane away.
    await page.getByTestId("right-tab-steps").click();
    await page.getByTestId("right-collapse").click();

    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Restored: the group stays folded, the pane stays collapsed, and
    // expanding it lands back on Steps.
    await expect(page.getByTestId("workflow-rfq")).toHaveCount(0);
    const expand = page.getByTestId("right-expand");
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(page.getByTestId("right-tab-steps")).toHaveAttribute("aria-selected", "true");
  });
});

test("rail tooltips fly to the right of the rail instead of covering sibling rows (UX-16)", async ({ page }) => {
  await page.getByTestId("workflow-leasing").locator(".workflow-item-trigger").hover();
  const tip = page.locator(".app-tooltip");
  await expect(tip).toHaveAttribute("data-show", "true");

  const railBox = await page.locator(".rail-workflows").boundingBox();
  const tipBox = await tip.boundingBox();
  expect(tipBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  // Flush right of the rail edge — never on top of the tree.
  expect(tipBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width);
});

test("Open in editor lives on workspace rows and the session menu (US-10)", async ({ page }) => {
  // Workspace folder header hover action.
  await page.getByTestId("workspace-group-acme-app").locator(".workspace-row-main").hover();
  await expect(page.getByTestId("workspace-open-editor-acme-app")).toBeVisible();
  await expect(page.getByTestId("workspace-open-editor-acme-app")).toHaveAttribute(
    "aria-label",
    "Open acme-app in editor",
  );

  // Session ⋯ menu item.
  await page.getByTestId("session-menu").click();
  await expect(page.getByTestId("session-open-editor")).toBeVisible();
});

test.describe("command palette (Cmd+K / Cmd+P quick-jump)", () => {
  test("opens via the header trigger and the keyboard shortcut, listing sessions/workflows/recents by default", async ({
    page,
  }) => {
    await page.getByTestId("palette-trigger").click();
    const list = page.getByTestId("command-palette-list");
    await expect(list).toBeVisible();
    await expect(page.getByTestId("command-palette-item-0")).toContainText("acme-app"); // the running boot session

    await page.screenshot({ path: "web/e2e/screenshots/command-palette.png" });

    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();

    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-palette-list")).toBeVisible();
  });

  test("fuzzy filters by the typed query", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("leasing");
    await expect(page.getByTestId("command-palette-item-0")).toContainText("leasing");
  });

  test("Enter on a workflow hit starts a new session there", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("onboarding-flow");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("session-context-title")).toContainText("onboarding-flow");
  });

  test("Enter on a session hit switches to it instead of starting a new one", async ({ page }) => {
    // Resume a different session first so switching back is observable
    // (review pane first, then the explicit Resume — UX-06).
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-resume").click();
    const header = page.getByTestId("session-context");
    await expect(header).toHaveAttribute("data-session-id", "sess-leasing");

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("acme-app");
    await page.getByTestId("command-palette-item-0").click();
    await expect(header).not.toHaveAttribute("data-session-id", "sess-leasing");
  });

  test("a path-shaped query uses live GET /api/fs/list completion instead of fuzzy matching", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("/Users/demo");

    await expect(page.getByText("Open this path")).toBeVisible();
    const dirItem = page.getByTestId("command-palette-item-1");
    await expect(dirItem).toContainText("acme-app");

    await dirItem.click();
    await expect(page.getByTestId("session-context-title")).toContainText("acme-app");
  });
});

test("canvas pane shows its empty state for a session with nothing generated yet", async ({ page }) => {
  // The boot session opens on its bundled board (first paint), so switch to
  // the scratch session — no bundled doc — to see the honest empty state.
  await page.getByTestId("workspace-focus-scratch").click();
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  await expect(page.locator(".canvas-empty")).toContainText("Visualize the bound workflow");
});

test("settings popover: identity, telemetry toggle, and it persists across close/reopen", async ({ page }) => {
  await page.getByTestId("brand-identity").click();
  const trigger = page.getByTestId("settings-trigger");
  const toggle = page.getByTestId("telemetry-toggle");

  await trigger.click();
  const popover = page.getByTestId("settings-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Acme (mock)");
  await expect(popover).toContainText("events.ndjson");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Reopening should reflect the same (mutated) state, not reset to the fixture default.
  await page.getByTestId("brand-identity").click();
  await trigger.click();
  await expect(page.getByTestId("telemetry-toggle")).toHaveAttribute("aria-checked", "true");
});

test("visualize macro is one click — no subject dialog", async ({ page }) => {
  // Visualize lives on the canvas (empty-state CTA + header re-visualize),
  // not on the lifecycle wizard — it's a view action, not a funnel step. The
  // scratch session has no bundled board, so its empty-state CTA is present.
  await page.getByTestId("workspace-focus-scratch").click();
  await expect(page.getByTestId("canvas-visualize-cta")).toBeEnabled();

  await page.getByTestId("canvas-visualize-cta").click();

  // No modal, no free-text field — the click alone fires the macro.
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await expect(page.getByPlaceholder("What should the agent visualize?")).toHaveCount(0);

  // MockApi.runMacro has no other observable effect (it's a no-op against real
  // infra), so the test hook is what confirms the click actually fired — and
  // fired with no subject, since that plumbing is gone.
  await page.waitForFunction(
    () => (window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } }).__HARNESS_TEST__?.lastMacroRun,
  );
  const lastRun = await page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__: { lastMacroRun?: { id: string; req: { subject?: string } } } })
        .__HARNESS_TEST__.lastMacroRun,
  );
  expect(lastRun?.id).toBe("visualize");
  expect(lastRun?.req.subject).toBeUndefined();
});

test.describe("workflow actions", () => {
  test("agent rows carry no macro strip and show their full untruncated name", async ({ page }) => {
    // The explorer row is [zap][name][cloud] only — no macro strip, no hover
    // actions eating inline width. "onboarding-flow" is the longest fixture
    // name; it must not clip to "onboarding-fl…".
    const row = page.getByTestId("workflow-onboarding-flow");
    await expect(row.getByTestId("workflow-macros")).toHaveCount(0);
    await expect(row.locator(".workflow-row-actions")).toHaveCount(0);
    const name = row.locator(".tree-row-label");
    await expect(name).toHaveText("onboarding-flow");
    const overflowing = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflowing).toBe(false);
  });

    test("Prod rides the wizard bar as its fifth step, gating and macro identity intact", async ({ page }) => {
    const openProd = page.getByTestId("macro-open_prod");
    await expect(openProd).toBeVisible();
    // Visible label is the compact "Prod"; the accessible name keeps the
    // server macro's own label so intent stays explicit.
    await expect(openProd).toHaveAttribute("aria-label", "Open prod");
    await expect(openProd).toContainText("Prod");
    // Rail workflow rows still carry no macro strips — the wizard owns them.
    await expect(page.getByTestId("workflow-macros")).toHaveCount(0);
  });

    test("the canvas header stays fully on-screen even when the app is narrower than the default pane widths", async ({
    page,
  }) => {
    // Rail (320 default, shrinkable to 180) + terminal/canvas floors (20rem
    // each) exceed 900px at their preferred widths — narrower viewports used
    // to overflow .app's right edge and get silently clipped by its old
    // overflow:hidden.
    await page.setViewportSize({ width: 900, height: 640 });
    await page.waitForTimeout(50);

    const header = page.getByTestId("workflow-actions-header");
    const reVisualizeBtn = header.getByTestId("canvas-revisualize");
    await expect(reVisualizeBtn).toBeVisible();

    const btnBox = await reVisualizeBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    expect((btnBox?.x ?? 0) + (btnBox?.width ?? 0)).toBeLessThanOrEqual(900);

    await page.screenshot({ path: "web/e2e/screenshots/narrow-viewport-header.png", fullPage: true });
  });

  test("the header's deployed dot is pinned to a fixed slot regardless of name length", async ({ page }) => {
    // "leasing" (short) and "onboarding-flow" (long) are both deployed in the
    // fixtures specifically to exercise this — the dot used to trail right
    // after the name, so it visibly jumped between the two. It now rides the
    // deployed tag, a fixed unit right before the header's refresh action.
    //
    // The two agents legitimately differ in board state: leasing ships a
    // bundled doc so it renders a board (and gains an Expand control), while
    // onboarding-flow does not — so their dots have different ABSOLUTE x. What
    // stays constant regardless of name length is the dot's offset from the
    // always-present refresh action (Expand comes after refresh), so compare
    // that stable relationship, not the absolute x.
    const dot = page.locator(".workflow-actions-header .workflow-dot");
    const refresh = page.getByTestId("canvas-revisualize");
    const dotToRefresh = async (): Promise<number> => {
      const d = await dot.boundingBox();
      const r = await refresh.boundingBox();
      if (!d || !r) throw new Error("header dot/refresh box missing");
      return r.x - d.x;
    };

    // Boot's doc-bearing agent renders on first paint: board + deployed dot +
    // an Expand control.
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    await expect(page.getByTestId("canvas-expand")).toBeVisible();
    const leasingGap = await dotToRefresh();

    // Open onboarding-flow (long name) and start its session — its workspace
    // has no live session. It is deployed (dot present) but ships no doc, so
    // it never mounts a board and never gains the Expand control.
    await page.getByTestId("workflow-onboarding-flow").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("workflow-actions-header")).toContainText("onboarding-flow");
    await expect(page.locator(".canvas-iframe")).toHaveCount(0);
    await expect(page.getByTestId("canvas-expand")).toHaveCount(0);
    const onboardingGap = await dotToRefresh();

    // The name length changed drastically; the dot's slot did not.
    expect(onboardingGap).toBeCloseTo(leasingGap, 0);

    await dot.hover();
    // The dot rides inside the flat deployed tag; the tag owns the tooltip.
    await expect(page.getByTestId("workflow-deployed-tag")).toHaveAttribute(
      "data-tooltip",
      "Deployed to production",
    );
    await page.screenshot({ path: "web/e2e/screenshots/header-dot-pinned.png", fullPage: true });
  });

  test("the header's action is re-visualize, not a no-op iframe reload", async ({ page }) => {
    const reVisualizeBtn = page.getByTestId("workflow-actions-header").getByTestId("canvas-revisualize");
    await expect(reVisualizeBtn).toBeEnabled();
    await expect(reVisualizeBtn).toHaveAttribute("data-tooltip", "Re-visualize");

    await reVisualizeBtn.click();

    // Clicking it fires the same one-click Visualize macro the strip and the
    // empty-state CTA use — not a bare reload with no new content.
    await page.waitForFunction(
      () => (window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } }).__HARNESS_TEST__?.lastMacroRun,
    );
    const lastRun = await page.evaluate(
      () =>
        (window as unknown as { __HARNESS_TEST__: { lastMacroRun?: { id: string; req: { subject?: string } } } })
          .__HARNESS_TEST__.lastMacroRun,
    );
    expect(lastRun?.id).toBe("visualize");

    // The pane itself swaps in the new render once canvas.reload arrives —
    // that part is unchanged, and still the only thing that flips the iframe in.
    await page.evaluate(() => {
      (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });
});

test("canvas empty state explains itself and offers a one-click Visualize CTA", async ({ page }) => {
  // The scratch session has no bundled doc, so its Canvas is the empty state
  // (the boot session opens on its board).
  await page.getByTestId("workspace-focus-scratch").click();
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  // Short supporting line, no file-editing instructions (there is no editor
  // in this harness), CTA after.
  await expect(page.locator(".canvas-empty")).toContainText("Visualize the bound workflow");
  await expect(page.locator(".canvas-empty")).not.toContainText(".sapiom/canvas/index.html");

  await page.screenshot({ path: "web/e2e/screenshots/canvas-empty-state.png" });

  const cta = page.getByTestId("canvas-visualize-cta");
  await expect(cta).toBeVisible();
  await cta.click();

  // One click and done — no dialog, no free-text field.
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await page.waitForFunction(
    () => (window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } }).__HARNESS_TEST__?.lastMacroRun,
  );
  const lastRun = await page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__: { lastMacroRun?: { id: string; req: { subject?: string } } } })
        .__HARNESS_TEST__.lastMacroRun,
  );
  expect(lastRun?.id).toBe("visualize");
  expect(lastRun?.req.subject).toBeUndefined();
});

test("steps tab shows its own empty state (not canvas copy) before anything is visualized", async ({ page }) => {
  // The scratch session has no generated canvas content, so the Steps tab hits
  // the same early-return state as the board — but must talk about steps, with
  // the SAME one-click Visualize CTA (it works from here). (The boot session
  // opens on its board, which does post a step graph.)
  await page.getByTestId("workspace-focus-scratch").click();
  await page.getByTestId("right-tab-steps").click();
  const empty = page.locator(".canvas-empty");
  await expect(empty).toContainText("No steps yet");
  await expect(empty).toContainText("Steps are read from the visualized workflow");
  await expect(empty).not.toContainText("Nothing generated yet");
  await expect(page.getByTestId("canvas-visualize-cta")).toBeVisible();

  // The board keeps its own copy on the Canvas tab.
  await page.getByTestId("right-tab-canvas").click();
  await expect(empty).toContainText("Nothing generated yet");
});

test("the canvas is a single controlled surface — no separate preview tab or port suggestions", async ({ page }) => {
  await expect(page.locator(".canvas-mode-toggle")).toHaveCount(0);
  await expect(page.getByTestId("preview-chip")).toHaveCount(0);

  // A detected-port bus message must render nothing in this surface — the
  // canvas only ever shows the session's own generated content.
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "port.detected",
      harnessSessionId: "sess-boot",
      port: 4000,
      url: "http://localhost:4000",
    });
  });
  await expect(page.getByTestId("preview-chip")).toHaveCount(0);
  // The port message changed nothing in the canvas — the board (the session's
  // own generated content, rendered on first paint) is still all it shows.
  await expect(page.locator(".canvas-iframe")).toBeVisible();
});

test("the seeded boot agent renders its board on first paint, and a canvas.reload keeps the iframe", async ({ page }) => {
  // Demo visibility (docs/IA.md): the agent bound to sess-boot renders its
  // board immediately — sess-boot ships a bundled canvas doc, so the demo
  // opens on a live board (no click) rather than an empty pane. Non-doc mock
  // sessions never mount an iframe (guarded elsewhere); this is the doc case.
  await expect(page.locator(".canvas-empty")).toHaveCount(0);
  await expect(page.locator(".canvas-iframe")).toHaveAttribute("src", /^\/canvas\/sess-boot\/index\.html\?theme=(light|dark)$/);

  // A canvas.reload (the real server fires one when the render is rewritten)
  // re-renders in place — the iframe stays, never dropping to the empty state.
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  await expect(page.locator(".canvas-empty")).toHaveCount(0);
  await expect(page.locator(".canvas-iframe")).toBeVisible();
});

test("a stale enrichment renders with the 'stale — Refresh' chip in the served canvas document", async ({ page }) => {
  // The chip is server-rendered (core/canvas-render.ts marks an enrichment
  // whose fingerprint no longer matches the sources) — serve the REAL
  // renderer's output for that state into the pane's iframe and assert the
  // chip actually displays through the sandboxed-iframe pipeline.
  // Frontend-only port: the real server renderer lives upstream
  // (sapiom-js packages/harness/src/core/canvas-render.ts). This inline
  // fixture reproduces its stale-enrichment markup contract exactly
  // (.canvas-badge--stale chip + .canvas-subtitle stays displayed).
  const staleDocument = `<!doctype html><html><head><meta charset="utf-8" /></head><body>
    <div class="canvas-panel">
      <h1 class="canvas-title">leasing <span class="canvas-badge canvas-badge--stale">stale \u2014 Refresh</span></h1>
      <p class="canvas-subtitle">Handles lease applications end to end</p>
    </div>
  </body></html>`;
  await page.route("**/canvas/sess-boot/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: staleDocument });
  });

  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  const frame = page.frameLocator(".canvas-iframe");
  await expect(frame.locator(".canvas-badge--stale")).toHaveText("stale — Refresh");
  // The stale enrichment stays DISPLAYED — the chip marks it, never hides it.
  await expect(frame.locator(".canvas-subtitle")).toHaveText("Handles lease applications end to end");
  });

test("a pending canvas load shows a skeleton over the iframe — never a blank pane", async ({ page }) => {
  // Stall the canvas document so the load stays pending long enough to assert
  // on the skeleton deterministically.
  let releaseCanvas = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseCanvas = resolve;
  });
  await page.route("**/canvas/sess-boot/**", async (route) => {
    await gate;
    await route.fulfill({ contentType: "text/html", body: "<html><body>diagram</body></html>" });
  });

  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  // While the iframe document is in flight: shimmer skeleton visible (with
  // its a11y label), and the header's refresh icon spins.
  await expect(page.getByTestId("canvas-loading")).toBeVisible();
  await expect(page.getByTestId("canvas-loading")).toHaveAttribute("aria-label", "Rendering diagram");
  await expect(page.locator(".canvas-refresh-btn")).toHaveClass(/is-refreshing/);

  // Once loaded the skeleton fades out (kept mounted briefly with .is-fading)
  // and then unmounts; the spin stops with it.
  releaseCanvas();
  await expect(page.getByTestId("canvas-loading")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".canvas-iframe")).toBeVisible();
  await expect(page.locator(".canvas-refresh-btn")).not.toHaveClass(/is-refreshing/);
});

test("a mock session without a bundled canvas doc shows the empty state and never mounts an iframe", async ({
  page,
}) => {
  // Mock mode ships real documents only under public/canvas/<id>/ (today:
  // sess-boot). Any other session's canvas URL is the static host's 404
  // page on the deployed Pages build, so the pane must keep the honest
  // empty state — no iframe, and no fetch of a non-doc canvas URL, ever.
  const sessionsFetched = new Set<string>();
  await page.route("**/canvas/**", async (route) => {
    const match = /\/canvas\/([^/]+)/.exec(route.request().url());
    if (match) sessionsFetched.add(match[1]);
    await route.fulfill({ contentType: "text/html", body: "<html><body>diagram</body></html>" });
  });

  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-iframe")).toBeVisible();

  // Open rfq and start a session: same-workspace, so it starts in
  // rfq-workflows — a session with NO bundled demo document.
  await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
  await page.getByTestId("open-agent-start-session").click();
  await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");

  // Honest absence, not a 404 in a frame: the empty state renders…
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  await expect(page.locator(".canvas-iframe")).toHaveCount(0);

  // …and even an explicit reload event for the new session cannot force a
  // frame (this is the exact path that iframed GitHub's 404 on Pages).
  const newSessionId = await page.getByTestId("session-context").getAttribute("data-session-id");
  expect(newSessionId).not.toBe("sess-boot");
  await page.evaluate((id) => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: id,
    });
  }, newSessionId);
  await page.waitForTimeout(300);
  await expect(page.locator(".canvas-iframe")).toHaveCount(0);
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  expect(Array.from(sessionsFetched).every((id) => id === "sess-boot")).toBe(true);
});

test.describe("background-task canvas states", () => {
  const baseTask = {
    id: "task-1",
    macroId: "visualize",
    label: "Visualize",
    harnessSessionId: "sess-boot",
    cwd: "/Users/demo/acme-app",
    // The mock boot session's bound workflow (MOCK_WORKFLOWS "leasing") —
    // enrichment tasks always carry the workflow they target.
    workflowPath: "/Users/demo/acme-app/leasing" as string | null,
    startedAt: new Date().toISOString(),
    endedAt: null as string | null,
    exitCode: null as number | null,
    statusLines: [] as string[],
    resultText: null as string | null,
    errorTail: null as string | null,
  };

  const publish = (page: import("@playwright/test").Page, task: unknown): Promise<void> =>
    page.evaluate((t) => {
      (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "task.status",
        task: t,
      });
    }, task);

  test("a running task shows the live activity state, streaming status lines as they arrive", async ({ page }) => {
    await publish(page, { ...baseTask, status: "running" });

    const activity = page.getByTestId("canvas-task-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Visualize is running");
    await expect(activity.locator(".canvas-task-icon")).toBeVisible();

    await publish(page, {
      ...baseTask,
      status: "running",
      statusLines: ["Agent started", "Read steps/route.ts"],
    });
    await expect(page.getByTestId("canvas-task-lines")).toContainText("Read steps/route.ts");

    await page.screenshot({ path: "web/e2e/screenshots/canvas-task-activity.png" });

    // Completion clears the activity state; a canvas.reload for the written
    // index.html (the real server fires one via the canvas watcher) swaps in
    // the generated iframe.
    await publish(page, { ...baseTask, status: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("activity only shows on the pane of the session that triggered the task", async ({ page }) => {
    await publish(page, { ...baseTask, harnessSessionId: "sess-bg", status: "running" });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    // sess-boot's own pane still shows its ordinary board (its bound agent
    // renders on first paint), not another session's activity.
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("activity is scoped to the BOUND WORKFLOW — another workflow's task never bleeds into this pane", async ({
    page,
  }) => {
    // Same session, but the task targets a workflow that is NOT the pane's
    // current binding (sess-boot is bound to leasing) — hidden.
    await publish(page, { ...baseTask, workflowPath: "/Users/demo/onboarding-flow", status: "running" });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    // The pane keeps its ordinary board (leasing renders on first paint); the
    // other workflow's task never bleeds in.
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // The bound workflow's own task shows, overlaid on the board...
    await publish(page, { ...baseTask, id: "task-2", status: "running" });
    await expect(page.getByTestId("canvas-task-activity")).toBeVisible();

    // ...and switching the subject mid-run (open rfq, then start its session)
    // hides it again: the rfq session's pane must not show leasing's
    // enrichment progress.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
  });

  test("enrichment running after content exists: iframe stays visible with the activity strip overlaid", async ({
    page,
  }) => {
    // Bring up the canvas iframe first — simulates the deterministic render
    // that fires immediately when the user clicks Visualize.
    await page.route("**/canvas/sess-boot/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<html><body>diagram</body></html>" });
    });
    await page.evaluate(() => {
      (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // Now the enrichment task starts (LLM annotating the diagram in the
    // background). The iframe must stay in the DOM — the activity strip
    // overlays it, not replaces it.
    await publish(page, { ...baseTask, status: "running" });

    const activity = page.getByTestId("canvas-task-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Visualize is running");
    // Headline feature: the iframe is NOT hidden while enrichment runs.
    await expect(page.locator(".canvas-iframe")).toBeVisible();
    // The overlay class is applied so the strip sits on top of the iframe.
    await expect(activity).toHaveClass(/canvas-task-activity--overlay/);

    await page.screenshot({ path: "web/e2e/screenshots/canvas-enrichment-overlay.png" });

    // Status lines stream through normally.
    await publish(page, {
      ...baseTask,
      status: "running",
      statusLines: ["Reading steps/intake.ts"],
    });
    await expect(page.getByTestId("canvas-task-lines")).toContainText("Reading steps/intake.ts");
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    // Task completes: activity strip disappears, iframe stays.
    await publish(page, { ...baseTask, status: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });

  test("failure view is full-screen (no iframe behind it) — unchanged from before", async ({ page }) => {
    // Get an iframe up first, then trigger a failure.
    await page.route("**/canvas/sess-boot/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<html><body>diagram</body></html>" });
    });
    await page.evaluate(() => {
      (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    await publish(page, {
      ...baseTask,
      status: "failed",
      endedAt: new Date().toISOString(),
      exitCode: 1,
      errorTail: "Connection lost",
    });

    // Failure state replaces everything — iframe gone, failure panel shown.
    await expect(page.getByTestId("canvas-task-failed")).toBeVisible();
    await expect(page.locator(".canvas-iframe")).toHaveCount(0);

    await page.screenshot({ path: "web/e2e/screenshots/canvas-failure-fullscreen.png" });
  });

  test("a failed task shows the error tail with retry and dismiss affordances", async ({ page }) => {
    await publish(page, {
      ...baseTask,
      status: "failed",
      endedAt: new Date().toISOString(),
      exitCode: 1,
      errorTail: "API connection lost",
    });

    const failed = page.getByTestId("canvas-task-failed");
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("Visualize failed");
    await expect(failed).toContainText("API connection lost");
    await page.screenshot({ path: "web/e2e/screenshots/canvas-task-failed.png" });

    // Retry re-fires the same macro (MockApi records it for us to read back)
    // — for an enrichment task that's the visualize force refresh.
    await page.getByTestId("canvas-task-retry").click();
    await page.waitForFunction(
      () => (window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } }).__HARNESS_TEST__?.lastMacroRun,
    );
    const lastRun = await page.evaluate(
      () =>
        (window as unknown as { __HARNESS_TEST__: { lastMacroRun?: { id: string } } }).__HARNESS_TEST__.lastMacroRun,
    );
    expect(lastRun?.id).toBe("visualize");

    // Dismiss hides the failure panel and returns the pane to its usual state
    // (the bound board, which sess-boot renders on first paint).
    await page.getByTestId("canvas-task-dismiss").click();
    await expect(page.getByTestId("canvas-task-failed")).toHaveCount(0);
    await expect(page.locator(".canvas-iframe")).toBeVisible();
  });
});

test.describe("agent action bar (status chip + right-anchored actions)", () => {
  test("deployed workflow: chip reads Deployed, Run is enabled and fires a direct prod run", async ({ page }) => {
    // Boot session is bound to "leasing", which has a definitionId — the one
    // durable signal the server proves; everything else is a repeatable action.
    const bar = page.getByTestId("session-steps");
    await expect(bar).toBeVisible();
    const chip = page.getByTestId("session-lifecycle-chip");
    await expect(chip).toContainText("Deployed");
    await expect(chip).toHaveAttribute("data-deployed", "true");

    // Actions sit right-anchored with Deploy at the right edge.
    const runBox = await page.getByTestId("session-step-run").boundingBox();
    const deployBox = await page.getByTestId("session-step-deploy").boundingBox();
    const chipBox = await chip.boundingBox();
    expect((deployBox?.x ?? 0)).toBeGreaterThan(runBox?.x ?? 0);
    expect((runBox?.x ?? 0)).toBeGreaterThan(chipBox?.x ?? 0);

    // Run fires the DIRECT prod-run route (no pty inject / user LLM credits):
    // it records lastDirectAction, never lastMacroRun, and carries leasing's
    // definitionId as the runs route wants it (a string).
    await page.getByTestId("session-step-run").click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __HARNESS_TEST__?: { lastDirectAction?: unknown } }).__HARNESS_TEST__
          ?.lastDirectAction,
    );
    const lastDirect = await page.evaluate(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__: { lastDirectAction?: { action: string; req: { definitionId?: string } } };
          }
        ).__HARNESS_TEST__.lastDirectAction,
    );
    expect(lastDirect?.action).toBe("run");
    expect(lastDirect?.req?.definitionId).toBe("4821");
  });

  test("undeployed workflow: chip reads Draft; Run and Prod are gated with the deploy reason", async ({ page }) => {
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("rfq");

    const chip = page.getByTestId("session-lifecycle-chip");
    await expect(chip).toContainText("Draft");
    await expect(page.getByTestId("session-step-local")).toBeEnabled();
    await expect(page.getByTestId("session-step-deploy")).toBeEnabled();
    const run = page.getByTestId("session-step-run");
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute("aria-label", /Not deployed yet/);

    await page.screenshot({ path: "web/e2e/screenshots/session-steps.png" });
  });

  test("narrow pane: secondary actions degrade to icon-only; the primary Deploy keeps its label", async ({ page }) => {
    // 820px squeezes the center pane to its 320px floor — under the bar's
    // 460px container threshold, so secondary labels hide while icons stay.
    await page.setViewportSize({ width: 820, height: 720 });

    const local = page.getByTestId("session-step-local");
    await expect(local).toBeVisible();
    await expect(local.locator(".session-step-label")).toBeHidden();
    // The bar's one emphasized verb never degrades to a bare glyph (UX-21).
    await expect(page.getByTestId("session-step-deploy")).toBeVisible();
    await expect(page.getByTestId("session-step-deploy").locator(".session-step-label")).toBeVisible();

    // Icon-only stays accessible: name + tooltip ride the button itself.
    await expect(local).toHaveAttribute("aria-label", /.+/);
    await expect(local).toHaveAttribute("data-tooltip", /.+/);

    await page.screenshot({ path: "web/e2e/screenshots/session-steps-icon-only.png" });

    // Back at desktop width the labels return.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(local.locator(".session-step-label")).toBeVisible();
  });
});

test.describe("account profile row", () => {
  test("opens a menu with real account surfaces; demo mode offers connect", async ({ page }) => {
    const profile = page.getByTestId("brand-identity");
    await expect(profile).toContainText("Demo workspace");
    await profile.click();

    const menu = page.getByTestId("profile-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("profile-open-dashboard")).toBeVisible();
    // Demo build: the switch item reads as connect and stays actionable.
    await expect(page.getByTestId("profile-switch-account")).toHaveText(/Connect Sapiom account/);
    await expect(page.getByTestId("profile-switch-account")).toBeEnabled();

    // Dismisses like every other popover.
    await page.locator(".brand-name").click();
    await expect(menu).toHaveCount(0);
  });
});

test.describe("resizable panes", () => {
  test("dragging the rail handle resizes the rail and persists across reload", async ({ page }) => {
    const handle = page.getByTestId("resize-handle-rail");
    const railBefore = await page.locator(".rail-workflows").boundingBox();
    const handleBox = await handle.boundingBox();
    if (!railBefore || !handleBox) throw new Error("expected bounding boxes");

    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, y, { steps: 5 });
    await page.mouse.up();

    const railAfter = await page.locator(".rail-workflows").boundingBox();
    expect((railAfter?.width ?? 0) - railBefore.width).toBeGreaterThan(60);

    await page.reload();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    const railReloaded = await page.locator(".rail-workflows").boundingBox();
    expect(Math.abs((railReloaded?.width ?? 0) - (railAfter?.width ?? 0))).toBeLessThan(3);
  });

  test("dragging the canvas handle resizes the canvas pane", async ({ page }) => {
    const handle = page.getByTestId("resize-handle-canvas");
    const canvasBefore = await page.locator(".canvas-pane").boundingBox();
    const handleBox = await handle.boundingBox();
    if (!canvasBefore || !handleBox) throw new Error("expected bounding boxes");

    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, y);
    await page.mouse.down();
    // Dragging the canvas handle toward the terminal (left) grows the canvas.
    await page.mouse.move(handleBox.x + handleBox.width / 2 - 80, y, { steps: 5 });
    await page.mouse.up();

    const canvasAfter = await page.locator(".canvas-pane").boundingBox();
    expect((canvasAfter?.width ?? 0) - canvasBefore.width).toBeGreaterThan(60);
  });

  test("rail and canvas widths cannot be dragged past their min-width floors", async ({ page }) => {
    const railHandle = page.getByTestId("resize-handle-rail");
    let box = await railHandle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 1000, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const railWidth = (await page.locator(".rail-workflows").boundingBox())?.width ?? 0;
    expect(railWidth).toBeGreaterThanOrEqual(178); // RAIL_MIN = 180, small rounding slack
    expect(railWidth).toBeLessThan(195);

    const canvasHandle = page.getByTestId("resize-handle-canvas");
    box = await canvasHandle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    await page.mouse.move(box.x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 1000, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const canvasWidth = (await page.locator(".canvas-pane").boundingBox())?.width ?? 0;
    expect(canvasWidth).toBeGreaterThanOrEqual(318); // CANVAS_MIN = 320 (20rem), small rounding slack
    expect(canvasWidth).toBeLessThan(335);
  });

  test("double-clicking a handle resets it to its default width", async ({ page }) => {
    const handle = page.getByTestId("resize-handle-rail");
    const box = await handle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, y, { steps: 5 });
    await page.mouse.up();

    await handle.dblclick();
    const railWidth = (await page.locator(".rail-workflows").boundingBox())?.width ?? 0;
    expect(Math.abs(railWidth - 320)).toBeLessThan(3); // RAIL_DEFAULT = 320 (20rem)
  });

  test("both panels collapse and expand from dynamically anchored controls", async ({ page }) => {
    // Rail: collapse from its own header; the expand affordance appears
    // left-anchored in the session bar, before the tabs.
    await page.getByTestId("rail-collapse").click();
    await expect(page.locator(".rail-workflows")).not.toBeVisible();
    const expandRail = page.getByTestId("rail-expand");
    await expect(expandRail).toBeVisible();
    const expandBox = await expandRail.boundingBox();
    const contextBox = await page.getByTestId("session-context").boundingBox();
    expect((expandBox?.x ?? 0)).toBeLessThan(contextBox?.x ?? 0);

    await expandRail.click();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("rail-expand")).toHaveCount(0);

    // Right pane: collapse from its tabs bar; kept ATTACHED (canvas
    // keep-alive) but hidden; the expand affordance is the session bar's
    // last control on the right.
    await page.getByTestId("right-collapse").click();
    await expect(page.getByTestId("right-panel-canvas")).toBeAttached();
    await expect(page.getByTestId("right-panel-canvas")).not.toBeVisible();
    const expandRight = page.getByTestId("right-expand");
    await expect(expandRight).toBeVisible();
    const rightBox = await expandRight.boundingBox();
    const contextBox2 = await page.getByTestId("session-context").boundingBox();
    expect((rightBox?.x ?? 0)).toBeGreaterThan(contextBox2?.x ?? 0);

    await expandRight.click();
    await expect(page.getByTestId("right-panel-canvas")).toBeVisible();
    await expect(page.getByTestId("right-expand")).toHaveCount(0);
  });

  test("terminal and canvas split the main area equally by default", async ({ page }) => {
    const center = await page.locator(".center-pane").boundingBox();
    const canvas = await page.locator(".canvas-pane").boundingBox();
    expect(center).not.toBeNull();
    expect(canvas).not.toBeNull();
    // Fresh state (no stored drag) = 1fr/1fr — equal within rounding slack.
    expect(Math.abs((center?.width ?? 0) - (canvas?.width ?? 0))).toBeLessThan(25);

    // Dragging then double-clicking the canvas handle returns to the split.
    const handle = page.getByTestId("resize-handle-canvas");
    const box = await handle.boundingBox();
    if (!box) throw new Error("expected bounding box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, y, { steps: 5 });
    await page.mouse.up();
    await handle.dblclick();

    const centerAfter = await page.locator(".center-pane").boundingBox();
    const canvasAfter = await page.locator(".canvas-pane").boundingBox();
    expect(Math.abs((centerAfter?.width ?? 0) - (canvasAfter?.width ?? 0))).toBeLessThan(25);
  });
});

test("the canvas iframe carries the app's theme and flips on toggle", async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  const iframe = page.locator(".canvas-iframe");
  await expect(iframe).toHaveAttribute("src", /theme=dark/);

  await page.getByTestId("theme-toggle").click();
  await expect(iframe).toHaveAttribute("src", /theme=light/);
});


test("end session: the header ⋯ menu opens a confirm dialog before ending the session", async ({ page }) => {
  // Leasing is focused with sess-boot active — end it from the header menu.
  const header = page.getByTestId("session-context");
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");

  // The menu item never kills directly — it opens a proper confirm dialog.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  const confirm = page.getByTestId("end-session-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("kills the live terminal");

  // Keep cancels — nothing dies.
  await page.getByRole("button", { name: "Keep session" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(header).toHaveAttribute("data-session-id", "sess-boot");

  // Confirming ends the session — the app falls back to another live one.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
  await page.getByTestId("end-session-confirm-btn").click();
  await expect(header).not.toHaveAttribute("data-session-id", "sess-boot");
});

test.describe("session menu copy path", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("Copy path confirms with the same toast as the rail's copy action", async ({ page }) => {
    // A4-05: the ⋯ menu's Copy path used to write silently — same verb as
    // the rail's copy action, so it confirms (or fails) with the same toast.
    await page.getByTestId("session-menu").click();
    await page.getByRole("menuitem", { name: "Copy path" }).click();
    await expect(page.getByTestId("toast")).toContainText("Path copied.");
  });
});

test("directory picker: arrow keys move the highlight and Enter drills into it", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();
  const input = page.getByTestId("dir-picker-input");
  await expect(page.getByTestId("dir-picker-item-leasing")).toBeVisible();

  await input.press("ArrowDown");
  await expect(page.getByTestId("dir-picker-item-src")).toHaveClass(/is-selected/);
  await input.press("Enter");
  await expect(input).toHaveValue("/Users/demo/acme-app/src");
});

test("canvas controls: the board widget zooms; the subheader's expand lifts the pane to an overlay", async ({ page }) => {
  // Swap the empty state for the demo iframe first (same bus message the
  // agent's canvas.reload event sends).
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  const iframe = page.locator(".canvas-iframe");
  await expect(iframe).toBeVisible();

  const controls = page.getByTestId("canvas-view-controls");
  await expect(controls).toBeVisible();

  // The demo document posts its natural size and the app auto-fits on
  // first render (UX-10): at this viewport the cascade is taller than the
  // visible board, so the fitted rest zoom lands below 100% with the whole
  // graph clear of the docked controls. The Fit button is disabled at rest.
  const fit = page.getByTestId("canvas-fit");
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const fittedZoom = await page.getByTestId("canvas-zoom-reset").textContent();
  await expect(fit).toBeDisabled();

  // View contract: the iframe element never transforms (the board always
  // fills the pane); the view state is posted into the document, whose GRAPH
  // pans/scales over the anchored dotted surface.
  const graph = page.frameLocator(".canvas-iframe").locator(".cascade");
  await page.getByTestId("canvas-zoom-reset").click();
  await expect(page.getByTestId("canvas-zoom-reset")).toHaveText("100%");
  await expect(iframe).toHaveCSS("transform", "none");
  await expect(graph).toHaveCSS("transform", "none");
  await page.getByTestId("canvas-zoom-in").click();
  await expect(page.getByTestId("canvas-zoom-reset")).toHaveText("125%");
  await expect(graph).toHaveCSS("transform", /matrix\(1\.25/);

  // Fit-to-view sits at the right end of the widget; it armed as soon as
  // the view left the fitted rest pose, and one click returns there.
  const fitBox = await fit.boundingBox();
  const zoomInBox = await page.getByTestId("canvas-zoom-in").boundingBox();
  expect((fitBox?.x ?? 0)).toBeGreaterThan(zoomInBox?.x ?? 0);
  await expect(fit).toBeEnabled();
  await fit.click();
  await expect(page.getByTestId("canvas-zoom-reset")).toHaveText(fittedZoom ?? "100%");
  await expect(fit).toBeDisabled();

  // The gesture surface for drag-pan/wheel-zoom covers the board.
  await expect(page.getByTestId("canvas-pan-layer")).toBeVisible();

  // The board widget carries zoom only — panel-level expand lives on the
  // subheader row, right-anchored next to refresh.
  await expect(controls.getByTestId("canvas-expand")).toHaveCount(0);
  const expand = page.getByTestId("workflow-actions-header").getByTestId("canvas-expand");

  // Expand: same node, fixed overlay — the iframe is not remounted. The
  // overlay covers the subheader, so it carries its own exit control.
  await expand.click();
  await expect(page.locator(".canvas-frame-wrap")).toHaveClass(/is-expanded/);
  await expect(page.locator(".canvas-frame-wrap")).toHaveCSS("position", "fixed");
  await page.getByTestId("canvas-expand-exit").click();
  await expect(page.locator(".canvas-frame-wrap")).not.toHaveClass(/is-expanded/);

  // Escape works too.
  await expand.click();
  await expect(page.locator(".canvas-frame-wrap")).toHaveClass(/is-expanded/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".canvas-frame-wrap")).not.toHaveClass(/is-expanded/);
});

test("steps tab drills into a step's real transitions and slides back", async ({ page }) => {
  // The demo document posts its real graph ({type:"sapiom-canvas:graph"});
  // load it via the same reload event the agent fires.
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  const frame = page.locator(".canvas-frame-wrap");
  await expect(frame).toHaveAttribute("data-view", "board");

  // Steps is a first-class right-pane tab, a projection of the same posted
  // graph; the subheader names the workflow and the REAL step count.
  await page.getByTestId("right-tab-steps").click();
  await expect(frame).toHaveAttribute("data-view", "steps");
  // One counting rule everywhere (graphCounts): pipeline steps exclude the
  // two terminal exits, which are named separately.
  await expect(page.getByTestId("canvas-steps-count")).toHaveText("4 steps · 2 exits");

  // The step list is built from the posted graph, not guessed.
  await expect(page.getByTestId("canvas-steps-list")).toBeVisible();
  const approveRow = page.getByTestId("canvas-step-row-approve");
  await expect(approveRow).toBeVisible();

  // Row anatomy carries manifest truth: zero-padded index, name + role copy,
  // and structural facts (input contract size, branch fan-out, timeout).
  await expect(approveRow).toContainText("04");
  await expect(approveRow).toContainText("1 input · 2 branches");
  await expect(page.getByTestId("canvas-step-row-credit-check")).toContainText("30s limit");
  // Grouped steps sit under their board band's label.
  await expect(page.getByTestId("canvas-steps-list")).toContainText("intake & screening");

  // Rows are an ACCORDION: the first click expands in place with the step's
  // description, input contract, and transitions; navigation is the explicit
  // link inside.
  await approveRow.click();
  const expand = page.getByTestId("canvas-step-expand-approve");
  await expect(expand).toBeVisible();
  await expect(expand).toContainText("score ≥ 620");
  const inputCard = page.getByTestId("canvas-step-input-approve");
  await expect(inputCard).toContainText("score");
  await expect(inputCard).toContainText("number");
  // Capabilities ride the posted graph (A4-04): the Sapiom services a step
  // calls render as chips wherever the step's contract shows.
  await expect(page.getByTestId("canvas-step-capabilities-approve")).toContainText("rules.evaluate");
  await expect(frame).toHaveAttribute("data-view", "steps");

  // Full details slides the WHOLE pane; the subheader swaps to back
  // (1×1, left-anchored) + step name + kind, with the main action and the
  // ⋯ menu right-anchored.
  await page.getByTestId("canvas-step-open-approve").click();
  await expect(frame).toHaveAttribute("data-view", "detail");
  const header = page.getByTestId("workflow-actions-header");
  await expect(header.getByTestId("canvas-detail-back")).toBeVisible();
  await expect(header.getByTestId("canvas-detail-title")).toHaveText("approve?");
  await expect(header.getByTestId("canvas-detail-ask")).toBeVisible();
  await expect(header.getByTestId("canvas-detail-menu")).toBeVisible();

  // Real outgoing transitions with their branch conditions, both terminals.
  const detail = page.getByTestId("canvas-step-detail");
  await expect(detail).toContainText("draft-lease");
  await expect(detail).toContainText("score ≥ 620");
  await expect(detail).toContainText("manual-review");
  await expect(detail).toContainText("declined");

  // The Contract section renders the step's REAL declared input schema and
  // the capabilities it calls (the thing Sapiom bills for).
  const contract = detail.getByTestId("canvas-detail-input");
  await expect(contract).toContainText("score");
  await expect(contract).toContainText("number");
  await expect(detail.getByTestId("canvas-detail-capabilities")).toContainText("rules.evaluate");

  // An edge row links deeper: jump to the terminal it points at.
  await detail.getByText("draft-lease").click();
  await expect(header.getByTestId("canvas-detail-title")).toHaveText("draft-lease");

  await page.screenshot({ path: "web/e2e/screenshots/canvas-step-detail.png" });

  // Back returns to the steps list; the Canvas tab still shows the board.
  await page.getByTestId("canvas-detail-back").click();
  await expect(frame).toHaveAttribute("data-view", "steps");
  await page.getByTestId("right-tab-canvas").click();
  await expect(frame).toHaveAttribute("data-view", "board");
});

test("a detected dev server surfaces a Preview chip on the action bar", async ({ page }) => {
  await expect(page.getByTestId("session-preview-chip")).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "port.detected",
      harnessSessionId: "sess-boot",
      port: 5173,
      url: "http://localhost:5173/",
    });
  });
  const chip = page.getByTestId("session-preview-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Preview :5173");
  await expect(chip).toHaveAttribute("href", "http://localhost:5173/");
});

test("an observed run renders per-step status and latency in the steps tab", async ({ page }) => {
  // Load the demo document's graph first and WAIT for the board: lastMessage
  // is a single slot, so back-to-back publishes in one tick would drop the
  // reload. Then announce the run the way the server's ExecutionDetector does.
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-demo-1",
      target: "prod",
    });
  });
  await page.getByTestId("right-tab-steps").click();

  // Run truth replaces the structural dot and facts: status glyph + latency.
  const introRow = page.getByTestId("canvas-step-row-intake");
  await expect(introRow.locator(".canvas-run-status")).toHaveAttribute("data-status", "passed");
  await expect(introRow).toContainText("240ms");
  await expect(page.getByTestId("canvas-step-row-credit-check")).toContainText("1.9s");
  // The chip and note carry the run's origin — the server said this was a prod
  // run. The Studio is cost-free: the run surface shows status and latency only.
  await expect(page.getByTestId("canvas-run-chip")).toContainText("prod run completed");
  await expect(page.getByTestId("canvas-steps-run-note")).toHaveText("prod run");

  // Detail carries the same run truth for the drilled step.
  await introRow.click();
  await page.getByTestId("canvas-step-open-intake").click();
  const runSection = page.getByTestId("canvas-detail-run");
  await expect(runSection).toContainText("passed");
  await expect(runSection).toContainText("240ms");
});

test("an observed run renders its real steps even before anything is visualized", async ({ page }) => {
  // The scratch session ships no bundled doc, so nothing is visualized for it
  // (no graph). A run announcement alone must still surface real per-step
  // truth in the Steps tab (WB-11) instead of "No steps yet". (The boot
  // session opens on its board, which already posts a graph — the fallback is
  // exactly this no-graph path.)
  await page.getByTestId("workspace-focus-scratch").click();
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-bg",
      executionId: "exec-local-1",
      target: "local",
    });
  });
  await page.getByTestId("right-tab-steps").click();
  const fallback = page.getByTestId("canvas-run-fallback");
  await expect(fallback).toBeVisible();
  await expect(page.getByTestId("canvas-run-step-intake")).toContainText("240ms");
  await expect(page.getByTestId("canvas-run-step-credit-check")).toContainText("1.9s");
  // The server declared this run local: the note carries the run origin. The
  // Studio is cost-free, so no money renders anywhere on the run surface.
  await expect(page.getByTestId("canvas-steps-run-note")).toHaveText("local run");
  await expect(fallback).not.toContainText("$");
  // Structure (transitions, contracts) still needs Visualize; the hint says so.
  await expect(fallback).toContainText("Visualize on the Canvas tab");
});

test("a second run never erases the first: the run picker recalls past runs", async ({
  page,
}) => {
  const publishRun = (executionId: string): Promise<void> =>
    page.evaluate((id) => {
      (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId: id,
        target: "prod",
      });
    }, executionId);

  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await publishRun("exec-demo-1");
  // Second run: the first run's record survives the new execution (WB-11).
  await publishRun("exec-demo-2");

  // The run chip becomes a picker with two observed runs: any past run is
  // one click away, refetched through the same run-state endpoint.
  await page.getByTestId("right-tab-steps").click();
  const chip = page.getByTestId("canvas-run-chip");
  await expect(chip).toContainText("prod run completed");
  await chip.click();
  const menu = page.getByTestId("canvas-run-menu");
  await expect(menu.getByTestId("canvas-run-option-exec-demo-1")).toContainText("run 1 · completed · prod");
  await expect(menu.getByTestId("canvas-run-option-exec-demo-2")).toContainText("run 2 · completed · prod");
  await menu.getByTestId("canvas-run-option-exec-demo-1").click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("canvas-steps-run-note")).toHaveText("prod run");
});

test("board nodes get hover and selected states through the message contract", async ({ page }) => {
  // Between the extremes: the refit assertions below need both fitted zooms
  // (overview open and collapsed) off the widget's 50% floor AND below the
  // 100% cap, so a zoom CHANGE is observable. With the Canvas tab back to a
  // pure board (the snippets moved to the Code tab) the board is taller, so
  // 1000px would fit at the 100% cap; 820 keeps both zooms in between.
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  const boardFrame = page.frameLocator(".canvas-frame-wrap iframe");
  // The intake node sits at the top of the cascade, safely above the
  // overview sheet that overlays the lower board.
  const intakeNode = boardFrame.locator('[data-node-id="intake"]');
  await expect(intakeNode).toBeVisible();
  // Auto-fit lands right after the document posts its size — wait for the
  // view to settle so measured node positions can't shift mid-test.
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");

  // The gesture layer covers the iframe, so hover must travel as a message:
  // pointer over the node -> document applies .is-hover and answers with a
  // hit -> the layer flips its cursor affordance.
  const box = await intakeNode.boundingBox();
  if (!box) throw new Error("intake node has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await expect(intakeNode).toHaveClass(/is-hover/);
  await expect(page.getByTestId("canvas-pan-layer")).toHaveAttribute("data-over-node", "true");

  // A non-drag click on a node is a PICK: the bottom inspector populates in
  // place (no tab switch — the Steps tab is its explicit "Open in Steps"
  // drill), and the board rings the selected node. Collapse the overview
  // sheet first so it can't overlay the lower nodes — the taller board
  // refits (larger zoom), so wait for that view to settle too.
  const zoomBeforeCollapse = await page.getByTestId("canvas-zoom-reset").textContent();
  await page.getByTestId("canvas-overview-toggle").click();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText(zoomBeforeCollapse ?? "");
  const approveNode = boardFrame.locator('[data-node-id="approve"]');
  const approveBox = await approveNode.boundingBox();
  if (!approveBox) throw new Error("approve node has no box");
  await page.mouse.click(approveBox.x + approveBox.width / 2, approveBox.y + approveBox.height / 2);
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await expect(page.getByTestId("right-tab-canvas")).toHaveClass(/is-active/);
  await expect(page.getByTestId("canvas-inspector-title")).toHaveText("approve?");
  await expect(approveNode).toHaveClass(/is-selected/);
  await page.getByTestId("canvas-inspector-close").click();
  await expect(approveNode).not.toHaveClass(/is-selected/);
});
