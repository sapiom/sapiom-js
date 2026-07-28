/**
 * Past sessions render as transcripts, rebuilt from the harness's own events.
 *
 * What this tier is here to prove — the parts a unit test can't:
 *   - a past session renders turn by turn, for Claude Code AND Codex, through
 *     both entry points (a history row → review pane, an exited registry
 *     session → dead-session pane);
 *   - the view says it is a RECONSTRUCTION where the user reads it, and names
 *     the specific gaps (truncated tool output, missing narration, an
 *     incomplete final turn) instead of quietly papering over them;
 *   - a session with no recorded events says so, rather than showing an empty
 *     transcript that reads like an empty session.
 *
 * Runs in mock mode against MOCK_SESSION_RECORDS (../src/lib/mock-data.ts) —
 * fixtures deliberately shaped like the real fold's output, gaps included.
 */
import { expect, test, type Page } from "@playwright/test";

/** A claude-code transcript row WITH a recorded record → review pane. */
const CLAUDE_HISTORY_ROW = "history-2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33";
/** A claude-code transcript row the Studio never ran — no events recorded. */
const UNRECORDED_ROW = "history-5e7a0c94-3f22-4d18-b6e1-77c0a9b12d40";
/** Exited registry sessions → dead-session pane. Codex and Claude Code. */
const CODEX_EXITED_ROW = "exited-session-sess-rfq";
const CLAUDE_EXITED_ROW = "exited-session-sess-leasing";
/** A session old enough that its events are gone — it renders from the
 *  compacted copy under `~/.sapiom/harness/records/`. */
const ARCHIVED_ROW = "history-4a1c8e22-9b70-4f35-a1d2-3e4f5a6b7c8d";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

async function openHistoryRow(page: Page, testid: string): Promise<void> {
  await page.getByTestId("history-trigger").click();
  await expect(page.getByTestId("history-menu")).toBeVisible();
  await page.getByTestId(testid).click();
}

test("a claude-code history row renders its session turn by turn", async ({ page }) => {
  await openHistoryRow(page, CLAUDE_HISTORY_ROW);

  await expect(page.getByTestId("past-session-pane")).toBeVisible();
  await expect(page.getByTestId("session-transcript")).toBeVisible();

  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(3);
  await expect(turns.nth(0).getByTestId("transcript-prompt")).toContainText("Wire the screening webhook");
  await expect(turns.nth(0).getByTestId("transcript-assistant")).toContainText("applicantQueue.publish()");
  await expect(turns.nth(2).getByTestId("transcript-prompt")).toContainText("Ship it.");

  // Model and token usage ride along with the turn that recorded them.
  await expect(turns.nth(0)).toContainText("claude-opus-4-6");
  await expect(turns.nth(0)).toContainText("9.1k in");

  await page.screenshot({ path: "web/e2e/screenshots/past-session-transcript.png", fullPage: true });
});

test("a CODEX session renders the same way — this reads our events, not a vendor transcript", async ({ page }) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId(CODEX_EXITED_ROW).click();

  // Exited registry session: the metadata card stays, and the transcript is
  // added below it — the pty's scrollback is gone, our recording of it isn't.
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await expect(page.getByTestId("dead-session-detail")).toContainText("Codex");

  const transcript = page.getByTestId("session-transcript");
  await expect(transcript).toBeVisible();
  await expect(page.getByTestId("transcript-turn")).toHaveCount(1);
  await expect(page.getByTestId("transcript-prompt")).toContainText("Summarize what the rfq workflow does");
  await expect(page.getByTestId("transcript-tool-call")).toHaveCount(1);

  // Codex reports no assistant text to the harness. The view says that
  // outright rather than rendering a blank reply.
  await expect(page.getByTestId("transcript-no-assistant")).toBeVisible();
  await expect(page.getByTestId("transcript-limitations")).toContainText("doesn't report assistant text");

  await page.screenshot({ path: "web/e2e/screenshots/past-session-transcript-codex.png", fullPage: true });
});

test("the reconstruction is labeled where the user reads it, with its gaps named", async ({ page }) => {
  await openHistoryRow(page, CLAUDE_HISTORY_ROW);

  const notice = page.getByTestId("transcript-reconstructed");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Reconstructed");
  await expect(notice).toContainText("not a replay of your terminal");
  // The fixture's one gap: narration between tool calls isn't recorded.
  await expect(page.getByTestId("transcript-limitations")).toContainText("final assistant message");
});

test("truncation and an unfinished turn are stated, not smoothed over", async ({ page }) => {
  // The leasing record carries both: a truncated Edit result and a trailing
  // turn that never completed.
  await page.getByTestId("history-trigger").click();
  await page.getByTestId(CLAUDE_EXITED_ROW).click();
  await expect(page.getByTestId("session-transcript")).toBeVisible();

  await expect(page.getByTestId("transcript-tool-truncated").first()).toBeVisible();
  await expect(page.getByTestId("transcript-incomplete")).toBeVisible();
  await expect(page.getByTestId("transcript-no-assistant")).toContainText("never completed");
  const limitations = page.getByTestId("transcript-limitations");
  await expect(limitations).toContainText("truncated");
  await expect(limitations).toContainText("never completed");
});

test("a session whose events are gone still renders — from its archived copy, and says so", async ({ page }) => {
  await openHistoryRow(page, ARCHIVED_ROW);

  // This is the SAP-2060 case in the UI: events.ndjson swept this session out
  // weeks ago, and the record still opens.
  await expect(page.getByTestId("session-transcript")).toBeVisible();
  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(1).getByTestId("transcript-prompt")).toContainText("Ship the migration");

  // Both costs of being an archive are stated, not left to be noticed: it's a
  // stored copy, its tool payloads were shortened, and it holds fewer turns
  // than the session had.
  await expect(page.getByTestId("transcript-archived")).toContainText("Archived copy");
  const limitations = page.getByTestId("transcript-limitations");
  await expect(limitations).toContainText("shortened");
  await expect(limitations).toContainText("earlier ones are gone");

  await page.screenshot({ path: "web/e2e/screenshots/past-session-transcript-archived.png", fullPage: true });
});

test("tool calls are collapsed by default and expand to the stored input and result", async ({ page }) => {
  await openHistoryRow(page, CLAUDE_HISTORY_ROW);

  const toolCall = page.getByTestId("transcript-tool-call").first();
  await expect(toolCall).toBeVisible();
  await expect(toolCall.locator(".transcript-tool-body")).toBeHidden();

  await toolCall.locator("summary").click();
  await expect(toolCall.locator(".transcript-tool-body")).toBeVisible();
  await expect(toolCall).toContainText("applicantQueue");
});

test("a session with no recorded events says so instead of showing an empty transcript", async ({ page }) => {
  await openHistoryRow(page, UNRECORDED_ROW);

  await expect(page.getByTestId("past-session-pane")).toBeVisible();
  const empty = page.getByTestId("past-session-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("no recorded events");
  // No fabricated transcript, and no turn rows at all.
  await expect(page.getByTestId("session-transcript")).toHaveCount(0);
  await expect(page.getByTestId("transcript-turn")).toHaveCount(0);

  // The pane is still a way forward, not a dead end.
  await expect(page.getByTestId("past-session-start")).toBeVisible();
  await expect(page.getByTestId("past-session-close")).toBeVisible();
});

test("the transcript scrolls inside its pane — the shell stays viewport-locked", async ({ page }) => {
  await openHistoryRow(page, CLAUDE_HISTORY_ROW);
  await expect(page.getByTestId("session-transcript")).toBeVisible();

  const root = await page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(root.scrollHeight).toBe(root.clientHeight);
});
