/**
 * Chat surface e2e — runs against mock mode (VITE_MOCK=1), where Chat is the
 * default session view and the composer drives the scripted mapping
 * conversation (src/lib/mock-chat.ts). No harness server involved.
 */
import { expect, test } from "@playwright/test";

import { MAPPING_THINKING_TEXT, MAPPING_VERDICT_BODY } from "../src/lib/mock-chat";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

const ASK = "Map the leasing workflow before anything runs.";

async function startConversation(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("chat-input").fill(ASK);
  await page.getByTestId("chat-submit").click();
  await expect(page.locator(".chat-user")).toHaveCount(1);
}

test("chat is the default view in mock mode; the toggle flips to terminal without unmounting the pty", async ({
  page,
}) => {
  const view = page.getByTestId("agent-view");
  await expect(view).toHaveAttribute("data-view", "chat");
  await expect(page.getByTestId("chat-pane")).toBeVisible();

  // The terminal is already mounted behind the chat surface — hidden via
  // visibility, never display:none, so xterm keeps real dimensions.
  const terminal = page.locator(".harness-terminal");
  await expect(terminal).toHaveCount(1);
  await expect(terminal).not.toBeVisible();

  // The switch lives in the SessionBar's right cluster, next to the ⋯ menu.
  const terminalTab = page.getByTestId("agent-tab-terminal");
  await expect(page.locator(".session-bar").getByTestId("agent-tab-chat")).toBeVisible();
  await terminalTab.click();
  await expect(view).toHaveAttribute("data-view", "terminal");
  await expect(terminal).toBeVisible();
  await expect(page.getByTestId("chat-pane")).not.toBeVisible();
  await expect(terminalTab).toHaveAttribute("aria-pressed", "true");

  // Flip back: both surfaces survived the round trip.
  await page.getByTestId("agent-tab-chat").click();
  await expect(page.getByTestId("chat-pane")).toBeVisible();
  await expect(terminal).toHaveCount(1);
  await expect(terminal).not.toBeVisible();

  await page.screenshot({ path: "web/e2e/screenshots/chat-default-view.png", fullPage: true });
});

test("the scripted mapping conversation streams and settles with one next action", async ({ page }) => {
  await startConversation(page);

  // The pending row narrates the current stage while the script works.
  await expect(page.getByTestId("chat-pending")).toBeVisible();
  await expect(page.getByTestId("chat-pending")).toContainText("Studio is working");

  // Streaming presents a caret; the submit button reads Stop while pending.
  await expect(page.locator(".chat-streaming-caret")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("chat-submit")).toHaveAttribute("aria-label", "Stop drafting");

  // Settled: the verdict message closes with the single next action, chips
  // landed, the validation receipt is present, and nothing is left streaming.
  await expect(page.locator('[data-item-id="map-verdict"]')).toContainText("Next action", { timeout: 25_000 });
  await expect(page.locator(".chat-chips span").first()).toContainText("4 typed steps");
  await expect(page.locator(".chat-system.is-success")).toContainText("Map matches the source");
  await expect(page.getByTestId("chat-pending")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".chat-streaming-caret")).toHaveCount(0);
  await expect(page.getByTestId("chat-submit")).toHaveAttribute("aria-label", "Send message");

  await page.screenshot({ path: "web/e2e/screenshots/chat-conversation-settled.png", fullPage: true });
});

test("thinking card: collapsed to 'Thought for Ns' by default, expands to the full reasoning, unmounts closed", async ({
  page,
}) => {
  await startConversation(page);

  const card = page.getByTestId("chat-card-thinking");
  await expect(card).toBeVisible({ timeout: 10_000 });
  const header = card.locator(".chat-card-header");
  // The card streams open first (thinking-first sequencing) and collapses on
  // its own when the reasoning settles — allow the full streaming window.
  await expect(header).toHaveAttribute("aria-expanded", "false", { timeout: 15_000 });
  // Elapsed seconds are measured honestly from the stream, so match the
  // shape rather than a hardcoded duration.
  await expect(card).toContainText(/Thought for \d+s/);
  await expect(card).toContainText("Traced intake through both terminal outcomes");
  // Content is unmounted while closed, not just hidden.
  await expect(card.locator(".chat-card-content")).toHaveCount(0);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".chat-card-content")).toContainText(MAPPING_THINKING_TEXT);
  await page.screenshot({ path: "web/e2e/screenshots/chat-thinking-expanded.png", fullPage: true });

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator(".chat-card-content")).toHaveCount(0);
});

test("tool card: mono invocation with a one-line result, expands to the raw output", async ({ page }) => {
  await startConversation(page);

  const card = page.getByTestId("chat-card-tool");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("read sapiom.json");
  await expect(card).toContainText("4 steps, 2 exits, no drift");
  await expect(card.locator(".chat-card-header")).toHaveAttribute("aria-expanded", "false");

  await card.locator(".chat-card-header").click();
  // The tool output speaks the same slugs the canvas graph and Steps tab
  // use — one vocabulary across chat, canvas, and steps.
  await expect(card.locator(".chat-card-output")).toContainText("entry intake");
  await expect(card.locator(".chat-card-output")).toContainText("draft-lease, manual-review");
  await page.screenshot({ path: "web/e2e/screenshots/chat-tool-expanded.png", fullPage: true });
});

test("stop aborts mid-stream, preserves the partial text exactly, and posts the warning receipt", async ({
  page,
}) => {
  await startConversation(page);

  // Wait until the verdict has revealed a little real text, then interrupt.
  // The verdict streams last, after ~10s of thinking/tool/steps stages, so
  // the budget covers the whole preamble plus the first revealed words.
  const body = page.locator('[data-item-id="map-verdict"] .chat-assistant-copy > p');
  await expect(body).toContainText(MAPPING_VERDICT_BODY.slice(0, 12), { timeout: 20_000 });
  await page.getByTestId("chat-submit").click();

  await expect(page.locator(".chat-system.is-warning")).toContainText("Drafting stopped");
  await expect(page.locator(".chat-system.is-warning")).toContainText("no side effects");
  await expect(page.getByTestId("chat-pending")).toHaveCount(0);
  await expect(page.locator(".chat-streaming-caret")).toHaveCount(0);
  await expect(page.getByTestId("chat-submit")).toHaveAttribute("aria-label", "Send message");

  // The frozen text is a strict prefix of the full body and stays put.
  const frozen = (await body.innerText()).trim();
  expect(frozen.length).toBeGreaterThan(0);
  expect(frozen.length).toBeLessThan(MAPPING_VERDICT_BODY.length);
  expect(MAPPING_VERDICT_BODY.startsWith(frozen)).toBe(true);
  await page.waitForTimeout(500);
  expect((await body.innerText()).trim()).toBe(frozen);

  await page.screenshot({ path: "web/e2e/screenshots/chat-stopped-partial.png", fullPage: true });
});

test("composer: Enter sends, Shift+Enter breaks the line, empty input cannot send", async ({ page }) => {
  const input = page.getByTestId("chat-input");
  const submit = page.getByTestId("chat-submit");
  await expect(submit).toBeDisabled();

  await input.fill("first line");
  await expect(submit).toBeEnabled();
  await input.press("Shift+Enter");
  await input.pressSequentially("second line");
  await expect(input).toHaveValue("first line\nsecond line");

  await input.press("Enter");
  await expect(page.locator(".chat-user p")).toHaveText("first line\nsecond line");
  await expect(input).toHaveValue("");
  await expect(submit).toHaveAttribute("aria-label", "Stop drafting");
});

test("assistant prose goes full measure: no gutter mark, receipts share the thread's left edge", async ({
  page,
}) => {
  await startConversation(page);
  // The old hanging mark/thumbnail column is gone entirely.
  await expect(page.locator(".chat-assistant-mark")).toHaveCount(0);
  await expect(page.locator('[data-item-id="map-verdict"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chat-system.is-success")).toBeVisible({ timeout: 25_000 });
  // One left edge for the whole thread: assistant copy and system receipts
  // align (no indent stub where the mark column used to be).
  const copyBox = await page.locator('[data-item-id="map-verdict"]').boundingBox();
  const receiptBox = await page.locator(".chat-system.is-success").boundingBox();
  expect(Math.abs((copyBox?.x ?? 0) - (receiptBox?.x ?? 99))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "web/e2e/screenshots/chat-full-measure.png", fullPage: true });
});

test("a finished run lands a receipt in the chat with the RunView's real facts", async ({ page }) => {
  // Same pipeline the Steps tab observes: execution.started -> polled RunView.
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-chat-1",
      target: "prod",
    });
  });
  const receipt = page.locator('[data-item-id="run-exec-chat-1"]');
  await expect(receipt).toBeVisible({ timeout: 10_000 });
  await expect(receipt).toContainText("Run completed");
  // Real facts as mono chips: step count and measured duration. The Studio is
  // cost-free — the receipt shows no money.
  await expect(receipt.locator(".chat-chips span").first()).toContainText("steps");
  await expect(receipt).toContainText("3.7s");
  await expect(receipt).not.toContainText("$");
  await expect(receipt).toContainText("prod run · exec-chat-1");
});

test("composer footer: attach and library lead, provider dropdown and send anchor the right", async ({ page }) => {
  const attach = page.getByTestId("composer-attach");
  const library = page.getByTestId("composer-library");
  const provider = page.getByTestId("composer-agent");
  const send = page.getByTestId("chat-submit");
  await expect(attach).toBeVisible();
  const [attachBox, libraryBox, providerBox, sendBox] = await Promise.all([
    attach.boundingBox(),
    library.boundingBox(),
    provider.boundingBox(),
    send.boundingBox(),
  ]);
  expect(attachBox!.x).toBeLessThan(libraryBox!.x);
  expect(libraryBox!.x).toBeLessThan(providerBox!.x);
  expect(providerBox!.x).toBeLessThan(sendBox!.x);
});

test("provider control is an honest dropdown: names this session's agent; the switch applies to new sessions", async ({
  page,
}) => {
  const provider = page.getByTestId("composer-agent");
  await expect(provider).toContainText("Claude Code");
  await expect(provider).toHaveAttribute(
    "data-tooltip",
    "This session runs Claude Code. The switch applies to new sessions.",
  );

  await provider.click();
  const menu = page.getByTestId("composer-provider-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Agent for new sessions");
  // The native chat mode leads: Sapiom Harness is the FIRST row, checked
  // (it is the pipeline this conversation runs on today), separated from
  // the CLI adapters by a hairline divider.
  const rows = menu.getByRole("menuitemradio");
  await expect(rows.first()).toHaveText(/Sapiom Harness/);
  await expect(menu.getByTestId("composer-provider-sapiom")).toHaveAttribute("aria-checked", "true");
  await expect(
    menu.getByTestId("composer-provider-sapiom").locator(".provider-item-check svg"),
  ).toHaveCount(1);
  await expect(menu.locator(".provider-menu-divider")).toHaveCount(1);
  // Registry-driven below the divider: every adapter the server knows about
  // renders, the ones the Studio can't launch disabled with the reason on
  // hover (5 adapters + the native chat row).
  await expect(rows).toHaveCount(6);
  await expect(menu.getByTestId("composer-provider-conductor")).toHaveAttribute("aria-disabled", "true");
  // The active pick carries the ONE mark: a leading check, no suffix text.
  const activeRow = menu.getByTestId("composer-provider-claude-code");
  await expect(activeRow).toHaveAttribute("aria-checked", "true");
  await expect(activeRow.locator(".provider-item-check svg")).toHaveCount(1);
  await expect(menu.getByTestId("composer-provider-codex").locator(".provider-item-check svg")).toHaveCount(0);

  await menu.getByTestId("composer-provider-codex").click();
  await expect(menu).toHaveCount(0);
  // Honest: THIS session still runs Claude Code (a pty can't swap agents)…
  await expect(provider).toContainText("Claude Code");
  // …and the pick landed where it applies: the new-session dialog's default.
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("new-session-btn").click();
  await expect(page.getByTestId("harness-select")).toContainText("Codex");
});

test("the library popover is portaled above the composer's clip and inserts templates uncropped", async ({
  page,
}) => {
  await page.getByTestId("composer-library").click();
  const menu = page.getByTestId("composer-library-menu");
  await expect(menu).toBeVisible();
  // The composer wraps its rounded surface in overflow:hidden — the panel
  // escapes it by rendering from document.body (AnchoredPopover).
  expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);
  // Fully on screen: no ancestor crops it.
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  await page.screenshot({ path: "web/e2e/screenshots/chat-library-popover.png", fullPage: true });

  await menu.getByTestId("composer-library-macro-run_local").click();
  await expect(page.getByTestId("chat-input")).toHaveValue(/sapiom agents run/);
});

test("new events arriving while scrolled up surface the pill instead of yanking the view", async ({ page }) => {
  // Short viewport so the conversation outgrows the scroller early.
  await page.setViewportSize({ width: 900, height: 520 });
  await startConversation(page);

  // Once the step map lands the thread is taller than the pane — scroll to
  // the top and let the remaining script events arrive behind us.
  await expect(page.getByTestId("chat-card-steps")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("chat-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });

  const pill = page.getByTestId("chat-new-events");
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(pill).toContainText("new event");
  await page.screenshot({ path: "web/e2e/screenshots/chat-new-events-pill.png", fullPage: true });

  // The pill is the way back down: click clears it and pins to the latest.
  // Poll because the smooth scroll takes a few frames to arrive.
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect
    .poll(() =>
      page.getByTestId("chat-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 140),
    )
    .toBe(true);
});
