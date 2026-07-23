/**
 * Cost-removal guard (SAP-1783) — dedicated "cost is gone" Playwright suite.
 *
 * Asserts that NO cost-related UI renders anywhere in the Studio across all
 * inspectable surfaces, after the full strip (SAP-1775 removed WalletCard,
 * WorkflowPriceNote, per-step cost; SAP-1769 removed server /spend +
 * /transactions routes).
 *
 * Surfaces walked:
 *   1. App shell chrome: brand header, rail, session bar, macro strip
 *   2. Canvas overview panel (board-level, before step selection)
 *   3. Canvas step inspector (board pick, post-run)
 *   4. Steps accordion tab (pre-run and with run truth)
 *   5. Code tab — snippet panel (leasing is deployed)
 *   6. Settings popover
 *   7. History menu + dead-session pane
 *   8. DOM: WalletCard / run-cost / wallet-related class names are absent
 *
 * False-positive avoidance:
 *   - "credit" in the mock data refers to the "credit-check" agent STEP (a
 *     business-domain term, not a financial affordance). Assertions avoid that
 *     word; instead they target the *affordance layer*: UI labels/class names
 *     that indicate a cost surface (wallet, balance, spend, price, transaction,
 *     and the "$" currency sign in Studio chrome).
 *   - "$" scoping: assertions exclude <pre>/<code> elements and the terminal
 *     emitter (xterm), which contain code samples and TTY output — never cost
 *     affordances. The Studio chrome (labels, buttons, headings, paragraphs)
 *     is the target.
 *   - The snippet panel cURL block uses "x-sapiom-api-key: YOUR_SAPIOM_API_KEY"
 *     (no "$" character), so it passes naturally.
 *   - The settings popover's "$ENV_VAR" branch only renders when
 *     consentSource === "env-forced-off", which is never the default mock state.
 *
 * Network-call guard:
 *   page.route() intercepts every request whose URL contains "/spend" or
 *   "/transactions" during a full run+inspect flow; the test fails if any
 *   such call is observed.
 *
 * Runs against `vite dev` with VITE_MOCK=1 (playwright.config.ts) — no
 * harness server required.
 */
import { expect, test, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Arm the network sentinel: any request to /spend or /transactions during the
 *  test is captured and the test fails on assertion. */
function armNetworkSentinel(page: Page): { hits: string[] } {
  const hits: string[] = [];
  // Use a broad regex so path-only and query-string variants are both caught.
  page.route(/\/(spend|transactions)(\?.*)?$/, async (route) => {
    hits.push(route.request().url());
    // Fulfill so the SPA does not crash — we want to complete all assertions
    // before failing cleanly at the assertion step.
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return { hits };
}

/** Load the board so the canvas overview panel renders. */
async function loadBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
}

/** Fire execution.started so the mock API polls the run-state fixture
 *  (per-step status + latency, no cost). */
async function triggerRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-cost-guard-1",
      target: "prod",
    });
  });
}

/**
 * Assert the dollar sign ("$") is absent from the Studio chrome elements
 * inside `container`. Excludes:
 *   - <pre> and <code> elements: code samples in the snippet panel
 *   - .xterm-rows (terminal emitter): TTY output is not Studio chrome
 *   - style/script tags: not rendered text
 * The remaining text is what a user reads in the Studio UI.
 */
async function assertNoDollarInChrome(container: ReturnType<Page["locator"]>, label: string): Promise<void> {
  const chromeCopy = await container.evaluate((el: Element): string => {
    const clone = el.cloneNode(true) as Element;
    const strip = (sel: string): void => {
      for (const node of Array.from(clone.querySelectorAll(sel))) {
        node.textContent = "";
      }
    };
    strip("pre");
    strip("code");
    strip(".xterm-rows");
    strip("style");
    strip("script");
    return clone.textContent ?? "";
  });
  expect(chromeCopy, `dollar sign ("$") found in Studio chrome: ${label}`).not.toContain("$");
}

/**
 * Assert that known cost-UI affordance words are absent from the given
 * container's chrome text (same stripping as assertNoDollarInChrome).
 *
 * Deliberately does NOT include "credit" — that word appears in the demo
 * fixture as a step name ("credit-check") and is a domain term, not a
 * financial affordance.
 */
async function assertNoCostAffordance(container: ReturnType<Page["locator"]>, label: string): Promise<void> {
  const chromeCopy = await container.evaluate((el: Element): string => {
    const clone = el.cloneNode(true) as Element;
    const strip = (sel: string): void => {
      for (const node of Array.from(clone.querySelectorAll(sel))) {
        node.textContent = "";
      }
    };
    strip("pre");
    strip("code");
    strip(".xterm-rows");
    strip("style");
    strip("script");
    return clone.textContent ?? "";
  });

  const costPatterns: Array<[RegExp, string]> = [
    [/\bwallet\b/i, "wallet"],
    [/\bbalance\b/i, "balance"],
    [/\bspend\b/i, "spend"],
    [/\bprice\b/i, "price"],
    [/\btransaction/i, "transaction"],
  ];
  for (const [pattern, name] of costPatterns) {
    expect(chromeCopy, `cost affordance "${name}" found in Studio chrome: ${label}`).not.toMatch(pattern);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("cost-removed guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Network sentinel — no /spend or /transactions calls during a full
  // run+inspect session flow.
  // -------------------------------------------------------------------------
  test("no /spend or /transactions calls are made during a full run+inspect flow", async ({ page }) => {
    const sentinel = armNetworkSentinel(page);

    // Load the board and trigger a prod run
    await loadBoard(page);
    await triggerRun(page);

    // Navigate through every inspectable surface
    await page.getByTestId("right-tab-steps").click();
    await page.getByTestId("right-tab-code").click();
    await page.getByTestId("right-tab-canvas").click();

    // Settings
    await page.getByTestId("brand-identity").click();
    await page.getByTestId("settings-trigger").click();
    await page.keyboard.press("Escape");

    // History menu
    await page.getByTestId("history-trigger").click();
    await page.keyboard.press("Escape");

    // Allow any pending async calls to settle
    await page.waitForTimeout(500);

    expect(sentinel.hits, `unexpected /spend or /transactions calls: ${sentinel.hits.join(", ")}`).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Surface 1: Studio chrome — brand header, rail, session bar, macro strip
  // (Scoped containers; the full .app includes xterm and other non-chrome areas)
  // -------------------------------------------------------------------------
  test("brand header and session bar have no cost affordances", async ({ page }) => {
    const brandHeader = page.locator(".brand-header");
    await expect(brandHeader).toBeVisible();
    await assertNoDollarInChrome(brandHeader, "brand header");
    await assertNoCostAffordance(brandHeader, "brand header");

    const sessionBar = page.locator(".session-bar");
    await expect(sessionBar).toBeVisible();
    await assertNoDollarInChrome(sessionBar, "session bar");
    await assertNoCostAffordance(sessionBar, "session bar");
  });

  test("workflow macro strip has no cost affordances", async ({ page }) => {
    const stepsBar = page.locator(".session-steps");
    await expect(stepsBar).toBeVisible();
    await assertNoDollarInChrome(stepsBar, "macro strip");
    await assertNoCostAffordance(stepsBar, "macro strip");

    // The lifecycle chip label is "Deployed" or "Draft" — not a cost term
    const chip = page.getByTestId("session-lifecycle-chip");
    await expect(chip).toBeVisible();
    await expect(chip).not.toContainText("wallet");
    await expect(chip).not.toContainText("spend");
    await expect(chip).not.toContainText("price");
  });

  // -------------------------------------------------------------------------
  // Surface 2: Canvas overview panel (board-level)
  // -------------------------------------------------------------------------
  test("canvas overview panel has no cost affordances", async ({ page }) => {
    await loadBoard(page);

    const overview = page.getByTestId("canvas-overview");
    await expect(overview).toBeVisible();
    // The overview description contains "credit check" (a step name, not a
    // financial term) — we check affordance words only, not "credit".
    await assertNoDollarInChrome(overview, "canvas overview panel");
    await assertNoCostAffordance(overview, "canvas overview panel");
  });

  // -------------------------------------------------------------------------
  // Surface 3: Canvas step inspector — board pick of a run-populated step
  // -------------------------------------------------------------------------
  test("canvas step inspector after a run carries status/latency only — no cost affordances", async ({ page }) => {
    await loadBoard(page);
    await triggerRun(page);

    // Wait for the run-state mock poll to settle (~120ms in MockApi)
    await page.waitForTimeout(300);

    // Pick the credit-check node via the iframe gesture layer
    const frame = page.frameLocator(".canvas-iframe");
    const node = frame.locator('[data-node-id="credit-check"]');
    await expect(node).toBeVisible({ timeout: 5_000 });
    const box = await node.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }

    const inspector = page.getByTestId("canvas-step-inspector");
    await expect(inspector).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("credit-check");

    // The run block must show status + latency
    const run = page.getByTestId("canvas-inspector-run");
    await expect(run).toBeVisible();
    await expect(run).toContainText("passed");
    await expect(run).toContainText("1.9s");

    // Inspector chrome: no cost affordances and no "$"
    await assertNoDollarInChrome(inspector, "canvas step inspector");
    await assertNoCostAffordance(inspector, "canvas step inspector");

    // Explicitly: no dollar sign in the run block
    await expect(run).not.toContainText("$");
  });

  // -------------------------------------------------------------------------
  // Surface 4: Steps accordion tab (pre-run and with run truth)
  // -------------------------------------------------------------------------
  test("steps tab has no cost affordances (empty state)", async ({ page }) => {
    // Scratch session has no board — clean empty state on the Steps tab
    await page.getByTestId("workspace-focus-scratch").click();
    await page.getByTestId("right-tab-steps").click();

    const stepsEmpty = page.locator(".canvas-empty");
    await expect(stepsEmpty).toBeVisible();
    await assertNoDollarInChrome(stepsEmpty, "steps tab empty state");
    await assertNoCostAffordance(stepsEmpty, "steps tab empty state");
  });

  test("steps tab with a populated run has no cost affordances", async ({ page }) => {
    // Must be on leasing / boot session with its board loaded first
    await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
    await loadBoard(page);
    await page.getByTestId("right-tab-steps").click();
    await triggerRun(page);
    await page.waitForTimeout(300);

    // The steps list renders under .canvas-pane (the right-pane container)
    const stepsPanel = page.locator(".canvas-pane");
    await assertNoDollarInChrome(stepsPanel, "steps tab with run");
    await assertNoCostAffordance(stepsPanel, "steps tab with run");

    // Explicit: the step-run-note shows "prod run" (not a cost label)
    const runNote = page.getByTestId("canvas-steps-run-note");
    await expect(runNote).toContainText("run");
    await expect(runNote).not.toContainText("$");
    await expect(runNote).not.toContainText("wallet");
    await expect(runNote).not.toContainText("spend");
  });

  // -------------------------------------------------------------------------
  // Surface 5: Code tab — snippet panel (leasing is deployed)
  // -------------------------------------------------------------------------
  test("snippet panel has no cost affordances", async ({ page }) => {
    await page.getByTestId("right-tab-code").click();

    const snippetPanel = page.getByTestId("snippet-panel");
    await expect(snippetPanel).toBeVisible();

    // Chrome text (labels, hint, slugs) has no cost terms
    await assertNoDollarInChrome(snippetPanel, "snippet panel");
    await assertNoCostAffordance(snippetPanel, "snippet panel");

    // Verify the cURL snippet has no $VAR-style shell expansions
    // (the API key placeholder is a literal string, not a $VAR)
    await page.getByTestId("snippet-tab-curl").click();
    const curlText = await page.getByTestId("snippet-code").textContent();
    expect(curlText).not.toMatch(/\$\w/); // no $ENV_VAR expansions
    expect(curlText).not.toMatch(/wallet|balance|spend|price|transaction/i);
  });

  // -------------------------------------------------------------------------
  // Surface 6: Settings popover
  // -------------------------------------------------------------------------
  test("settings popover has no cost affordances", async ({ page }) => {
    await page.getByTestId("brand-identity").click();
    await page.getByTestId("settings-trigger").click();

    const popover = page.getByTestId("settings-popover");
    await expect(popover).toBeVisible();

    // In the default mock state, consentSource is NOT "env-forced-off", so
    // the "$ENV_VAR" branch never renders. The only content here is identity,
    // auth, and telemetry toggle — no cost terms.
    await assertNoCostAffordance(popover, "settings popover");
    await expect(popover).not.toContainText("wallet");
    await expect(popover).not.toContainText("spend");
    await expect(popover).not.toContainText("price");
    // Balance and transaction are absent from settings by design (they were
    // never in this surface; confirming they stay absent).
    await expect(popover).not.toContainText("balance");
    await expect(popover).not.toContainText("transaction");

    await page.keyboard.press("Escape");
  });

  // -------------------------------------------------------------------------
  // Surface 7: History menu + dead-session pane
  // -------------------------------------------------------------------------
  test("history menu and dead-session pane have no cost affordances", async ({ page }) => {
    await page.getByTestId("history-trigger").click();

    const historyMenu = page.getByTestId("history-menu");
    await expect(historyMenu).toBeVisible();
    await assertNoDollarInChrome(historyMenu, "history menu");
    await assertNoCostAffordance(historyMenu, "history menu");

    // Open a dead-session pane
    await page.getByTestId("exited-session-sess-leasing").click();
    const deadPane = page.getByTestId("dead-session-pane");
    await expect(deadPane).toBeVisible();
    await assertNoDollarInChrome(deadPane, "dead-session pane");
    await assertNoCostAffordance(deadPane, "dead-session pane");
  });

  // -------------------------------------------------------------------------
  // Surface 8: DOM — WalletCard / run-cost / wallet-related class names absent
  // -------------------------------------------------------------------------
  test("WalletCard and all wallet/spend/run-cost DOM elements are absent", async ({ page }) => {
    // These class names belonged to the cost strip removed in SAP-1775.
    // None of them should exist in the DOM at all.
    await expect(page.locator("[class*='wallet-card']")).toHaveCount(0);
    await expect(page.locator("[class*='wallet']")).toHaveCount(0);
    await expect(page.locator("[class*='run-cost']")).toHaveCount(0);
    await expect(page.locator("[class*='price-note']")).toHaveCount(0);
    await expect(page.locator("[data-testid*='wallet']")).toHaveCount(0);
    await expect(page.locator("[data-testid*='spend']")).toHaveCount(0);
    await expect(page.locator("[data-testid*='run-cost']")).toHaveCount(0);
    await expect(page.locator("[data-testid*='credit-balance']")).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // End-to-end: full run+inspect flow — canvas, steps, code, settings
  // -------------------------------------------------------------------------
  test("full run+inspect flow surfaces no cost affordances and makes no cost calls", async ({ page }) => {
    const sentinel = armNetworkSentinel(page);

    // Load board and trigger run
    await loadBoard(page);
    await triggerRun(page);
    await page.waitForTimeout(300);

    // Canvas tab: overview panel
    const overviewPanel = page.getByTestId("canvas-overview");
    await expect(overviewPanel).toBeVisible();
    await assertNoDollarInChrome(overviewPanel, "canvas overview — e2e");
    await assertNoCostAffordance(overviewPanel, "canvas overview — e2e");

    // Steps tab
    await page.getByTestId("right-tab-steps").click();
    const stepsPane = page.locator(".canvas-pane");
    await assertNoDollarInChrome(stepsPane, "steps tab — e2e");
    await assertNoCostAffordance(stepsPane, "steps tab — e2e");

    // Code tab: snippet panel
    await page.getByTestId("right-tab-code").click();
    const snippetPanel = page.getByTestId("snippet-panel");
    await expect(snippetPanel).toBeVisible();
    await assertNoDollarInChrome(snippetPanel, "snippet panel — e2e");
    await assertNoCostAffordance(snippetPanel, "snippet panel — e2e");

    // Settings popover
    await page.getByTestId("brand-identity").click();
    await page.getByTestId("settings-trigger").click();
    const settingsPopover = page.getByTestId("settings-popover");
    await expect(settingsPopover).toBeVisible();
    await assertNoCostAffordance(settingsPopover, "settings popover — e2e");
    await page.keyboard.press("Escape");

    // Session bar (always visible chrome)
    const sessionBar = page.locator(".session-bar");
    await assertNoDollarInChrome(sessionBar, "session bar — e2e");
    await assertNoCostAffordance(sessionBar, "session bar — e2e");

    // Network guard
    expect(sentinel.hits, `unexpected /spend or /transactions calls: ${sentinel.hits.join(", ")}`).toHaveLength(0);
  });
});
