/**
 * Cost-removal guard (SAP-1783) — dedicated "cost is gone" Playwright suite.
 *
 * Asserts that NO cost-related UI renders anywhere in the Studio across all
 * inspectable surfaces, after the full strip (SAP-1775 removed WalletCard,
 * WorkflowPriceNote, per-step cost; SAP-1769 removed server /spend +
 * /transactions routes).
 *
 * Surfaces walked:
 *   1. App shell chrome: brand header, rail, session bar, the agent modal's
 *      header (name, state, verbs)
 *   2. Canvas overview panel (board-level, before step selection)
 *   3. The step card (board pick in the agent modal, post-run)
 *   4. (The Steps tab and its snippet panel were removed with the right
 *      pane; the agent modal has Canvas and Secrets only, flow 4.2b.2.)
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
 *
 * DELIBERATE EXEMPTION (2026-08): the rail FOOTER's plan card renders an
 * account-level readout ("$12.40 / $50" — spend vs the org's spend-limit
 * rule, served by GET /api/account/plan, the dashboard's own pair). That is
 * an account-billing surface, not the per-run/per-step cost UI this suite
 * guards against reintroducing. The scoped "$" walks above intentionally do
 * not cover `.rail-footer`; the DOM-wide class/testid bans and the
 * /spend|/transactions network sentinel still apply to it (the card uses
 * `plan-*` names and its data rides /api/account/plan). See
 * e2e/rail-footer-cards.spec.ts for that card's own coverage.
 */
import { expect, test, type Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";

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
  // leasing's board in its agent modal.
  await openAgentModal(page, "acme-app", "leasing");
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
  //
  // The route interception is registered BEFORE page.goto so that any
  // /spend or /transactions call fired synchronously at page load is caught.
  // -------------------------------------------------------------------------
  test("no /spend or /transactions calls are made during a full run+inspect flow", async ({ page }) => {
    // Arm the sentinel before navigation so page-load calls are captured.
    const sentinel = armNetworkSentinel(page);
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Load the board and trigger a prod run
    await loadBoard(page);
    await triggerRun(page);

    // Navigate through every inspectable surface of the agent modal
    await page.getByTestId("agent-modal-tab-secrets").click();
    await expect(page.getByTestId("agent-modal-panel-secrets")).toBeVisible();
    await page.getByTestId("agent-modal-tab-canvas").click();
    await page.getByTestId("agent-modal-close").click();
    await expect(page.getByTestId("agent-modal")).toHaveCount(0);

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

  test("the agent modal's header (state and verbs) has no cost affordances", async ({ page }) => {
    // The agent's verbs left the strip beside a session for the agent modal's
    // header row (flow 4.2b, 4.4b): visible icon controls, no menu.
    await loadBoard(page);
    const header = page.locator(".agent-modal-head");
    await expect(header).toBeVisible();
    await assertNoDollarInChrome(header, "agent modal header");
    await assertNoCostAffordance(header, "agent modal header");
    for (const verb of ["visualize", "run-local", "prod-run", "deploy"]) {
      const label = (await page.getByTestId(`agent-modal-${verb}`).getAttribute("aria-label")) ?? "";
      expect(label).not.toMatch(/\$|wallet|balance|spend|price|transaction/i);
    }

    // The lifecycle state reads "Deployed": a lifecycle word, never a cost
    // term (and the agent, leasing, is deployed).
    const state = page.getByTestId("agent-modal-state");
    await expect(state).toHaveText("Deployed");
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
  // Surface 3: the step card — board pick of a run-populated step
  // -------------------------------------------------------------------------
  test("the step card after a run carries no cost affordances", async ({ page }) => {
    await loadBoard(page);
    await triggerRun(page);

    // Wait for the run-state mock poll to settle (~120ms in MockApi)
    await page.waitForTimeout(300);

    // Pick the credit-check node via the iframe gesture layer.
    // Wait for auto-fit to complete (zoom-reset reads something other than
    // "100%") before reading the bounding box, matching the pickNode pattern
    // in canvas-inspector.spec.ts. A null box after that guard is an error,
    // not a silent skip — a silent skip would let the later inspector
    // assertion time out with a confusing message.
    // The bundled interactive board (it answers pick with node) in the same
    // frame, as canvas-inspector.spec.ts does.
    await page.evaluate(async () => {
      const html = await (await fetch("/canvas/sess-boot/index.html")).text();
      (document.querySelector(".agent-modal .canvas-iframe") as HTMLIFrameElement).srcdoc = html;
    });
    const frame = page.frameLocator(".canvas-iframe");
    const node = frame.locator('[data-node-id="credit-check"]');
    await expect(node).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
    const box = await node.boundingBox();
    if (!box) throw new Error("credit-check node has no bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // The step card carries description, inputs, outputs and calls only
    // (4.2b.4, Q8); a metered capability says "metered", never a price.
    const card = page.getByTestId("step-card");
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("step-card-title")).toHaveText("credit-check");
    await assertNoDollarInChrome(card, "step card");
    await assertNoCostAffordance(card, "step card");
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
  test("options menu, history card and dead-session pane have no cost affordances", async ({ page }) => {
    await page.getByTestId("history-trigger").click();

    const optionsMenu = page.getByTestId("rail-options-menu");
    await expect(optionsMenu).toBeVisible();
    await assertNoDollarInChrome(optionsMenu, "options menu");
    await assertNoCostAffordance(optionsMenu, "options menu");
    await page.keyboard.press("Escape");

    // Past sessions opens from the history glyph in the rail's top bar
    // (flow-creation.md §4.7). Assert its chrome — the rows a dead session is
    // reached through — carries no cost terms.
    await page.getByTestId("rail-history").click();
    const pastCard = page.getByTestId("past-sessions-card");
    await expect(pastCard).toBeVisible();
    await assertNoDollarInChrome(pastCard, "past sessions card");
    await assertNoCostAffordance(pastCard, "past sessions card");

    // Open a dead-session pane from the flyout
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
  // End-to-end: full run+inspect flow — canvas, secrets, settings
  //
  // The route interception is registered BEFORE page.goto so that any
  // /spend or /transactions call fired synchronously at page load is caught.
  // -------------------------------------------------------------------------
  test("full run+inspect flow surfaces no cost affordances and makes no cost calls", async ({ page }) => {
    // Arm the sentinel before navigation so page-load calls are captured.
    const sentinel = armNetworkSentinel(page);
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Load board and trigger run
    await loadBoard(page);
    await triggerRun(page);
    await page.waitForTimeout(300);

    // Canvas tab: overview panel
    const overviewPanel = page.getByTestId("canvas-overview");
    await expect(overviewPanel).toBeVisible();
    await assertNoDollarInChrome(overviewPanel, "canvas overview — e2e");
    await assertNoCostAffordance(overviewPanel, "canvas overview — e2e");

    // The whole board after the run
    const board = page.getByTestId("agent-modal-panel-canvas");
    await assertNoDollarInChrome(board, "agent board — e2e");
    await assertNoCostAffordance(board, "agent board — e2e");

    // Secrets tab
    await page.getByTestId("agent-modal-tab-secrets").click();
    const secrets = page.getByTestId("agent-modal-panel-secrets");
    await expect(secrets).toBeVisible();
    await assertNoDollarInChrome(secrets, "secrets — e2e");
    await assertNoCostAffordance(secrets, "secrets — e2e");
    await page.getByTestId("agent-modal-close").click();

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
