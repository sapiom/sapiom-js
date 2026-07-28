/**
 * The Overview / first-run panel — mock-mode UI smoke (see smoke.spec.ts for the
 * setup). `/?mockState=fresh` renders MockApi as a brand-new install: no
 * sessions, no recent dirs, no workflows, AppState.firstRun set — the state the
 * real CLI produces on a machine that's never run the harness (it also skips the
 * auto boot session then). The default fixtures (a lived-in install) double as
 * the returning-user case.
 *
 * The panel has two states and they are NOT interchangeable — but the line
 * between them moved: the PITCH (headline, value copy, hint chips) is still
 * first-run only, while the hero IMAGE now renders in both, shorter on Overview.
 * So the bug guarded here is the *pitch copy* reaching someone who already has
 * workspaces; the image reaching them is intended, and has its own test.
 */
import { expect, test } from "@playwright/test";

/** Open the Overview surface — it lives in the account menu, not a tab strip. */
async function openOverview(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await page.getByTestId("rail-overview").click();
  await expect(page.getByTestId("welcome-panel")).toBeVisible();
}

/** Open Overview, then the templates dialog from its action band. */
async function openTemplates(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openOverview(page);
  await page.getByTestId("welcome-browse-templates").click();
  await expect(page.getByTestId("templates-dialog")).toBeVisible();
}

test.describe("first run", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("renders the hero pitch instead of the bare terminal empty state", async ({ page }) => {
    const panel = page.getByTestId("welcome-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator(".terminal-empty")).toHaveCount(0);

    await expect(panel).toContainText("Sapiom Studio for full-stack agentic products.");
    // The two primary actions plus the compact macros/⌘K hint.
    await expect(page.getByTestId("welcome-start-project")).toBeVisible();
    await expect(page.getByTestId("welcome-browse-templates")).toBeVisible();
    const hints = page.getByTestId("welcome-hints");
    await expect(hints).toContainText("Visualize");
    await expect(hints).toContainText("Run local");
    await expect(hints).toContainText("Deploy");
    await expect(hints).toContainText("⌘K");

    await page.screenshot({ path: "web/e2e/screenshots/welcome-panel.png", fullPage: true });
  });

  test("'New workspace' opens the three-door add flow, and adding one dismisses the panel", async ({
    page,
  }) => {
    // This CTA used to open the SESSION modal — the most prominent button on
    // the first-run screen said "workspace" and delivered "new session". It now
    // reaches the same three doors the rail's + does.
    await page.getByTestId("welcome-start-project").click();
    await expect(page.locator(".modal-add-workspace")).toBeVisible();
    await expect(page.getByTestId("aw-doors")).toBeVisible();
    await expect(page.locator(".modal-new-session")).toHaveCount(0);

    // Through door 1: pick a fixture folder that holds an agent project.
    await page.getByTestId("aw-door-have").click();
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-workflows");
    await page.getByTestId("aw-have-continue").click();
    await expect(page.getByTestId("aw-result")).toContainText("This is an agent project");
    await page.getByTestId("aw-add").click();

    // The workspace joins the rail; the first-run pitch is done.
    await expect(page.locator(".modal-add-workspace")).toHaveCount(0);
    await expect(page.getByTestId("workflow-rfq-workflows")).toBeVisible();
  });

  test("the footer links out to the documentation instead of a dismiss", async ({ page }) => {
    const docs = page.getByTestId("welcome-docs");
    await expect(docs).toBeVisible();
    await expect(docs).toHaveAttribute("href", "https://docs.sapiom.ai");
    await expect(docs).toHaveAttribute("target", "_blank");
  });
});

test.describe("returning user", () => {
  test("the lived-in fixtures render straight into the boot session, no panel", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
  });

  test("Overview shows recent workspaces, NOT the first-run pitch", async ({ page }) => {
    // The regression: `showWelcome` used to be `overviewSelected || firstRun`,
    // so opening Overview with 10 workspaces pitched the product at you.
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openOverview(page);

    const panel = page.getByTestId("welcome-panel");
    await expect(panel).not.toContainText("Sapiom Studio for full-stack agentic products.");
    // The pitch's chips go with it; the hero image deliberately does not (below).
    await expect(page.getByTestId("welcome-hints")).toHaveCount(0);
    await expect(page.getByTestId("welcome-recents")).toBeVisible();
    // The action band is shared by both states.
    await expect(page.getByTestId("welcome-start-project")).toBeVisible();
    await expect(page.getByTestId("welcome-browse-templates")).toBeVisible();
  });

  test("keeps the hero image on Overview, as the shorter band", async ({ page }) => {
    // It used to be first-run only, so the returning card opened with a bare
    // "Overview" heading. Same image, ~half the height — asserted in pixels
    // because "the hero is present but half height" is the whole change.
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);

    const hero = page.getByTestId("welcome-hero");
    await expect(hero).toBeVisible();
    await expect(hero).toHaveClass(/welcome-hero--returning/);
    const box = await hero.boundingBox();
    expect(box?.height).toBeLessThan(160);

    await page.screenshot({ path: "web/e2e/screenshots/welcome-overview.png", fullPage: true });
  });

  test("lists workspaces from session history, not just launch dirs", async ({ page }) => {
    // The defect: the list read settings.recentDirs, which recordRecentDir only
    // ever fills with the LAUNCH dir — one entry forever, under a heading
    // promising workspaces, while the rail knew dozens. /Users/demo/scratch is
    // the proof: a session cwd in the fixtures that is absent from recentDirs,
    // so it could not appear before this change.
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);

    await expect(page.getByTestId("welcome-recent-scratch")).toBeVisible();
    // Newest activity first: acme-app (a live session) above rfq-workflows (a day old).
    const rows = page.getByTestId("welcome-recents").locator("li");
    await expect(rows.first()).toContainText("acme-app");
    await expect(rows).toHaveCount(4);
  });

  test("rows carry their agent count, and claim nothing for a bare folder", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);

    // acme-app holds one agent project (leasing) in the fixtures.
    await expect(page.getByTestId("welcome-recent-acme-app")).toContainText("1 agent");
    // scratch is bare — a first-class workspace with nothing in it yet, so no
    // count is claimed for it.
    await expect(page.getByTestId("welcome-recent-scratch")).not.toContainText("agent");
    // All three fixture agents sit inside the visible rows, so nothing is
    // omitted and the note must stay away. Its positive case (a registry bigger
    // than the list) is unit-tested — unlistedAgentCount in
    // lib/recent-workspaces.test.ts — since the mock fixtures never produce it.
    await expect(page.getByTestId("welcome-recents-note")).toHaveCount(0);
  });

  test("clicking a recent workspace opens a session in it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);

    // Exercises the preferred-harness resolution chain too — it runs before the
    // session is created, so a throw there would surface as welcome-error.
    await page.getByTestId("welcome-recent-acme-app").click();

    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    await expect(page.getByTestId("session-context-title")).toContainText("acme-app");
  });

  test("creating a session promotes its folder in recentDirs instead of wiping the list", async ({
    page,
  }) => {
    // Pins the contract createSession has to keep: opening a folder PROMOTES it
    // and keeps the rest. Both the mock and the real server merge a settings
    // patch, so a client that sends an empty array erases the persisted list.
    //
    // Honest scope: this test does NOT fail against the pre-fix code, which
    // built the patch body inside a setSettings updater. React's eager-updater
    // optimization runs that synchronously whenever the hook has no pending
    // update, which is the common case — so the old form passes here too. The
    // fix removed the dependence on that internal behaviour; this test guards
    // the behaviour itself, and would catch a future patch that sends a stale or
    // empty list outright.
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openOverview(page);
    await page.getByTestId("welcome-recent-rfq-workflows").click();
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);

    // The directory picker's chips are the surface that still reads recentDirs
    // directly, so they show what actually survived.
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("aw-door-have").click();
    const chips = page.locator(".recent-dir-chip");
    await expect(chips).toHaveCount(3); // all three fixtures kept, none dropped
    // The folder just opened moves to the front rather than replacing the list.
    await expect(chips.first()).toHaveAttribute("title", "/Users/demo/rfq-workflows");
  });

  test("rows disable while one is opening, so a second click cannot double-fire", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);

    const row = page.getByTestId("welcome-recent-acme-app");
    const sibling = page.getByTestId("welcome-recent-rfq-workflows");
    // Don't wait for the navigation the click triggers — the guard's whole point
    // is what the DOM looks like DURING the two awaits (harness registry, then
    // session create), before the panel unmounts.
    await row.click({ noWaitAfter: true });

    // Both the clicked row and its siblings go disabled; a second click is then
    // impossible rather than merely ignored. Without the guard these stay
    // enabled and two clicks spawn two agent PTYs in the same folder.
    await expect(row).toBeDisabled();
    await expect(sibling).toBeDisabled();

    await expect(page.getByTestId("session-context-title")).toContainText("acme-app");
  });
});

test.describe("templates dialog", () => {
  test("lists the live catalog grouped by category, with a complexity band or an em dash", async ({ page }) => {
    await openTemplates(page);
    const dialog = page.getByTestId("templates-dialog");

    // More than the two entries the old hardcoded pin carried, and grouped by
    // the registry's outcome axes rather than one flat "Gallery" heading.
    await expect(page.getByTestId("template-row-web-research-digest")).toBeVisible();
    await expect(page.getByTestId("template-row-cold-outreach-engine")).toBeVisible();
    await expect(dialog).toContainText("Revenue and marketing");
    await expect(dialog).toContainText("Data and knowledge");
    // Bundled starters remain, as their own offline group.
    await expect(dialog).toContainText("Bundled starters");
    await expect(page.getByTestId("template-row-coding-pause")).toBeVisible();

    // The band rides on the card beside the step count. Two ends of the scale,
    // so a regression that blanked the slot could not pass by matching one word.
    await expect(page.getByTestId("template-row-dependency-upgrade")).toContainText("Advanced 5/5");
    await expect(page.getByTestId("template-row-approval-chain")).toContainText("Simple 2/5");

    // A card whose payload carried no band degrades to an em dash — the guard
    // that keeps a published Studio pointed at an older backend from throwing.
    const noBand = page.getByTestId("template-row-web-research-digest");
    await expect(noBand).toContainText("—");

    // And nothing in this dialog reads as money any more (SAP-2085 removed the
    // cost estimate; a card still printing one would mean we re-derived it).
    expect(await page.getByTestId("templates-dialog").textContent()).not.toMatch(/\$\d/);
  });

  test("search filters across name, tag, and capability", async ({ page }) => {
    await openTemplates(page);

    await page.getByTestId("template-search").fill("outreach");

    await expect(page.getByTestId("template-row-cold-outreach-engine")).toBeVisible();
    await expect(page.getByTestId("template-row-web-research-digest")).toHaveCount(0);

    await page.getByTestId("template-search").fill("zzz-no-such-template");
    await expect(page.getByTestId("templates-no-results")).toBeVisible();
  });

  test("selecting a template loads its manifest into the detail pane", async ({ page }) => {
    await openTemplates(page);

    await page.getByTestId("template-row-dependency-upgrade").click();

    const detail = page.getByTestId("template-detail");
    await expect(detail).toContainText("Dependency Upgrade");
    await expect(page.getByTestId("template-graph")).toBeVisible();
    // The destination follows the selection while it's untouched.
    await expect(page.getByTestId("template-dest-input")).toHaveValue(/dependency-upgrade$/);
  });
});
