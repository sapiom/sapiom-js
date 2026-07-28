/**
 * Portable continue (SAP-2059): a session the agent can no longer reattach to
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
  await page.getByTestId("history-trigger").click();
  await expect(page.getByTestId("history-menu")).toBeVisible();
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
  // Honest about what the new agent is actually getting.
  await expect(reason).toContainText("a briefing about this session, not its context");

  await page.screenshot({ path: "web/e2e/screenshots/portable-continue-pane.png", fullPage: true });
});

test("continuing it opens a NEW session rather than resuming the old one", async ({ page }) => {
  await openPastRow(page, REHYDRATABLE_ROW);
  const tabs = page.getByTestId("session-tabs").locator(".session-tab");
  const before = await tabs.count();

  await page.getByTestId("dead-session-continue").click();

  await expect(tabs).toHaveCount(before + 1);
  // The old session is not what came back — it stays exited.
  await expect(page.getByTestId("session-tab-sess-pricing")).toHaveCount(0);
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

  const toggle = page.getByTestId("rolling-summary-toggle");
  // Opt-in: it spends tokens on a background LLM call nobody asked for, and
  // portable continue works without it.
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});
