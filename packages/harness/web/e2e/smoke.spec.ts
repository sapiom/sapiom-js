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
import { buildWorkflowPanelHtml } from "../../src/core/canvas-body.js";
import { renderCanvasDocument } from "../../src/core/canvas-template.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("renders the three panes plus the brand header, with no separate action rail", async ({ page }) => {
  await expect(page.locator(".brand-header")).toBeVisible();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeVisible();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".canvas-pane")).toBeVisible();

  // The action rail is retired — actions live on the docked workflow action
  // strip now, anchored to the selected row, not in a standalone column.
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
  const bootTab = page.getByTestId("session-tab-sess-boot");
  await expect(bootTab).toHaveClass(/is-active/);
  await expect(bootTab.locator(".session-dot")).toHaveAttribute("data-status", "running");
});

test("session tabs: one per non-exited session, switching is instant, and the '+' opens the new-session modal", async ({
  page,
}) => {
  const tabs = page.getByTestId("session-tabs").getByRole("tab");
  // Fixture has 2 non-exited sessions ("boot" and "scratch") — the 2 exited
  // ones live in the history menu, not the strip.
  await expect(tabs).toHaveCount(2);

  const bootTab = page.getByTestId("session-tab-sess-boot");
  const bgTab = page.getByTestId("session-tab-sess-bg");
  await expect(bootTab).toHaveClass(/is-active/);
  await expect(bgTab).not.toHaveClass(/is-active/);

  await bgTab.click();
  await expect(bgTab).toHaveClass(/is-active/);
  await expect(bootTab).not.toHaveClass(/is-active/);

  await page.screenshot({ path: "web/e2e/screenshots/session-tabs-idle.png" });

  await page.getByTestId("new-session-btn").click();
  await expect(page.getByText("New session")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("session tabs: Cmd/Ctrl+1..9 switches directly to that tab", async ({ page }) => {
  const bootTab = page.getByTestId("session-tab-sess-boot");
  const bgTab = page.getByTestId("session-tab-sess-bg");
  await expect(bootTab).toHaveClass(/is-active/);

  // Tabs are ordered oldest-first: boot is 1, the background "scratch"
  // session is 2 — Cmd+2 jumps straight to it, no dropdown/click needed.
  await page.keyboard.press("Meta+2");
  await expect(bgTab).toHaveClass(/is-active/);
  await expect(bootTab).not.toHaveClass(/is-active/);

  await page.keyboard.press("Meta+1");
  await expect(bootTab).toHaveClass(/is-active/);
});

test("session tabs: a busy tab shows a pulse that clears once output goes quiet", async ({ page }) => {
  // mock-data's MOCK_ACTIVITY_SESSION_ID ("sess-bg") gets one simulated
  // session.activity ping shortly after load — see lib/events.ts.
  const busyDot = page.getByTestId("session-tab-busy-sess-bg");
  await expect(busyDot).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: "web/e2e/screenshots/session-tabs-busy.png" });

  // The busy window (3s) clears once no further activity arrives.
  await expect(busyDot).toHaveCount(0, { timeout: 6_000 });
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
  await expect(openProd).toHaveAttribute("aria-label", "Open prod: Not deployed yet");

  await page.getByTestId("workflow-action-strip").hover();
  await expect(page.locator(".strip-item-reason")).toHaveText("Not deployed yet");
  await page.screenshot({ path: "web/e2e/screenshots/action-strip-expanded.png" });
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

  test("the boot session's default binding shows a chip on load", async ({ page }) => {
    // Fixture: sess-boot is pre-bound to leasing, so the chip renders without
    // any interaction — useful for anyone eyeballing mock mode, not just tests.
    const chip = page.getByTestId("session-workflow-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("working on leasing");
  });

  test("selecting a different workflow re-binds it and updates the chip", async ({ page }) => {
    await page.getByTestId("workflow-rfq").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("working on rfq");
  });

  test("the binding is per-session: switching sessions shows that session's own binding", async ({ page }) => {
    await expect(page.getByTestId("session-workflow-chip")).toContainText("leasing");

    // Switch to a session that's never had anything bound.
    await page.getByTestId("history-trigger").click();
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

test("resuming a history entry switches the active session, and it rejoins the tab strip", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
  const tab = page.getByTestId("session-tab-sess-leasing");
  await expect(tab).toHaveClass(/is-active/);
  await expect(tab).toContainText("Build the leasing pipeline");
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

  test("Resume on a dead session starts it running again and it becomes a tab", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-resume").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    const tab = page.getByTestId("session-tab-sess-leasing");
    await expect(tab).toBeVisible();
    await expect(tab).toContainText("Build the leasing pipeline");
  });

  test("Close on a dead session removes it and falls back to another running session", async ({ page }) => {
    // The boot session is running, so falling back to it is always possible here.
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await page.getByTestId("dead-session-close").click();

    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
    await expect(page.locator(".terminal-empty")).toHaveCount(0);
    await expect(page.getByTestId("session-tab-sess-boot")).toHaveClass(/is-active/);

    await page.getByTestId("history-trigger").click();
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
    await expect(page.locator(".session-tab.is-active")).toContainText("onboarding-flow");
  });

  test("Enter on a session hit switches to it instead of starting a new one", async ({ page }) => {
    // Resume a different session first so switching back is observable.
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
    const leasingTab = page.getByTestId("session-tab-sess-leasing");
    await expect(leasingTab).toHaveClass(/is-active/);

    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("acme-app");
    await page.getByTestId("command-palette-item-0").click();
    await expect(leasingTab).not.toHaveClass(/is-active/);
  });

  test("a path-shaped query uses live GET /api/fs/list completion instead of fuzzy matching", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    await page.getByTestId("command-palette-input").fill("/Users/demo");

    await expect(page.getByText("Open this path")).toBeVisible();
    const dirItem = page.getByTestId("command-palette-item-1");
    await expect(dirItem).toContainText("acme-app");

    await dirItem.click();
    await expect(page.locator(".session-tab.is-active")).toContainText("acme-app");
  });
});

test("canvas pane shows its empty state for the active session", async ({ page }) => {
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  await expect(page.locator(".canvas-empty")).toContainText(".sapiom/canvas/index.html");
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

test("visualize macro is one click — no subject dialog", async ({ page }) => {
  await expect(page.getByTestId("macro-visualize")).toBeEnabled();

  await page.getByTestId("macro-visualize").click();

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

test.describe("docked workflow action strip", () => {
  test("rows carry no inline icons and show their full untruncated name", async ({ page }) => {
    await expect(page.locator(".workflow-row-actions")).toHaveCount(0);

    // "onboarding-flow" is the longest fixture name — it's the one that used
    // to get squeezed into "onboarding-fl…" by the old inline row icons.
    const name = page.getByTestId("workflow-onboarding-flow").locator(".workflow-name");
    await expect(name).toHaveText("onboarding-flow");
    const overflowing = await name.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflowing).toBe(false);
  });

  test("the strip renders anchored to the selected workflow's row and carries its full action set", async ({
    page,
  }) => {
    const row = page.getByTestId("workflow-leasing");
    const strip = page.getByTestId("workflow-action-strip");
    await expect(strip).toBeVisible();

    const rowBox = await row.boundingBox();
    const stripBox = await strip.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(stripBox).not.toBeNull();
    // Top-aligned to the row, within a pixel or two of rounding.
    expect(Math.abs((stripBox?.y ?? 0) - (rowBox?.y ?? 0))).toBeLessThan(3);

    await expect(strip.getByTestId("macro-run_local")).toBeVisible();
    await expect(strip.getByTestId("macro-deploy")).toBeVisible();
    await expect(strip.getByTestId("macro-prod_run")).toBeVisible();
    await expect(strip.getByTestId("macro-open_prod")).toBeVisible();
    await expect(strip.getByTestId("macro-visualize")).toBeVisible();
    // ONE canvas macro: the old two-button visualize / ai-visualize split is
    // gone — Visualize alone covers structure + AI enrichment server-side.
    await expect(strip.getByTestId("macro-ai-visualize")).toHaveCount(0);
    await expect(strip.locator(".strip-item")).toHaveCount(5);

    await page.screenshot({ path: "web/e2e/screenshots/app-shell-docked-strip.png", fullPage: true });
  });

  test("the strip is icon-only at rest and expands to icon+label on hover", async ({ page }) => {
    const strip = page.getByTestId("workflow-action-strip");

    const restBox = await strip.boundingBox();
    expect(restBox?.width ?? 0).toBeLessThan(30);
    await expect(page.locator(".strip-item-text").first()).toHaveCSS("opacity", "0");

    await strip.hover();
    await expect(async () => {
      const box = await strip.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(150);
    }).toPass({ timeout: 1000 });
    await expect(page.locator(".strip-item-label").first()).toBeVisible();
    await expect(strip.getByText("Run local")).toBeVisible();
    await expect(strip.getByTestId("macro-visualize")).toBeVisible();

    // Expanded, the panel floats directly over the terminal — its
    // background must be fully opaque (`rgb(...)`, no alpha channel), not
    // the translucent `--accent-dim` it used to render with, which let the
    // terminal's own text bleed through and read as broken.
    const backgroundColor = await strip.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(backgroundColor).toMatch(/^rgb\(/);

    await page.screenshot({ path: "web/e2e/screenshots/strip-hover-expanded.png", fullPage: true });
  });

  test("the strip also expands on keyboard focus, not just mouse hover", async ({ page }) => {
    const strip = page.getByTestId("workflow-action-strip");
    const restBox = await strip.boundingBox();
    expect(restBox?.width ?? 0).toBeLessThan(30);

    // Tabbing to an item inside (no mouse involved) should reveal labels via
    // :focus-within, same as a hover would.
    await page.getByTestId("macro-run_local").focus();
    await expect(async () => {
      const box = await strip.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(150);
    }).toPass({ timeout: 1000 });
    await expect(page.getByTestId("macro-run_local")).toBeFocused();
    await expect(strip.getByText("Run local")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/strip-keyboard-focus-expanded.png", fullPage: true });
  });

  test("the strip moves when selection changes, and the notch tracks the new row", async ({ page }) => {
    const rfqRow = page.getByTestId("workflow-rfq");
    await rfqRow.locator(".workflow-item-trigger").click();

    const strip = page.getByTestId("workflow-action-strip");
    const notch = page.getByTestId("workflow-action-strip-notch");
    const rowBox = await rfqRow.boundingBox();

    // The strip/notch slide to their new anchor over a short CSS transition —
    // wait it out so the bounding box reflects the settled position, not a
    // mid-animation frame.
    await expect(async () => {
      const stripBox = await strip.boundingBox();
      expect(Math.abs((stripBox?.y ?? 0) - (rowBox?.y ?? 0))).toBeLessThan(3);
    }).toPass({ timeout: 1000 });

    const stripBox = await strip.boundingBox();
    const notchBox = await notch.boundingBox();
    expect(Math.abs((notchBox?.y ?? 0) - (rowBox?.y ?? 0))).toBeLessThan(3);
    // The notch is sized to the row, not the whole multi-icon strip below it.
    expect(notchBox?.height ?? 0).toBeLessThan(stripBox?.height ?? Infinity);

    await page.screenshot({ path: "web/e2e/screenshots/workflow-action-strip-moved.png", fullPage: true });
  });

  test("the canvas header stays fully on-screen even when the app is narrower than the default pane widths", async ({
    page,
  }) => {
    // Rail (220) + strip (32) + terminal floor (360) + canvas (420) = 1032px
    // of default/preferred widths — narrower than that used to overflow
    // .app's right edge and get silently clipped by its old overflow:hidden.
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
    // "leasing" (short) and "onboarding-flow" (long) are both deployed in
    // the fixtures specifically to exercise this — the dot used to trail
    // right after the name, so it visibly jumped between the two.
    const dot = page.locator(".workflow-actions-header .workflow-dot");
    const leasingBox = await dot.boundingBox();
    expect(leasingBox).not.toBeNull();

    await page.getByTestId("workflow-onboarding-flow").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("workflow-actions-header")).toContainText("onboarding-flow");
    const onboardingBox = await dot.boundingBox();
    expect(onboardingBox).not.toBeNull();

    expect(onboardingBox?.x).toBeCloseTo(leasingBox?.x ?? 0, 0);

    await dot.hover();
    await expect(page.locator(".workflow-dot-pinned")).toHaveAttribute("data-tooltip", "Deployed to production");
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
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  await expect(page.locator(".canvas-empty")).toContainText(".sapiom/canvas/index.html");

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
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
});

test("a canvas.reload bus message swaps the empty state for the generated iframe", async ({ page }) => {
  await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");

  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });

  await expect(page.locator(".canvas-empty")).toHaveCount(0);
  await expect(page.locator(".canvas-iframe")).toHaveAttribute("src", /^\/canvas\/sess-boot\/\?theme=(light|dark)$/);
});

test("a stale enrichment renders with the 'stale — Refresh' chip in the served canvas document", async ({ page }) => {
  // The chip is server-rendered (core/canvas-render.ts marks an enrichment
  // whose fingerprint no longer matches the sources) — serve the REAL
  // renderer's output for that state into the pane's iframe and assert the
  // chip actually displays through the sandboxed-iframe pipeline.
  const staleDocument = renderCanvasDocument(
    buildWorkflowPanelHtml(
      {
        manifestName: "leasing",
        entry: "intake",
        warnings: [],
        nodes: [{ id: "intake", kind: "entry", label: "intake" }],
        edges: [],
      },
      { title: "leasing", badges: ["local only"] },
      { enrichment: { summary: "Handles lease applications end to end" }, stale: true },
    ),
  );
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
  await page.screenshot({ path: "web/e2e/screenshots/canvas-stale-chip.png" });
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

  // While the iframe document is in flight: skeleton visible, no bare pane.
  await expect(page.getByTestId("canvas-loading")).toBeVisible();
  await expect(page.getByTestId("canvas-loading")).toContainText("Rendering diagram");

  releaseCanvas();
  await expect(page.getByTestId("canvas-loading")).toHaveCount(0);
  await expect(page.locator(".canvas-iframe")).toBeVisible();
});

test("switching the bound workflow refetches the canvas immediately — the server resolves the binding per request", async ({
  page,
}) => {
  let canvasRequests = 0;
  await page.route("**/canvas/sess-boot/**", async (route) => {
    canvasRequests += 1;
    await route.fulfill({ contentType: "text/html", body: "<html><body>diagram</body></html>" });
  });

  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-iframe")).toBeVisible();
  await expect.poll(() => canvasRequests).toBeGreaterThan(0);
  const requestsBeforeBind = canvasRequests;

  // Re-bind to a different workflow: the pane must refetch the same URL on
  // its own (the served document changes with the binding) — no canvas.reload
  // round-trip required first.
  await page.getByTestId("workflow-rfq").click();
  await expect(page.getByTestId("session-workflow-chip")).toContainText("working on rfq");
  await expect.poll(() => canvasRequests).toBeGreaterThan(requestsBeforeBind);
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
    await expect(activity.locator(".canvas-task-spinner")).toBeVisible();

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
    // sess-boot's own pane still shows its ordinary empty state.
    await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
  });

  test("activity is scoped to the BOUND WORKFLOW — another workflow's task never bleeds into this pane", async ({
    page,
  }) => {
    // Same session, but the task targets a workflow that is NOT the pane's
    // current binding (sess-boot is bound to leasing) — hidden.
    await publish(page, { ...baseTask, workflowPath: "/Users/demo/onboarding-flow", status: "running" });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);
    await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");

    // The bound workflow's own task shows...
    await publish(page, { ...baseTask, id: "task-2", status: "running" });
    await expect(page.getByTestId("canvas-task-activity")).toBeVisible();

    // ...and switching the binding mid-run hides it again: the rfq pane must
    // not show leasing's enrichment progress.
    await page.getByTestId("workflow-rfq").click();
    await expect(page.getByTestId("session-workflow-chip")).toContainText("working on rfq");
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

    // Dismiss hides the failure panel and returns the pane to its usual state.
    await page.getByTestId("canvas-task-dismiss").click();
    await expect(page.getByTestId("canvas-task-failed")).toHaveCount(0);
    await expect(page.locator(".canvas-empty")).toContainText("Nothing generated yet");
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
    expect(canvasWidth).toBeGreaterThanOrEqual(278); // CANVAS_MIN = 280, small rounding slack
    expect(canvasWidth).toBeLessThan(295);
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
    expect(Math.abs(railWidth - 220)).toBeLessThan(3);
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
  await expect(iframe).toHaveAttribute("src", /theme=light/);

  await page.getByTestId("theme-toggle").click();
  await expect(iframe).toHaveAttribute("src", /theme=dark/);
});

// ---------------------------------------------------------------------------
// Prompt bar
// ---------------------------------------------------------------------------
//
// The bar lives beneath the terminal in the center pane. All specs drive the
// mock tier via `__HARNESS_TEST__` — no real server needed.

type TestHarness = {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    lastInjectInput?: { id: string; req: { text: string; submit?: boolean } };
  };
};

const publish = (page: import("@playwright/test").Page, message: unknown): Promise<void> =>
  page.evaluate((m) => {
    (window as unknown as TestHarness).__HARNESS_TEST__.publish(m);
  }, message);

// Pushes a session.status frame to flip the active session to not-ready.
const setSessionNotReady = (page: import("@playwright/test").Page): Promise<void> =>
  publish(page, {
    type: "session.status",
    session: {
      id: "sess-boot",
      agentSessionId: null,
      boundWorkflowPath: "/Users/demo/acme-app/leasing",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "acme-app",
      status: "starting",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ready: false,
    },
  });

// Restores the session to ready.
const setSessionReady = (page: import("@playwright/test").Page): Promise<void> =>
  publish(page, {
    type: "session.status",
    session: {
      id: "sess-boot",
      agentSessionId: null,
      boundWorkflowPath: "/Users/demo/acme-app/leasing",
      harness: "claude-code",
      cwd: "/Users/demo/acme-app",
      title: "acme-app",
      status: "running",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ready: true,
    },
  });

test.describe("prompt bar", () => {
  test("is visible beneath the terminal when a session is active", async ({ page }) => {
    await expect(page.locator(".prompt-bar")).toBeVisible();
    await expect(page.locator(".prompt-bar-textarea")).toBeVisible();
    await expect(page.getByTestId("prompt-bar-submit")).toBeVisible();
    await page.screenshot({ path: "web/e2e/screenshots/prompt-bar-idle.png" });
  });

  test.describe("parameterized by harness kind: claude-code and codex", () => {
    for (const harness of ["claude-code", "codex"] as const) {
      test(`submit flow is identical for ${harness}`, async ({ page }) => {
        // Switch to a session of the target harness kind by publishing a
        // session.status frame. sess-boot is claude-code, sess-bg is claude-code too;
        // use a synthetic not-yet-in-list session for codex so this is self-contained.
        if (harness === "codex") {
          await publish(page, {
            type: "session.status",
            session: {
              id: "sess-codex-test",
              agentSessionId: null,
              boundWorkflowPath: null,
              harness: "codex",
              cwd: "/home/user/projects/rfq",
              title: "rfq",
              status: "running",
              createdAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              ready: true,
            },
          });
          // The SPA adds the session to state via session.status — click the tab.
          const codexTab = page.getByTestId("session-tab-sess-codex-test");
          await expect(codexTab).toBeVisible({ timeout: 3_000 });
          await codexTab.click();
          await expect(codexTab).toHaveClass(/is-active/);
        }

        // Prompt bar must be present and enabled.
        const textarea = page.locator(".prompt-bar-textarea");
        const submitBtn = page.getByTestId("prompt-bar-submit");
        await expect(textarea).toBeVisible();
        await expect(submitBtn).toBeVisible();

        // Type a prompt and submit with Enter.
        await textarea.click();
        await textarea.fill("Hello agent");
        await textarea.press("Enter");

        // Wait for MockApi to record the submission.
        await page.waitForFunction(
          () =>
            (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text === "Hello agent",
        );

        const captured = await page.evaluate(
          () => (window as unknown as TestHarness).__HARNESS_TEST__.lastInjectInput,
        );
        expect(captured?.req.text).toBe("Hello agent");
        expect(captured?.req.submit).toBe(true);

        // Textarea clears after successful submit.
        await expect(textarea).toHaveValue("");

        // Focus returns to the bar after submit so the user can type a
        // follow-up immediately (the component calls .focus() on success).
        // Re-click to set focus explicitly and confirm the element is focusable.
        await textarea.click();
        await expect(textarea).toBeFocused();
      });
    }
  });

  test("Shift+Enter inserts a newline without submitting", async ({ page }) => {
    const textarea = page.locator(".prompt-bar-textarea");
    await textarea.click();
    await textarea.fill("Line one");
    await textarea.press("Shift+Enter");

    // No submission recorded — Enter alone submits, Shift+Enter must not.
    const captured = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );
    expect(captured).toBeUndefined();

    // The textarea value must contain a literal newline after the original text.
    const value = await textarea.inputValue();
    expect(value).toContain("Line one");
    expect(value).toContain("\n");
  });

  test("not-ready session: bar is disabled with reason text, draft is preserved", async ({ page }) => {
    // Make the session not-ready via a bus message.
    await setSessionNotReady(page);

    const textarea = page.locator(".prompt-bar-textarea");
    const status = page.getByTestId("prompt-bar-status");

    // Bar becomes disabled.
    await expect(textarea).toBeDisabled({ timeout: 3_000 });
    // Reason text is visible.
    await expect(status).toBeVisible();
    await expect(status).toContainText(/starting|initialising/i);

    // Pre-set draft survives the transition — fill before disabling then check.
    // Reset to ready first, fill the textarea, then flip to not-ready.
    await setSessionReady(page);
    await expect(textarea).toBeEnabled({ timeout: 3_000 });
    await textarea.fill("draft that must survive");

    await setSessionNotReady(page);
    await expect(textarea).toBeDisabled({ timeout: 3_000 });
    // The value attr is still present — the element is disabled, not cleared.
    await expect(textarea).toHaveValue("draft that must survive");

    await page.screenshot({ path: "web/e2e/screenshots/prompt-bar-not-ready.png" });
  });

  test("per-session drafts: switching tabs preserves each session's own draft, no cross-leakage", async ({
    page,
  }) => {
    // Ensure a second ready session exists and is visible in the tab strip.
    // sess-bg is already in the mock fixtures as a running session.
    const bootTab = page.getByTestId("session-tab-sess-boot");
    const bgTab = page.getByTestId("session-tab-sess-bg");

    // Type in session A (boot).
    await expect(bootTab).toHaveClass(/is-active/);
    const textarea = page.locator(".prompt-bar-textarea");
    await textarea.click();
    await textarea.fill("draft for session A");

    // Switch to session B (bg) — bar must be empty.
    await bgTab.click();
    await expect(bgTab).toHaveClass(/is-active/);
    await expect(textarea).toHaveValue("");

    // Type in session B.
    await textarea.click();
    await textarea.fill("draft for session B");

    // Switch back to session A — A's draft must be restored.
    await bootTab.click();
    await expect(bootTab).toHaveClass(/is-active/);
    await expect(textarea).toHaveValue("draft for session A");

    // Switch back to B — B's draft also intact.
    await bgTab.click();
    await expect(textarea).toHaveValue("draft for session B");
  });

  test("bar re-enables when the session becomes ready again", async ({ page }) => {
    await setSessionNotReady(page);
    const textarea = page.locator(".prompt-bar-textarea");
    await expect(textarea).toBeDisabled({ timeout: 3_000 });

    await setSessionReady(page);
    await expect(textarea).toBeEnabled({ timeout: 3_000 });

    // Reason text disappears once ready.
    await expect(page.getByTestId("prompt-bar-status")).toHaveCount(0);
  });

  test("409-on-submit: reactive reason shown, bar stays ENABLED, draft intact, immediate retry succeeds", async ({
    page,
  }) => {
    // Arm the MockApi 409 simulation — consumed exactly once on the next injectInput call.
    await page.evaluate(() => {
      (window as unknown as { __MOCK_INJECT_FAIL_ONCE__?: boolean }).__MOCK_INJECT_FAIL_ONCE__ = true;
    });

    const textarea = page.locator(".prompt-bar-textarea");
    const status = page.getByTestId("prompt-bar-status");

    // Session starts proactively ready — bar is enabled.
    await expect(textarea).toBeEnabled();

    // Type and submit — MockApi throws 409 once.
    await textarea.click();
    await textarea.fill("my draft text");
    await textarea.press("Enter");

    // Reactive reason must appear, draft must be intact...
    await expect(status).toBeVisible({ timeout: 3_000 });
    await expect(status).toContainText(/initialising/i);
    await expect(textarea).toHaveValue("my draft text");

    // ...AND the bar must remain ENABLED (reactive informs, never gates).
    // This is the core two-tier semantics fix: a 409 while the session is
    // proactively ready must never permanently lock the bar.
    await expect(textarea).toBeEnabled();

    // Immediate retry — no not-ready→ready dance required.
    // The flag was consumed; MockApi now behaves normally.
    await textarea.press("Enter");
    await page.waitForFunction(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text === "my draft text",
    );
    const captured = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__.lastInjectInput,
    );
    expect(captured?.req.text).toBe("my draft text");

    // Successful submit clears the reactive reason and the draft.
    await expect(status).toHaveCount(0, { timeout: 3_000 });
    await expect(textarea).toHaveValue("");

    await page.screenshot({ path: "web/e2e/screenshots/prompt-bar-409-reactive.png" });
  });

  test("409 reactive reason disappears on the first keystroke the user types", async ({ page }) => {
    // Arm 409, submit once to trigger the reactive reason.
    await page.evaluate(() => {
      (window as unknown as { __MOCK_INJECT_FAIL_ONCE__?: boolean }).__MOCK_INJECT_FAIL_ONCE__ = true;
    });

    const textarea = page.locator(".prompt-bar-textarea");
    const status = page.getByTestId("prompt-bar-status");

    await textarea.click();
    await textarea.fill("something");
    await textarea.press("Enter");
    await expect(status).toBeVisible({ timeout: 3_000 });

    // First edit keystroke: the reactive reason is immediately acknowledged
    // and the status element disappears — no need to submit or wait.
    await textarea.fill("something edited");
    await expect(status).toHaveCount(0, { timeout: 3_000 });
  });

  test("bar does not steal focus from the terminal on initial load", async ({ page }) => {
    // On load the terminal's hidden xterm textarea has focus (or no element has
    // focus) — the prompt bar must not have auto-focused itself.
    const focused = await page.evaluate(() => document.activeElement?.className ?? "");
    expect(focused).not.toContain("prompt-bar-textarea");
  });

  test("submit button is disabled when the textarea is empty", async ({ page }) => {
    const submitBtn = page.getByTestId("prompt-bar-submit");
    const textarea = page.locator(".prompt-bar-textarea");

    // Ensure empty.
    await textarea.fill("");
    await expect(submitBtn).toBeDisabled();

    // Type something — button enables.
    await textarea.fill("x");
    await expect(submitBtn).toBeEnabled();
  });

  test("keyboard accessibility: bar is reachable via Tab and submits via Enter", async ({ page }) => {
    // Tab to the textarea.
    await page.keyboard.press("Tab");
    // Depending on prior focus, keep tabbing until we reach it.
    // Use a targeted click instead to be deterministic.
    const textarea = page.locator(".prompt-bar-textarea");
    await textarea.focus();
    await expect(textarea).toBeFocused();

    await textarea.fill("keyboard test");
    await page.keyboard.press("Enter");

    await page.waitForFunction(
      () =>
        (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text === "keyboard test",
    );
    const captured = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__.lastInjectInput,
    );
    expect(captured?.req.text).toBe("keyboard test");
  });
});
