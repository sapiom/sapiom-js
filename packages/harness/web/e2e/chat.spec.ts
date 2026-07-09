/**
 * Chat view smoke tests — exercises the chat-first center pane against the
 * mock tier (VITE_MOCK=1), no harness server required.
 *
 * Tests cover:
 *  - Chat view renders as the default center pane for a running session
 *  - Chat turns appear from bus-driven chat events via __HARNESS_TEST__.publish
 *  - Terminal tab reachable + xterm mount stays in the DOM across tab flips
 *  - Slash command → verbatim submit + system note with Terminal link
 *  - Non-slash submit → no system note
 *  - Harness label shows the right text per session kind (claude-code / codex)
 *  - Per-session chat state isolation: sessions don't bleed into each other
 *  - Switching sessions resets the center pane to "chat"
 *  - Empty-state renders when no turns have arrived yet
 *  - chat.history bus event populates history turns
 */
import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

/** Publish a chat.turn bus event for the given session. */
const publishTurn = (
  page: import("@playwright/test").Page,
  opts: { sessionId: string; role: "user" | "assistant"; content: string; turnId?: string },
): Promise<void> =>
  publish(page, {
    type: "chat.turn",
    harnessSessionId: opts.sessionId,
    turn: {
      turnId: opts.turnId ?? `turn-${Date.now()}-${Math.random()}`,
      role: opts.role,
      content: opts.content,
      ts: new Date().toISOString(),
    },
  });

/** Publish a chat.history bus event for the given session. */
const publishHistory = (
  page: import("@playwright/test").Page,
  opts: { sessionId: string; turns: Array<{ role: "user" | "assistant"; content: string }> },
): Promise<void> =>
  publish(page, {
    type: "chat.history",
    history: {
      harnessSessionId: opts.sessionId,
      turns: opts.turns.map((t, i) => ({
        turnId: `hist-${i}`,
        role: t.role,
        content: t.content,
        ts: new Date().toISOString(),
      })),
    },
  });

/** Inject a codex-harness session into state via session.status. */
const injectCodexSession = (
  page: import("@playwright/test").Page,
  id = "sess-codex-chat-test",
): Promise<void> =>
  publish(page, {
    type: "session.status",
    session: {
      id,
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Default view: chat pane
// ---------------------------------------------------------------------------

test("chat view is the default center pane for a running session", async ({ page }) => {
  // The boot session (sess-boot) is running — chat view should be visible.
  await expect(page.getByTestId("chat-view")).toBeVisible();
  await expect(page.getByTestId("center-tab-chat")).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "web/e2e/screenshots/chat-default.png" });
});

test("chat view shows the empty state when no turns have arrived yet", async ({ page }) => {
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await expect(page.locator(".chat-empty-heading")).toContainText("New conversation");
  await page.screenshot({ path: "web/e2e/screenshots/chat-empty.png" });
});

// ---------------------------------------------------------------------------
// Bus-driven turn rendering
// ---------------------------------------------------------------------------

test("user turn appears when a chat.turn bus event is published for the active session", async ({
  page,
}) => {
  await publishTurn(page, {
    sessionId: "sess-boot",
    role: "user",
    content: "Build me a leasing workflow",
  });

  await expect(page.getByTestId("chat-turn-user")).toBeVisible();
  await expect(page.getByTestId("chat-turn-user")).toContainText("Build me a leasing workflow");
  await page.screenshot({ path: "web/e2e/screenshots/chat-user-turn.png" });
});

test("assistant turn appears with markdown rendered (no dangerouslySetInnerHTML)", async ({
  page,
}) => {
  await publishTurn(page, {
    sessionId: "sess-boot",
    role: "assistant",
    content: "I'll **start** on that now. Here's the plan:\n- Step 1\n- Step 2",
  });

  await expect(page.getByTestId("chat-turn-assistant")).toBeVisible();
  // Bold rendered as <strong>
  await expect(page.locator(".chat-turn-markdown strong")).toContainText("start");
  // List items rendered
  await expect(page.locator(".chat-turn-markdown li")).toHaveCount(2);
});

test("multiple turns render in order (user, assistant, user)", async ({ page }) => {
  await publishTurn(page, { sessionId: "sess-boot", role: "user", content: "First message", turnId: "t1" });
  await publishTurn(page, { sessionId: "sess-boot", role: "assistant", content: "Reply here", turnId: "t2" });
  await publishTurn(page, { sessionId: "sess-boot", role: "user", content: "Follow-up", turnId: "t3" });

  const turns = page.getByTestId("chat-turns");
  await expect(turns).toBeVisible();

  await expect(page.locator("[data-turn-id=t1]")).toBeVisible();
  await expect(page.locator("[data-turn-id=t2]")).toBeVisible();
  await expect(page.locator("[data-turn-id=t3]")).toBeVisible();
});

test("bus events for a different session do not appear in the active session's chat", async ({
  page,
}) => {
  // Publish a turn for a different session (sess-bg, not the active sess-boot).
  await publishTurn(page, {
    sessionId: "sess-bg",
    role: "user",
    content: "This belongs to sess-bg only",
  });

  // The active session (sess-boot) should still show the empty state.
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await expect(page.locator(".chat-turn")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// chat.history snapshot
// ---------------------------------------------------------------------------

test("chat.history bus event populates the turn list for the active session", async ({ page }) => {
  await publishHistory(page, {
    sessionId: "sess-boot",
    turns: [
      { role: "user", content: "History message one" },
      { role: "assistant", content: "History reply one" },
    ],
  });

  await expect(page.getByTestId("chat-turns")).toBeVisible();
  await expect(page.getByTestId("chat-turn-user")).toContainText("History message one");
  await expect(page.getByTestId("chat-turn-assistant")).toContainText("History reply one");
});

test("chat.history is ignored when the session already has live turns", async ({ page }) => {
  // First publish a live turn.
  await publishTurn(page, {
    sessionId: "sess-boot",
    role: "user",
    content: "Live turn already here",
    turnId: "live-1",
  });
  await expect(page.getByTestId("chat-turn-user")).toContainText("Live turn already here");

  // Now publish history — should NOT overwrite the live turn.
  await publishHistory(page, {
    sessionId: "sess-boot",
    turns: [{ role: "user", content: "History that should be ignored" }],
  });

  // Still shows the live turn, not the history.
  await expect(page.locator("[data-turn-id=live-1]")).toBeVisible();
  await expect(page.locator(".chat-turn")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Terminal tab
// ---------------------------------------------------------------------------

test("Terminal tab button is visible in the center tab bar", async ({ page }) => {
  await expect(page.getByTestId("center-tab-terminal")).toBeVisible();
  await expect(page.getByTestId("center-tab-bar")).toBeVisible();
});

test("clicking Terminal tab switches to the terminal panel", async ({ page }) => {
  // Start on chat.
  await expect(page.getByTestId("center-tab-chat")).toHaveAttribute("aria-selected", "true");

  // Switch to terminal.
  await page.getByTestId("center-tab-terminal").click();
  await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("center-tab-chat")).toHaveAttribute("aria-selected", "false");

  await page.screenshot({ path: "web/e2e/screenshots/chat-terminal-tab.png" });
});

test("terminal panel stays mounted in the DOM across tab flips (CSS keep-alive)", async ({
  page,
}) => {
  // Verify the terminal panel exists in the DOM regardless of active tab.
  // The panel is CSS-hidden (not unmounted) so xterm connection survives.
  await expect(page.getByTestId("center-panel-terminal")).toBeAttached();

  // Switch to terminal and back.
  await page.getByTestId("center-tab-terminal").click();
  await expect(page.getByTestId("center-panel-terminal")).toBeAttached();

  await page.getByTestId("center-tab-chat").click();
  await expect(page.getByTestId("center-panel-terminal")).toBeAttached();
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

test("a slash command is submitted verbatim AND a system note appears in the chat", async ({
  page,
}) => {
  const textarea = page.locator(".prompt-bar-textarea");
  await textarea.click();
  await textarea.fill("/model claude-4");
  await textarea.press("Enter");

  // Wait for the injectInput call to be recorded.
  await page.waitForFunction(
    () =>
      (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text === "/model claude-4",
  );

  // Verify verbatim forward (not trimmed, not wrapped).
  const captured = await page.evaluate(
    () => (window as unknown as TestHarness).__HARNESS_TEST__.lastInjectInput,
  );
  expect(captured?.req.text).toBe("/model claude-4");

  // System note must appear in the chat.
  await expect(page.getByTestId("chat-system-note")).toBeVisible();
  await expect(page.getByTestId("chat-system-note")).toContainText("/model claude-4");
});

test("slash command system note includes a Terminal tab link that switches to the terminal", async ({
  page,
}) => {
  const textarea = page.locator(".prompt-bar-textarea");
  await textarea.click();
  await textarea.fill("/init");
  await textarea.press("Enter");

  // Wait for the submission.
  await page.waitForFunction(
    () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text === "/init",
  );

  // The system note has a "Terminal tab" link.
  const terminalLink = page.getByTestId("chat-terminal-link");
  await expect(terminalLink).toBeVisible();

  // Clicking the link switches to the terminal tab.
  await terminalLink.click();
  await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute("aria-selected", "true");
});

test("a non-slash submit does NOT produce a system note", async ({ page }) => {
  const textarea = page.locator(".prompt-bar-textarea");
  await textarea.click();
  await textarea.fill("Tell me what files are in the repo");
  await textarea.press("Enter");

  await page.waitForFunction(
    () =>
      (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text ===
      "Tell me what files are in the repo",
  );

  // No system note for a plain message.
  await expect(page.getByTestId("chat-system-note")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Harness label in the composer footer
// ---------------------------------------------------------------------------

test("claude-code session shows 'Claude Code' as the harness label", async ({ page }) => {
  // Default boot session is claude-code.
  const label = page.getByTestId("chat-harness-label");
  await expect(label).toBeVisible();
  await expect(label).toHaveText("Claude Code");
});

test("codex session shows 'Codex' as the harness label", async ({ page }) => {
  // Inject a codex session and switch to it.
  await injectCodexSession(page, "sess-codex-label-test");
  const codexTab = page.getByTestId("session-tab-sess-codex-label-test");
  await expect(codexTab).toBeVisible({ timeout: 3_000 });
  await codexTab.click();
  await expect(codexTab).toHaveClass(/is-active/);

  const label = page.getByTestId("chat-harness-label");
  await expect(label).toBeVisible();
  await expect(label).toHaveText("Codex");
});

// ---------------------------------------------------------------------------
// Per-session state isolation and session switching
// ---------------------------------------------------------------------------

test("switching sessions resets the center pane to 'chat'", async ({ page }) => {
  // Switch to terminal first.
  await page.getByTestId("center-tab-terminal").click();
  await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute("aria-selected", "true");

  // Switch sessions — the chat tab should become active again.
  await page.getByTestId("session-tab-sess-bg").click();
  await expect(page.getByTestId("center-tab-chat")).toHaveAttribute("aria-selected", "true");
});

test("each session maintains its own chat state — turns don't bleed across sessions", async ({
  page,
}) => {
  // Add a turn to sess-boot.
  await publishTurn(page, {
    sessionId: "sess-boot",
    role: "user",
    content: "Boot session turn",
    turnId: "boot-turn-1",
  });
  await expect(page.getByTestId("chat-turn-user")).toContainText("Boot session turn");

  // Switch to sess-bg — it should have an empty state.
  await page.getByTestId("session-tab-sess-bg").click();
  await expect(page.getByTestId("chat-empty")).toBeVisible();

  // Add a turn to sess-bg.
  await publishTurn(page, {
    sessionId: "sess-bg",
    role: "user",
    content: "Background session turn",
    turnId: "bg-turn-1",
  });
  await expect(page.getByTestId("chat-turn-user")).toContainText("Background session turn");

  // Switch back to sess-boot — should still have its own turn only.
  await page.getByTestId("session-tab-sess-boot").click();
  await expect(page.getByTestId("chat-turn-user")).toContainText("Boot session turn");
  await expect(page.locator(".chat-turn")).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Permission-pending attention banner (chat.attention bus event)
// ---------------------------------------------------------------------------

test("chat.attention event with a non-empty message shows the attention banner", async ({ page }) => {
  await publish(page, {
    type: "chat.attention",
    harnessSessionId: "sess-boot",
    message: "Claude is asking permission to run a command",
  });

  const banner = page.getByTestId("chat-attention-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Claude is asking permission to run a command");
  await page.screenshot({ path: "web/e2e/screenshots/chat-attention-banner.png" });
});

test("attention banner includes a 'Review in Terminal' link that switches to the Terminal tab", async ({
  page,
}) => {
  await publish(page, {
    type: "chat.attention",
    harnessSessionId: "sess-boot",
    message: "Claude is asking permission to use Bash",
  });

  const link = page.getByTestId("chat-attention-terminal-link");
  await expect(link).toBeVisible();
  await expect(link).toContainText("Review in Terminal");

  await link.click();
  await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute("aria-selected", "true");
});

test("chat.attention with an empty message clears the attention banner", async ({ page }) => {
  // Show the banner first.
  await publish(page, {
    type: "chat.attention",
    harnessSessionId: "sess-boot",
    message: "Awaiting permission",
  });
  await expect(page.getByTestId("chat-attention-banner")).toBeVisible();

  // Clearing: publish with empty message (the server sends this on next activity).
  await publish(page, {
    type: "chat.attention",
    harnessSessionId: "sess-boot",
    message: "",
  });
  await expect(page.getByTestId("chat-attention-banner")).toHaveCount(0);
});

test("attention banner for a different session does not appear on the active session", async ({
  page,
}) => {
  await publish(page, {
    type: "chat.attention",
    harnessSessionId: "sess-bg", // not the active sess-boot
    message: "Permission needed in background session",
  });

  // Banner should NOT appear for the active session (sess-boot).
  await expect(page.getByTestId("chat-attention-banner")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

test("the composer PromptBar is inside the chat view (not standalone under the terminal)", async ({
  page,
}) => {
  // The prompt bar must be a descendant of [data-testid="chat-view"].
  const promptBarInChat = page.locator('[data-testid="chat-view"] .prompt-bar');
  await expect(promptBarInChat).toBeVisible();
});

test("when Terminal tab is active, the chat panel is aria-hidden and the terminal panel is in the DOM", async ({
  page,
}) => {
  // Switch to terminal.
  await page.getByTestId("center-tab-terminal").click();
  await expect(page.getByTestId("center-tab-terminal")).toHaveAttribute("aria-selected", "true");

  // Chat panel uses aria-hidden (not HTML hidden) so CSS keep-alive works:
  // aria-hidden allows the CSS visibility/absolute/zero-size mechanism to
  // keep the xterm terminal alive across tab flips. UA `display:none` (from
  // the HTML hidden attribute) would force a 0x0 refit and degenerate it.
  await expect(page.getByTestId("center-panel-chat")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("center-panel-chat")).not.toHaveAttribute("hidden");

  // Terminal panel is attached to the DOM, NOT aria-hidden, and its computed
  // display must NOT be "none" (the key keep-alive correctness invariant).
  await expect(page.getByTestId("center-panel-terminal")).toBeAttached();
  await expect(page.getByTestId("center-panel-terminal")).toHaveAttribute("aria-hidden", "false");
  const terminalDisplay = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="center-panel-terminal"]');
    return el ? window.getComputedStyle(el).display : "not-found";
  });
  expect(terminalDisplay, "terminal panel must not be display:none while Terminal tab is active").not.toBe("none");

  // Chat panel: while Terminal tab is active, assert via getComputedStyle that
  // the chat panel's terminal element has no UA display:none either — CSS keeps
  // it alive with visibility/absolute/0-size, not display:none.
  const chatDisplay = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="center-panel-chat"]');
    return el ? window.getComputedStyle(el).display : "not-found";
  });
  expect(chatDisplay, "chat panel must not be display:none (CSS keep-alive requires it stays in flow)").not.toBe("none");
});

// ---------------------------------------------------------------------------
// Directive: no machinery terms leak to the user surface
// ---------------------------------------------------------------------------

test("banned machinery terms never appear in the chat surface innerText", async ({ page }) => {
  // Build a "busy" mock session: historical turns, a tool chip, an attention
  // banner, and a slash-command system note — everything the UI can show.
  // Then assert that no internal implementation term leaks to the visible text.

  // 1. Seed history turns (via chat.history)
  await publishHistory(page, {
    sessionId: "sess-boot",
    turns: [
      { role: "user", content: "Show me the project structure" },
      { role: "assistant", content: "I will explore the directory tree." },
    ],
  });
  await expect(page.getByTestId("chat-turns")).toBeVisible();

  // 2. Add a live assistant turn (via chat.turn)
  await publishTurn(page, {
    sessionId: "sess-boot",
    role: "assistant",
    content: "Running a scan of your workspace now.",
    turnId: "banned-live-1",
  });
  await expect(page.locator("[data-turn-id=banned-live-1]")).toBeVisible();

  // 3. Publish a tool chip (chat.tool)
  await publish(page, {
    type: "chat.tool",
    harnessSessionId: "sess-boot",
    call: {
      callId: "tool-banned-1",
      toolName: "Bash",
      status: "start",
      ts: new Date().toISOString(),
    },
  });
  // Verify the chip is visible before checking for banned words.
  await expect(page.locator("[data-testid^='tool-chip-']")).toBeVisible({ timeout: 3_000 });

  // 4. Show the attention banner (chat.attention)
  await publish(page, {
    type: "chat.attention",
    harnessSessionId: "sess-boot",
    message: "Claude is asking permission to run a command",
  });
  await expect(page.getByTestId("chat-attention-banner")).toBeVisible();

  // 5. Send a slash command so the system note appears in the chat
  const textarea = page.locator(".prompt-bar-textarea");
  await textarea.click();
  await textarea.fill("/model claude-opus-4-5");
  await textarea.press("Enter");
  await page.waitForFunction(
    () =>
      (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput?.req.text ===
      "/model claude-opus-4-5",
  );
  await expect(page.getByTestId("chat-system-note")).toBeVisible();

  // Grab the full visible text of the chat pane
  const chatView = page.getByTestId("chat-view");
  const visibleText = (await chatView.innerText()).toLowerCase();

  // Assert no internal machinery terms appear to the user.
  // These words belong to the implementation layer, not the user-facing layer.
  const banned = ["hook", "analytics", "telemetry", "ingest", "collector"];
  for (const term of banned) {
    expect(visibleText, `"${term}" must not appear in the chat surface`).not.toContain(term);
  }
});
