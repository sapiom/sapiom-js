/**
 * Portable continue (SAP-2059): a session the coding agent can no longer reattach to
 * is still continuable, because the Studio seeds a FRESH session with its own
 * reconstruction of the old one.
 *
 * What this tier proves that the unit and server tests can't:
 *   - the `rehydrate` branch is wired to the button a user actually presses —
 *     which is the dead-session pane's, since a registry row's history entry
 *     dedupes into its session row (see WorkflowsRail's `pastSummaries`);
 *   - pressing it creates a NEW session rather than attempting a resume that
 *     is guaranteed to 409;
 *   - the pane says which of the two it is about to do, before the click, and
 *     the difference is driven by whether we recorded the session — not by
 *     whether the agent did.
 *
 * Mock mode, against MOCK_SESSIONS / MOCK_HISTORY / MOCK_SESSION_RECORDS
 * (../src/lib/mock-data.ts).
 */
import { expect, test, type Page } from "@playwright/test";

/** Exited, `rehydrate`, AND recorded — the case this feature exists for. */
const REHYDRATABLE_ROW = "exited-session-sess-pricing";
/** Exited, `rehydrate`, nothing recorded either side: SAP-2057's phantom. */
const PHANTOM_ROW = "exited-session-sess-phantom";
/** Exited but the agent still holds it — resume, not rehydrate. */
const RESUMABLE_ROW = "exited-session-sess-leasing";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

async function openPastRow(page: Page, testid: string): Promise<void> {
  // Past-session rows moved out of the ⋯ menu into a sub-card that opens off
  // the "Past sessions" row: ⋯ → Past sessions → the row.
  await page.getByTestId("history-trigger").click();
  await expect(page.getByTestId("history-menu")).toBeVisible();
  // The flyout opens on hover onto its row (a click would toggle the
  // hover-open straight back shut).
  await page.getByTestId("past-sessions-trigger").hover();
  await expect(page.getByTestId("past-sessions-card")).toBeVisible();
  await page.getByTestId(testid).click();
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
}

test("a recorded, un-resumable session offers Continue and says what carries over", async ({ page }) => {
  await openPastRow(page, REHYDRATABLE_ROW);

  // The conversation is here — read from OUR events, not the agent's store,
  // which is the whole reason this session is continuable at all.
  await expect(page.getByTestId("dead-session-record")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toContainText("Rework the pricing tiers");

  await expect(page.getByTestId("dead-session-continue")).toBeVisible();
  // The dead end this replaces: a disabled Resume and nowhere to go.
  await expect(page.getByTestId("dead-session-resume")).toHaveCount(0);

  const reason = page.getByTestId("dead-session-resume-reason");
  await expect(reason).toContainText("no saved conversation for this session");
  await expect(reason).toContainText("seeded with the reconstruction below");
  // Honest about what the new coding agent is actually getting.
  await expect(reason).toContainText("a briefing about this session, not its context");
  await expect(reason).toContainText("The new coding agent will need to check the repository");
  await expect(reason).toContainText("the coding agent never writes a transcript");

  await page.screenshot({ path: "web/e2e/screenshots/portable-continue-pane.png", fullPage: true });
});

test("continuing it opens a NEW session rather than resuming the old one", async ({ page }) => {
  await openPastRow(page, REHYDRATABLE_ROW);
  // While the pane is up, the exited pricing session is the one in context.
  const context = page.getByTestId("session-context");
  await expect(context).toHaveAttribute("data-session-id", "sess-pricing");

  await page.getByTestId("dead-session-continue").click();

  // A FRESH session became active — the live workbench replaces the dead pane,
  // and the active session is a new id, not the old one resumed in place.
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(context).not.toHaveAttribute("data-session-id", "sess-pricing");
  // A real fresh id is present — `/.+/` proves the attribute EXISTS and is
  // non-empty (a bare not-"" also passes when the attribute is absent).
  await expect(context).toHaveAttribute("data-session-id", /.+/);
  // The old session is not what came back — it never appears as a live session
  // (no active context on it, no switch chip for it).
  await expect(page.getByTestId("session-switch-sess-pricing")).toHaveCount(0);
  // And no failure toast: this path never attempts the resume that would 409.
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("a session with nothing recorded keeps the honest dead end", async ({ page }) => {
  await openPastRow(page, PHANTOM_ROW);

  // Nothing to seed a continuation with, so there is no Continue to offer.
  await expect(page.getByTestId("dead-session-continue")).toHaveCount(0);
  await expect(page.getByTestId("dead-session-resume")).toBeDisabled();
  await expect(page.getByTestId("dead-session-resume-reason")).toContainText(
    "no recording of this one to carry over either",
  );
  // The metadata card alone — never an empty transcript that reads like an
  // empty session.
  await expect(page.getByTestId("dead-session-record")).toHaveCount(0);
});

test("a session the agent still holds is unchanged — it resumes, it does not rehydrate", async ({ page }) => {
  await openPastRow(page, RESUMABLE_ROW);
  await expect(page.getByTestId("dead-session-resume")).toBeEnabled();
  await expect(page.getByTestId("dead-session-continue")).toHaveCount(0);
  await expect(page.getByTestId("dead-session-resume-reason")).toHaveCount(0);
});

test("the rolling summary is off by default and reachable from settings", async ({ page }) => {
  // Settings live behind the account menu — same path consent.spec.ts uses.
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await page.getByTestId("settings-trigger").click();
  await expect(page.getByTestId("settings-popover")).toBeVisible();

  const note = page.locator(".settings-note").filter({ hasText: "uses tokens" });
  await expect(note).toContainText("a cheap one-shot coding-agent pass");
  await expect(note).toContainText("the coding agent can no longer reattach");
  await expect(note).not.toContainText("one-shot agent run");

  const toggle = page.getByTestId("rolling-summary-toggle");
  // Opt-in: it spends tokens on a background LLM call nobody asked for, and
  // portable continue works without it.
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});
