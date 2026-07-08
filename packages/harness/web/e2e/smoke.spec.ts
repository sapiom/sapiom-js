/**
 * Mock-mode UI smoke test — runs against `vite dev` with VITE_MOCK=1 (see
 * playwright.config.ts), no harness server required. Fixtures live in
 * ../src/lib/mock-data.ts: 3 workflows (one deployed), a running "boot"
 * session (the server auto-creates one at launch) plus 2 exited sessions
 * kept around as resumable history, 5 macros, and a small fake filesystem
 * for the new-session directory picker.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("renders all four panes plus the brand header", async ({ page }) => {
  await expect(page.locator(".brand-header")).toBeVisible();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeVisible();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".canvas-pane")).toBeVisible();
  await expect(page.locator(".rail-actions")).toBeVisible();

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

test("theme: defaults to light, toggles to dark, and the choice persists across reload", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "web/e2e/screenshots/theme-light.png", fullPage: true });

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "web/e2e/screenshots/theme-dark.png", fullPage: true });

  await page.reload();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test.describe("theme — system preference", () => {
  test.use({ colorScheme: "dark" });

  test("honors prefers-color-scheme when there's no stored preference yet", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test("brand header shows the Sapiom wordmark and signed-in identity", async ({ page }) => {
  await expect(page.locator(".brand-name")).toHaveText("Sapiom");
  await expect(page.locator(".brand-product")).toHaveText("Harness");
  const identity = page.getByTestId("brand-identity");
  await expect(identity).toContainText("Acme (mock)");
  await expect(page.locator(".identity-dot")).toHaveAttribute("data-authenticated", "true");
});

test("auto-selects the running boot session on initial load", async ({ page }) => {
  // The server auto-creates a session in launchDir at boot — the app should
  // never open to an empty terminal pane.
  await expect(page.locator(".terminal-empty")).toHaveCount(0);
  await expect(page.getByTestId("session-dropdown-trigger")).not.toContainText("No session");
  await expect(page.locator(".session-dot[data-status='running']")).toBeVisible();
});

test("workflows rail lists the fixtures and selecting one drives macro gating", async ({ page }) => {
  await expect(page.locator(".workflow-item")).toHaveCount(3);

  // "leasing" is deployed (has a definitionId) — selecting it enables the deploy-link macro.
  const openProd = page.getByTestId("macro-open_prod");
  await page.getByTestId("workflow-leasing").click();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-selected/);
  await expect(openProd).toBeEnabled();

  // "rfq" has no definitionId — selecting it should disable the deploy-link macro again,
  // with a reason distinct from "no workflow selected".
  await page.getByTestId("workflow-rfq").click();
  await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-selected/);
  await expect(openProd).toBeDisabled();
  await expect(openProd).toHaveAttribute("data-tooltip", "Not deployed yet");

  await openProd.hover();
  await page.screenshot({ path: "web/e2e/screenshots/action-rail-tooltip.png" });
});

test("inject macros are enabled once the boot session and a deployed workflow are active", async ({ page }) => {
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-selected/);
  await expect(page.getByTestId("macro-run_local")).toBeEnabled();
  await expect(page.getByTestId("macro-deploy")).toBeEnabled();
});

test.describe("workspace binding", () => {
  test("the rail groups workflows into a tree: active session's directory first, others below", async ({ page }) => {
    // Boot session's cwd is /Users/demo/acme-app, which owns "leasing".
    const activeGroup = page.getByTestId("workspace-group-acme-app");
    await expect(activeGroup).toBeVisible();
    await expect(page.locator(".workspace-group.is-active")).toContainText("acme-app");

    // "rfq" lives under /Users/demo/rfq-workflows, a different known session's directory.
    await expect(page.getByTestId("workspace-group-rfq-workflows")).toBeVisible();

    // "onboarding-flow" isn't under any known session's directory.
    await expect(page.getByText("Other")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/workspace-tree.png", fullPage: true });
  });

  test("selecting a workflow binds it to the active session and shows a chip", async ({ page }) => {
    await expect(page.getByTestId("session-workflow-chip")).toHaveCount(0);

    await page.getByTestId("workflow-leasing").click();
    const chip = page.getByTestId("session-workflow-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("working on leasing");
  });

  test("the binding is per-session: switching sessions shows that session's own binding", async ({ page }) => {
    await page.getByTestId("workflow-leasing").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("leasing");

    // Switch to a session that's never had anything bound.
    await page.getByTestId("session-dropdown-trigger").click();
    await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
    await expect(page.getByTestId("session-workflow-chip")).toHaveCount(0);
  });
});

test("new-session modal: directory picker navigates and validates", async ({ page }) => {
  await page.getByTestId("new-session-btn").click();
  await expect(page.getByText("New session")).toBeVisible();

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
  await expect(page.getByText("New session")).toBeHidden();
});

test("resuming a history entry switches the active session", async ({ page }) => {
  await page.getByTestId("session-dropdown-trigger").click();
  await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
  await expect(page.getByTestId("session-dropdown-trigger")).toContainText("Build the leasing pipeline");
});

test.describe("dead sessions never trap the user", () => {
  test("an exited session is reachable from the dropdown and shows a dead-session pane, not a stuck terminal", async ({
    page,
  }) => {
    await page.getByTestId("session-dropdown-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();

    const pane = page.getByTestId("dead-session-pane");
    await expect(pane).toBeVisible();
    await expect(pane).toContainText("Session exited");
    await expect(pane).toContainText("exit code 0");
    await expect(page.locator(".harness-terminal")).toHaveCount(0);

    await page.screenshot({ path: "web/e2e/screenshots/dead-session-pane.png", fullPage: true });
  });

  test("Resume on a dead session starts it running again", async ({ page }) => {
    await page.getByTestId("session-dropdown-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-resume").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.getByTestId("session-dropdown-trigger")).toContainText("Build the leasing pipeline");
  });

  test("Close on a dead session removes it and falls back to another running session", async ({ page }) => {
    // The boot session is running, so falling back to it is always possible here.
    await page.getByTestId("session-dropdown-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-close").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.getByTestId("session-dropdown-trigger")).not.toContainText("No session");

    await page.getByTestId("session-dropdown-trigger").click();
    await expect(page.getByTestId("exited-session-sess-leasing")).toHaveCount(0);
  });
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
    await expect(page.getByTestId("session-dropdown-trigger")).toContainText("onboarding-flow");
  });

  test("Enter on a session hit switches to it instead of starting a new one", async ({ page }) => {
    // Resume a different session first so switching back is observable.
    await page.getByTestId("session-dropdown-trigger").click();
    await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
    await expect(page.getByTestId("session-dropdown-trigger")).toContainText("Build the leasing pipeline");

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("acme-app");
    await page.getByTestId("command-palette-item-0").click();
    await expect(page.getByTestId("session-dropdown-trigger")).not.toContainText("Build the leasing pipeline");
  });

  test("a path-shaped query uses live GET /api/fs/list completion instead of fuzzy matching", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("/Users/demo");

    await expect(page.getByText("Open this path")).toBeVisible();
    const dirItem = page.getByTestId("command-palette-item-1");
    await expect(dirItem).toContainText("acme-app");

    await dirItem.click();
    await expect(page.getByTestId("session-dropdown-trigger")).toContainText("acme-app");
  });
});

test("canvas pane shows its empty state for the active session", async ({ page }) => {
  await expect(page.locator(".canvas-empty")).toContainText("Nothing rendered yet");
});

test("settings popover: identity, telemetry toggle, and it persists across close/reopen", async ({ page }) => {
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

  await page.getByRole("button", { name: "Close" }).click();
  await expect(popover).toBeHidden();

  // Reopening should reflect the same (mutated) state, not reset to the fixture default.
  await trigger.click();
  await expect(page.getByTestId("telemetry-toggle")).toHaveAttribute("aria-checked", "true");
});

test("visualize macro prompts for a subject before running", async ({ page }) => {
  await expect(page.getByTestId("macro-visualize")).toBeEnabled();

  await page.getByTestId("macro-visualize").click();
  await expect(page.getByText("Visualize")).toBeVisible();
  const subjectInput = page.getByPlaceholder("What should the agent visualize?");
  await expect(subjectInput).toBeVisible();

  await subjectInput.fill("the leasing pipeline");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(subjectInput).toBeHidden();
});
