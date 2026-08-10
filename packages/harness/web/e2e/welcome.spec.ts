/**
 * The first-run home is the composer-first "new session" screen
 * (NewSessionComposer), which replaced the WelcomePanel overlay. `/?mockState=fresh`
 * renders MockApi as a brand-new install: no sessions, no recent dirs, no
 * workflows, AppState.firstRun set — the state the real CLI produces on a machine
 * that has never run the harness. The default fixtures (a lived-in install)
 * double as the returning-user case, which boots straight into its session.
 *
 * The account menu's "Overview" no longer aliases the composer: it opens the
 * Overview modal (OverviewModal), a standalone introduction to the app that
 * sits OVER the workbench rather than replacing it.
 *
 * Recent-workspaces used to live on this surface; it now belongs to the left rail
 * (workspace tree), so those cases moved out with the overlay.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Open the Overview modal from the account menu. */
async function openOverview(page: Page): Promise<void> {
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await page.getByTestId("rail-overview").click();
  await expect(page.getByTestId("overview-modal")).toBeVisible();
}

/** Open the Overview, then the templates catalog from its "Start from a template". */
async function openTemplates(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openOverview(page);
  await page.getByTestId("overview-browse-templates").click();
  await expect(page.getByTestId("templates-panel")).toBeVisible();
}

test.describe("first run", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("opens on the composer: the question, quick ideas, and templates", async ({ page }) => {
    const composer = page.getByTestId("new-session-composer");
    await expect(composer).toBeVisible();
    // No terminal, no canvas yet — the composer stands in the centre pane.
    await expect(page.locator(".terminal-empty")).toHaveCount(0);
    await expect(page.getByTestId("agent-view")).toHaveCount(0);

    await expect(composer).toContainText("What should your agent do?");
    // The first-run greeting is the one thing that marks a first run.
    await expect(page.getByTestId("composer-greeting")).toContainText("first agent");

    // The four quick-idea chips, the box, and the send.
    await expect(page.getByTestId("composer-chip-sales-outreach")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeVisible();
    await expect(page.getByTestId("composer-send")).toBeVisible();

    // Starter templates render from the catalog, with the way to the full one.
    await expect(page.locator(".composer-template-card").first()).toBeVisible();
    await expect(page.getByTestId("composer-browse-templates")).toBeVisible();

    // First-run only: the one-time telemetry opt-in (SAP-1988) and docs.
    await expect(page.getByTestId("welcome-consent")).toBeVisible();
    const docs = page.getByTestId("welcome-docs");
    await expect(docs).toHaveAttribute("href", "https://docs.sapiom.ai/agents/quick-start");
    await expect(docs).toHaveAttribute("target", "_blank");

    await page.screenshot({ path: "web/e2e/screenshots/composer-home.png", fullPage: true });
  });

  test("the + opens the Add existing agents dialog, and the workspace joins the rail", async ({ page }) => {
    // The composer's leading + reaches the same "add existing agents" dialog the
    // rail's button does — one detection-driven picker, no doors.
    await page.getByTestId("composer-open-folder").click();
    await expect(page.locator(".modal-start")).toBeVisible();
    await expect(page.getByTestId("aw-doors")).toHaveCount(0);

    // Pick a fixture folder that holds an agent project — detection is reactive.
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");
    await expect(page.getByTestId("aw-result")).toContainText("This is an agent project");
    await page.getByTestId("aw-add").click();

    // The workspace joins the rail.
    await expect(page.locator(".modal-start")).toHaveCount(0);
    await expect(page.getByTestId("workflow-rfq-agent")).toBeVisible();
  });
});

test.describe("returning user", () => {
  test("the lived-in fixtures render straight into the boot session, no composer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  });

  test("Overview opens the introduction over the session, and Close returns to it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openOverview(page);

    const overview = page.getByTestId("overview-modal");
    // It names the product and says which build is running.
    await expect(overview).toContainText("agent.studio");
    await expect(page.getByTestId("overview-version")).toContainText("v");
    // Its two on-ramps into the app.
    await expect(page.getByTestId("overview-open-folder")).toBeVisible();
    await expect(page.getByTestId("overview-browse-templates")).toBeVisible();
    // A modal, not the composer it used to alias.
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);

    // Closing returns to the boot session it opened over — untouched.
    await page.getByTestId("overview-exit").click();
    await expect(overview).toHaveCount(0);
    await expect(page.getByTestId("session-context")).toHaveAttribute("data-session-id", "sess-boot");
  });

  test("Overview's Open-folder CTA opens the folder dialog", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openOverview(page);
    await page.getByTestId("overview-open-folder").click();

    await expect(page.locator(".modal-start")).toBeVisible();
  });

  test("the palette's Browse templates, opened over the Overview, leaves it (never stacks)", async ({
    page,
  }) => {
    // The palette is a global overlay reachable even while the Overview is up
    // (by shortcut — the modal's scrim owns the pointer); navigating from it
    // must dismiss the Overview rather than mount Templates behind it.
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openOverview(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-palette-input").fill("templates");
    await page.getByTestId("command-palette-list").getByText("Browse templates").click();

    await expect(page.getByTestId("templates-panel")).toBeVisible();
    await expect(page.getByTestId("overview-modal")).toHaveCount(0);
  });
});

test.describe("templates browser, reached from the Overview", () => {
  test("shows the live catalog with facets, not a pinned pair", async ({ page }) => {
    await openTemplates(page);
    const panel = page.getByTestId("templates-panel");
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();

    // More than the two entries the old hardcoded pin carried.
    await expect(page.getByTestId("template-card-web-research-digest")).toBeVisible();
    await expect(page.getByTestId("template-card-cold-outreach-engine")).toBeVisible();

    // The registry's outcome axis is a filter column now rather than a set of
    // headings the list was chopped into.
    await expect(panel).toContainText("Category");
    await expect(page.getByTestId("templates-category-revenue-marketing")).toContainText(
      "Revenue and marketing",
    );
    await expect(page.getByTestId("templates-category-data-knowledge")).toBeVisible();

    // Bundled starters remain, as their own offline block.
    await expect(panel).toContainText("Bundled starters");
    await expect(page.getByTestId("template-card-coding-pause")).toBeVisible();

    // Nothing on this surface reads as money — SAP-2085 replaced the per-run
    // cost estimate with a complexity band.
    expect(await panel.textContent()).not.toMatch(/\$\d/);
  });

  test("narrowing by category keeps the counts honest", async ({ page }) => {
    await openTemplates(page);
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();

    await page.getByTestId("templates-category-data-knowledge").click();
    await expect(page.getByTestId("template-card-web-research-digest")).toBeVisible();
    await expect(page.getByTestId("template-card-cold-outreach-engine")).toHaveCount(0);
  });

  test("opening a template loads its real manifest", async ({ page }) => {
    await openTemplates(page);
    await expect(page.getByTestId("templates-grid").first()).toBeVisible();

    await page.getByTestId("template-card-open-dependency-upgrade").click();

    const detail = page.getByTestId("template-detail");
    await expect(detail).toContainText("Dependency Upgrade");
    await expect(page.getByTestId("template-graph")).toBeVisible();
    await expect(page.getByTestId("template-use-btn")).toBeVisible();
  });
});
