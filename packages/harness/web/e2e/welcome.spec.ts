/**
 * The Overview / first-run panel — mock-mode UI smoke (see smoke.spec.ts for the
 * setup). `/?mockState=fresh` renders MockApi as a brand-new install: no
 * sessions, no recent dirs, no workflows, AppState.firstRun set — the state the
 * real CLI produces on a machine that's never run the harness (it also skips the
 * auto boot session then). The default fixtures (a lived-in install) double as
 * the returning-user case.
 *
 * The panel is ONE anatomy for both audiences now: hero band, what Studio is,
 * the two ways in (a folder, the catalog), documentation, then where you have
 * already been. Only the greeting differs — "Welcome to" is a thing you say
 * once — and the recents block simply has nothing to render on a fresh install.
 *
 * It used to fork into two whole layouts, a pitch and an Overview list, which
 * left the returning surface with no explanation of the product and the
 * first-run surface with no way into anything.
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
  await expect(page.getByTestId("templates-panel")).toBeVisible();
}

test.describe("first run", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("greets, says what Studio is, and offers the two ways in", async ({ page }) => {
    const panel = page.getByTestId("welcome-panel");
    await expect(panel).toBeVisible();
    // The card floats OVER the shell rather than replacing a pane, so the
    // terminal's own empty state stays behind it. That used to be asserted
    // absent, back when Overview was a view that took the slot.
    await expect(page.locator(".terminal-empty")).toBeVisible();

    // "Welcome to" is the one thing that marks a first run.
    await expect(panel).toContainText("Welcome to Agent Studio");
    await expect(panel).toContainText(
      "Local runs need no sign-in and stub Sapiom capability calls",
    );

    // Each way in is a row that says what picking it does, not a bare button.
    const folder = page.getByTestId("welcome-open-card");
    await expect(folder).toContainText("Open a folder");
    await expect(folder).toContainText("Agents in the folder appear in the rail");
    await expect(folder).toContainText("Nothing is uploaded");
    await expect(page.getByTestId("welcome-start-project")).toBeVisible();

    const templates = page.getByTestId("welcome-templates-card");
    await expect(templates).toContainText("Start from a template");
    await expect(page.getByTestId("welcome-browse-templates")).toBeVisible();

    // Nowhere to go back to on a fresh install, so nothing claims otherwise.
    await expect(page.getByTestId("welcome-recents")).toHaveCount(0);

    await page.screenshot({ path: "web/e2e/screenshots/welcome-panel.png", fullPage: true });
  });

  test("'Open folder' opens the folder door, and adding one dismisses the panel", async ({
    page,
  }) => {
    // This CTA used to open the SESSION modal — the most prominent button on
    // the first-run screen said "workspace" and delivered "new session". It now
    // reaches the same add flow the rail's + does, and lands directly on the
    // folder question rather than re-asking which of three intents this was.
    await page.getByTestId("welcome-start-project").click();
    await expect(page.locator(".modal-add-workspace")).toBeVisible();
    await expect(page.locator(".modal-new-session")).toHaveCount(0);
    await expect(page.getByTestId("aw-doors")).toHaveCount(0);

    // Already at door 1: pick a fixture folder that holds an agent project.
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");
    await page.getByTestId("aw-have-continue").click();
    await expect(page.getByTestId("aw-result")).toContainText("This is an agent project");
    await page.getByTestId("aw-add").click();

    // The workspace joins the rail; the first-run pitch is done.
    await expect(page.locator(".modal-add-workspace")).toHaveCount(0);
    await expect(page.getByTestId("workflow-rfq-agent")).toBeVisible();
  });

  test("documentation is a way out to the docs, never a dismiss", async ({ page }) => {
    const docs = page.getByTestId("welcome-docs");
    await expect(docs).toBeVisible();
    await expect(docs).toHaveAttribute("href", "https://docs.sapiom.ai/agents/quick-start");
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

  test("Overview drops the first-run greeting but keeps the same anatomy", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openOverview(page);

    const panel = page.getByTestId("welcome-panel");
    // Greeted once, on the first run — not every time you open Overview.
    await expect(panel).toContainText("Agent Studio");
    await expect(panel).not.toContainText("Sapiom Agent Studio");
    await expect(panel).not.toContainText("Welcome to");
    // Everything else is the same surface, plus the thing a returning user came
    // for: where they have already been.
    await expect(page.getByTestId("welcome-recents")).toBeVisible();
    await expect(page.getByTestId("welcome-start-project")).toBeVisible();
    await expect(page.getByTestId("welcome-browse-templates")).toBeVisible();
  });

  test("carries no screenshot of itself, and never puts content out of reach", async ({ page }) => {
    // The card briefly opened with a cropped capture of the app above the copy —
    // ~120px on a surface whose job is to be read at a glance, reading as a
    // fragment of a UI rather than a picture of the product.
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);
    await expect(page.getByTestId("welcome-hero")).toHaveCount(0);
    await expect(page.locator(".welcome-panel img")).toHaveCount(0);

    // Height is the regression that recurs here, and the first attempt at
    // guarding it measured the card against its container — which passed on
    // these fonts and failed on CI's, where the same copy wraps ~34px taller.
    // So the invariant is REACHABILITY, which no font metric can break: at any
    // window height the card stays inside the scrim, the two actions are on
    // screen, and the last workspace row can be scrolled to. Getting that wrong
    // is silent — a card that honours a max-height by clipping its own bottom
    // looks fine and hides rows below the fold.
    for (const height of [1000, 640, 460]) {
      await page.setViewportSize({ width: 1280, height });

      const card = await page.locator(".welcome-card").boundingBox();
      const scrim = await page.getByTestId("welcome-panel").boundingBox();
      expect(card!.height, `card must fit the scrim at ${height}px`).toBeLessThanOrEqual(
        scrim!.height,
      );

      // The fixed part stays put: these are the reason the card exists.
      await expect(page.getByTestId("welcome-start-project")).toBeInViewport();
      await expect(page.getByTestId("welcome-browse-templates")).toBeInViewport();

      // And the part that yields is scrollable rather than clipped.
      const lastRow = page.locator(".welcome-recent").last();
      await lastRow.scrollIntoViewIfNeeded();
      await expect(lastRow, `last row must be reachable at ${height}px`).toBeInViewport();
    }

    await page.setViewportSize({ width: 1280, height: 720 });
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
    // Newest activity first: acme-app (a live session) above rfq-agent (a day old).
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
    await page.getByTestId("welcome-recent-rfq-agent").click();
    await expect(page.getByTestId("welcome-panel")).toHaveCount(0);

    // The directory picker's chips are the surface that still reads recentDirs
    // directly, so they show what actually survived.
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("aw-door-have").click();
    const chips = page.locator(".recent-dir-chip");
    await expect(chips).toHaveCount(3); // all three fixtures kept, none dropped
    // The folder just opened moves to the front rather than replacing the list.
    // Asserted on the label, not `title`: TooltipLayer moves a title into
    // data-tip-stash to render its own tooltip, so a title assertion races that
    // rewrite and reads null once it has run.
    await expect(chips.first()).toContainText("rfq-agent");
  });

  test("rows disable while one is opening, so a second click cannot double-fire", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openOverview(page);

    const row = page.getByTestId("welcome-recent-acme-app");
    const sibling = page.getByTestId("welcome-recent-rfq-agent");
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

test.describe("templates browser, reached from Overview", () => {
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

    // Nothing on this surface reads as money. SAP-2085 replaced the per-run cost
    // estimate with a complexity band, so a price here would mean someone
    // re-derived one. The band itself is asserted in templates.spec.ts: it lives
    // on the card's spec sheet and in the detail note, not on the card face,
    // because it is a reference figure rather than what you choose by.
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
    // The bar carries the commit for whatever is open.
    await expect(page.getByTestId("template-use-btn")).toBeVisible();
  });
});
