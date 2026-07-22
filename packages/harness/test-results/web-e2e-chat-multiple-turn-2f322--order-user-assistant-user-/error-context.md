# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web/e2e/chat.spec.ts >> multiple turns render in order (user, assistant, user)
- Location: web/e2e/chat.spec.ts:150:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Chat view smoke tests — exercises the chat-first center pane against the
  3   |  * mock tier (VITE_MOCK=1), no harness server required.
  4   |  *
  5   |  * Tests cover:
  6   |  *  - Chat view renders as the default center pane for a running session
  7   |  *  - Chat turns appear from bus-driven chat events via __HARNESS_TEST__.publish
  8   |  *  - Terminal tab reachable + xterm mount stays in the DOM across tab flips
  9   |  *  - Slash command → verbatim submit + system note with Terminal link
  10  |  *  - Non-slash submit → no system note
  11  |  *  - Harness label shows the right text per session kind (claude-code / codex)
  12  |  *  - Per-session chat state isolation: sessions don't bleed into each other
  13  |  *  - Switching sessions resets the center pane to "chat"
  14  |  *  - Empty-state renders when no turns have arrived yet
  15  |  *  - chat.history bus event populates history turns
  16  |  */
  17  | import { expect, test } from "@playwright/test";
  18  | 
  19  | // ---------------------------------------------------------------------------
  20  | // Shared helpers
  21  | // ---------------------------------------------------------------------------
  22  | 
  23  | type TestHarness = {
  24  |   __HARNESS_TEST__: {
  25  |     publish: (message: unknown) => void;
  26  |     lastInjectInput?: { id: string; req: { text: string; submit?: boolean } };
  27  |   };
  28  | };
  29  | 
  30  | const publish = (page: import("@playwright/test").Page, message: unknown): Promise<void> =>
  31  |   page.evaluate((m) => {
  32  |     (window as unknown as TestHarness).__HARNESS_TEST__.publish(m);
  33  |   }, message);
  34  | 
  35  | /** Publish a chat.turn bus event for the given session. */
  36  | const publishTurn = (
  37  |   page: import("@playwright/test").Page,
  38  |   opts: { sessionId: string; role: "user" | "assistant"; content: string; turnId?: string },
  39  | ): Promise<void> =>
  40  |   publish(page, {
  41  |     type: "chat.turn",
  42  |     harnessSessionId: opts.sessionId,
  43  |     turn: {
  44  |       turnId: opts.turnId ?? `turn-${Date.now()}-${Math.random()}`,
  45  |       role: opts.role,
  46  |       content: opts.content,
  47  |       ts: new Date().toISOString(),
  48  |     },
  49  |   });
  50  | 
  51  | /** Publish a chat.history bus event for the given session. */
  52  | const publishHistory = (
  53  |   page: import("@playwright/test").Page,
  54  |   opts: { sessionId: string; turns: Array<{ role: "user" | "assistant"; content: string }> },
  55  | ): Promise<void> =>
  56  |   publish(page, {
  57  |     type: "chat.history",
  58  |     history: {
  59  |       harnessSessionId: opts.sessionId,
  60  |       turns: opts.turns.map((t, i) => ({
  61  |         turnId: `hist-${i}`,
  62  |         role: t.role,
  63  |         content: t.content,
  64  |         ts: new Date().toISOString(),
  65  |       })),
  66  |     },
  67  |   });
  68  | 
  69  | /** Inject a codex-harness session into state via session.status. */
  70  | const injectCodexSession = (
  71  |   page: import("@playwright/test").Page,
  72  |   id = "sess-codex-chat-test",
  73  | ): Promise<void> =>
  74  |   publish(page, {
  75  |     type: "session.status",
  76  |     session: {
  77  |       id,
  78  |       agentSessionId: null,
  79  |       boundWorkflowPath: null,
  80  |       harness: "codex",
  81  |       cwd: "/home/user/projects/rfq",
  82  |       title: "rfq",
  83  |       status: "running",
  84  |       createdAt: new Date().toISOString(),
  85  |       lastActiveAt: new Date().toISOString(),
  86  |       ready: true,
  87  |     },
  88  |   });
  89  | 
  90  | // ---------------------------------------------------------------------------
  91  | // Setup
  92  | // ---------------------------------------------------------------------------
  93  | 
  94  | test.beforeEach(async ({ page }) => {
> 95  |   await page.goto("/");
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  96  |   await expect(page.locator(".rail-workflows")).toBeVisible();
  97  | });
  98  | 
  99  | // ---------------------------------------------------------------------------
  100 | // Default view: chat pane
  101 | // ---------------------------------------------------------------------------
  102 | 
  103 | test("chat view is the default center pane for a running session", async ({ page }) => {
  104 |   // The boot session (sess-boot) is running — chat view should be visible.
  105 |   await expect(page.getByTestId("chat-view")).toBeVisible();
  106 |   await expect(page.getByTestId("center-tab-chat")).toHaveAttribute("aria-selected", "true");
  107 |   await page.screenshot({ path: "web/e2e/screenshots/chat-default.png" });
  108 | });
  109 | 
  110 | test("chat view shows the empty state when no turns have arrived yet", async ({ page }) => {
  111 |   await expect(page.getByTestId("chat-empty")).toBeVisible();
  112 |   await expect(page.locator(".chat-empty-heading")).toContainText("New conversation");
  113 |   await page.screenshot({ path: "web/e2e/screenshots/chat-empty.png" });
  114 | });
  115 | 
  116 | // ---------------------------------------------------------------------------
  117 | // Bus-driven turn rendering
  118 | // ---------------------------------------------------------------------------
  119 | 
  120 | test("user turn appears when a chat.turn bus event is published for the active session", async ({
  121 |   page,
  122 | }) => {
  123 |   await publishTurn(page, {
  124 |     sessionId: "sess-boot",
  125 |     role: "user",
  126 |     content: "Build me a leasing workflow",
  127 |   });
  128 | 
  129 |   await expect(page.getByTestId("chat-turn-user")).toBeVisible();
  130 |   await expect(page.getByTestId("chat-turn-user")).toContainText("Build me a leasing workflow");
  131 |   await page.screenshot({ path: "web/e2e/screenshots/chat-user-turn.png" });
  132 | });
  133 | 
  134 | test("assistant turn appears with markdown rendered (no dangerouslySetInnerHTML)", async ({
  135 |   page,
  136 | }) => {
  137 |   await publishTurn(page, {
  138 |     sessionId: "sess-boot",
  139 |     role: "assistant",
  140 |     content: "I'll **start** on that now. Here's the plan:\n- Step 1\n- Step 2",
  141 |   });
  142 | 
  143 |   await expect(page.getByTestId("chat-turn-assistant")).toBeVisible();
  144 |   // Bold rendered as <strong>
  145 |   await expect(page.locator(".chat-turn-markdown strong")).toContainText("start");
  146 |   // List items rendered
  147 |   await expect(page.locator(".chat-turn-markdown li")).toHaveCount(2);
  148 | });
  149 | 
  150 | test("multiple turns render in order (user, assistant, user)", async ({ page }) => {
  151 |   await publishTurn(page, { sessionId: "sess-boot", role: "user", content: "First message", turnId: "t1" });
  152 |   await publishTurn(page, { sessionId: "sess-boot", role: "assistant", content: "Reply here", turnId: "t2" });
  153 |   await publishTurn(page, { sessionId: "sess-boot", role: "user", content: "Follow-up", turnId: "t3" });
  154 | 
  155 |   const turns = page.getByTestId("chat-turns");
  156 |   await expect(turns).toBeVisible();
  157 | 
  158 |   await expect(page.locator("[data-turn-id=t1]")).toBeVisible();
  159 |   await expect(page.locator("[data-turn-id=t2]")).toBeVisible();
  160 |   await expect(page.locator("[data-turn-id=t3]")).toBeVisible();
  161 | });
  162 | 
  163 | test("bus events for a different session do not appear in the active session's chat", async ({
  164 |   page,
  165 | }) => {
  166 |   // Publish a turn for a different session (sess-bg, not the active sess-boot).
  167 |   await publishTurn(page, {
  168 |     sessionId: "sess-bg",
  169 |     role: "user",
  170 |     content: "This belongs to sess-bg only",
  171 |   });
  172 | 
  173 |   // The active session (sess-boot) should still show the empty state.
  174 |   await expect(page.getByTestId("chat-empty")).toBeVisible();
  175 |   await expect(page.locator(".chat-turn")).toHaveCount(0);
  176 | });
  177 | 
  178 | // ---------------------------------------------------------------------------
  179 | // chat.history snapshot
  180 | // ---------------------------------------------------------------------------
  181 | 
  182 | test("chat.history bus event populates the turn list for the active session", async ({ page }) => {
  183 |   await publishHistory(page, {
  184 |     sessionId: "sess-boot",
  185 |     turns: [
  186 |       { role: "user", content: "History message one" },
  187 |       { role: "assistant", content: "History reply one" },
  188 |     ],
  189 |   });
  190 | 
  191 |   await expect(page.getByTestId("chat-turns")).toBeVisible();
  192 |   await expect(page.getByTestId("chat-turn-user")).toContainText("History message one");
  193 |   await expect(page.getByTestId("chat-turn-assistant")).toContainText("History reply one");
  194 | });
  195 | 
```