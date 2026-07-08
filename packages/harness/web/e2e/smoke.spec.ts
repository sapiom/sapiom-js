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
    await expect(strip.getByText("Visualize")).toBeVisible();

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
