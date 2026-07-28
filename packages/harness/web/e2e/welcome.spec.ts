/**
 * The Overview / first-run panel — mock-mode UI smoke (see smoke.spec.ts for the
 * setup). `/?mockState=fresh` renders MockApi as a brand-new install: no
 * sessions, no recent dirs, no workflows, AppState.firstRun set — the state the
 * real CLI produces on a machine that's never run the harness (it also skips the
 * auto boot session then). The default fixtures (a lived-in install) double as
 * the returning-user case.
 *
 * The panel has two states and they are NOT interchangeable: the hero pitch is
 * first-run only, and a returning user gets their recent workspaces instead. The
 * bug this guards is the hero rendering for someone who already has workspaces.
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

  test("'New workspace' opens the existing new-session flow and creating a session dismisses the panel", async ({
    page,
  }) => {
    await page.getByTestId("welcome-start-project").click();
    await expect(page.getByText("New session")).toBeVisible();

    // Same directory picker as the tab strip's "+" — pick a real fixture dir.
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    await page.getByRole("button", { name: "Start session" }).click();

    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);
    await expect(page.getByTestId("session-context-title")).toContainText("acme-app");
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
    await expect(page.getByTestId("welcome-recents")).toBeVisible();
    // The action band is shared by both states.
    await expect(page.getByTestId("welcome-start-project")).toBeVisible();
    await expect(page.getByTestId("welcome-browse-templates")).toBeVisible();
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
