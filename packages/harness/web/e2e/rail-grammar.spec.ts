/**
 * SAP-2982 — the rail's grammar, and the card that names the two nouns.
 *
 * The rail must keep its actions legible:
 *
 *   1. The project header's `+` starts a new chat at that root
 *      (flow-navigation.md Q11). New agent lives in the project view's header.
 *   2. Remove from the rail is the header's hover action, naming its subject.
 *   3. Only the chevron folded a project. Double-clicking the label, the
 *      platform convention for a disclosure row, did nothing — which reads as
 *      a row that has stopped responding, not as a feature that is absent.
 *   4. The taxonomy itself lived only in commit messages.
 *
 * These specs assert COMPUTED state, not presence: the reveal contract and the
 * fold are both CSS, and a control that renders at opacity 0 forever passes
 * every count-based assertion there is.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** A project's header row (`workspace-group-*` is the header itself). */
const ROW = (page: Page, label: string) =>
  page.getByTestId(`workspace-group-${label}`);

test.describe("project header grammar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
  });

  test("the header's verbs are New chat and Remove, each naming its own subject", async ({
    page,
  }) => {
    // flow-navigation.md Q11: the header's `+` is New chat. New agent moved to
    // the project view's header; Remove stays a hover action on the row.
    const actions = ROW(page, "acme-app").locator(".workspace-row-action");
    await expect(actions).toHaveCount(2);
    await expect(actions.nth(0)).toHaveAttribute(
      "data-testid",
      "project-new-chat-acme-app",
    );
    await expect(actions.nth(1)).toHaveAttribute(
      "data-testid",
      "project-remove-acme-app",
    );
    await expect(page.getByTestId("project-new-chat-acme-app")).toHaveAttribute(
      "aria-label",
      "New chat in acme-app",
    );
    await expect(page.getByTestId("project-remove-acme-app")).toHaveAttribute(
      "aria-label",
      "Remove acme-app from the rail",
    );
    await expect(page.locator(".rail-list [data-testid^='project-create-agent-']")).toHaveCount(0);
  });

  test("every rail tooltip names its action in at most 15 characters", async ({
    page,
  }) => {
    // flow-map-chat-overlay.md 4.6: a tooltip names the action in one to
    // three words; the aria-label carries the object's name. Eight strings
    // had grown explanation clauses ("Hide from the rail (History keeps it)").
    // The brand header at the top of the rail counts. `title`s count too
    // (TooltipLayer shows them, stashed after a hover), except row titles
    // that show a path, which are content.
    await page.getByTestId("project-select-acme-app").click();
    await expect(page.getByTestId("workspace-group-acme-app")).toHaveAttribute(
      "data-selected",
      "true",
    );
    const tips = await page.locator(".rail-workflows").evaluate((rail) =>
      [...rail.querySelectorAll("[data-tooltip], [title], [data-tip-stash]")]
        // TooltipLayer's precedence: data-tooltip, then the (stashed) title.
        .map(
          (el) =>
            el.getAttribute("data-tooltip") ||
            el.getAttribute("title") ||
            el.getAttribute("data-tip-stash") ||
            "",
        )
        .filter((tip) => !tip.includes("/")),
    );
    // Brand header, session marks, both project-row verbs, Hide and End,
    // Add project, Sort.
    expect(new Set(tips)).toEqual(
      new Set([
        "Collapse rail",
        "Past sessions",
        "Go back",
        "Go forward",
        "Add project",
        "Sort projects",
        "Collapse",
        "Agent Map",
        "New chat",
        "Remove",
        "Live",
        "Exited",
        "End session",
        "Hide",
        "Demo mode",
      ]),
    );
    expect(tips.filter((tip) => tip.length > 15)).toEqual([]);
  });

  test("New chat is visible at rest; Remove only on hover", async ({ page }) => {
    // A project with no sessions shows its header and + and nothing else
    // (4.6.1), so a hover-only + would leave that row saying nothing.
    await page.locator(".rail-header-label").hover();
    const opacity = (testid: string) =>
      page.getByTestId(testid).evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(await opacity("project-new-chat-onboarding-flow")).toBeGreaterThan(0);
    expect(await opacity("project-remove-onboarding-flow")).toBe(0);
    await page.getByTestId("project-select-onboarding-flow").hover();
    await expect.poll(() => opacity("project-remove-onboarding-flow")).toBe(1);
  });

  test("New agent from the project view creates IN that project, and only then talks", async ({
    page,
  }) => {
    // THE REQUEST, not a row count: the subject the header names is the
    // project the agent is scaffolded in, and the session that follows is
    // rooted there.
    const order = (): Promise<string[]> =>
      page.evaluate(
        () =>
          ((
            window as unknown as {
              __HARNESS_TEST__?: { createOrder?: string[] };
            }
          ).__HARNESS_TEST__?.createOrder ?? []) as string[],
      );

    await page.getByTestId("project-select-acme-app").click();
    await page.getByTestId("project-map-new-agent").click();
    // The screen STATES the project the header named (flow-creation.md §4.3).
    await expect(page.getByTestId("new-agent-project")).toHaveText(
      "New agent in acme-app",
    );
    // Nothing has started yet.
    expect(await order()).toEqual([]);

    await page.getByTestId("composer-input").fill("Build a menu made agent");
    await page.getByTestId("composer-send").click();
    await expect
      .poll(order)
      .toEqual([
        "scaffold:/Users/demo/acme-app/menu-made",
        "session:/Users/demo/acme-app",
      ]);
  });
});

test.describe("double-click toggles disclosure", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
  });

  test("double-clicking a project label folds it, and again unfolds it", async ({
    page,
  }) => {
    const row = ROW(page, "acme-app");
    const label = page.getByTestId("project-select-acme-app");
    const sessions = page.getByTestId("rail-project-acme-app").locator(".rail-session-row");
    await expect(sessions.first()).toBeVisible();

    await label.dblclick();
    await expect(row).toHaveClass(/is-collapsed/);
    await expect(sessions).toHaveCount(0);

    await label.dblclick();
    await expect(row).not.toHaveClass(/is-collapsed/);
    await expect(sessions.first()).toBeVisible();
  });

  test("it does not fight the single click: the project is still selected", async ({
    page,
  }) => {
    // A double-click fires two clicks underneath. Both select the project,
    // which is the same state twice, so the row ends up BOTH selected and
    // folded, never one at the cost of the other.
    const row = ROW(page, "acme-app");
    await page.getByTestId("project-select-acme-app").dblclick();
    await expect(row).toHaveClass(/is-collapsed/);
    await expect(row).toHaveClass(/is-selected/);
  });
});

test.describe("first-run explainer", () => {
  test("shows once, stays gone after a reload, and re-opens from the account menu", async ({
    page,
  }) => {
    // `?help=1` opts a mock page into the auto-show the real app does by
    // default (see `shouldAutoOpen`). It does NOT force the card open, so the
    // "already seen" path below is the same code a real install runs.
    //
    // "Seen" is `HarnessSettings.helpSeen`, a server-side per-install field
    // (SAP-2991). The mock stands that file in with its own storage key, so
    // the reload below asserts the same contract the real settings file keeps.
    await page.goto("/?seed=0&help=1");
    const card = page.getByTestId("help-overlay");
    await expect(card).toBeVisible();

    // It teaches exactly one thing, and names both nouns.
    await expect(page.getByTestId("help-projects")).toContainText("Projects");
    await expect(page.getByTestId("help-projects")).toContainText(
      "Folders you chose that hold agents",
    );
    await expect(page.getByTestId("help-agents")).toContainText("Agents");
    await expect(page.getByTestId("help-agents")).toContainText("What you run");
    // The upgrade line: an existing user opens 0.4.0 to a rearranged rail.
    await expect(page.getByTestId("help-upgrade-note")).toContainText(
      "Your projects were rebuilt from the folders you opened",
    );
    await expect(page.getByTestId("help-upgrade-note")).toContainText(
      "Nothing was deleted",
    );
    await expect(page.getByTestId("help-upgrade-note")).toContainText(
      "Add a project",
    );

    await page.getByTestId("help-overlay-dismiss").click();
    await expect(card).toHaveCount(0);

    // ONCE means once. A card that returns on every load is not an explainer,
    // it is an obstacle.
    await page.reload();
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("help-overlay")).toHaveCount(0);

    // …and it is never lost: it sits beside Overview, which is where a user
    // who wants the explanation back will look.
    await page.getByTestId("brand-identity").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await page.getByTestId("rail-help").click();
    await expect(page.getByTestId("help-overlay")).toBeVisible();

    // Esc is the same contract every card on top keeps.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("help-overlay")).toHaveCount(0);
  });

  test("does not raise itself over a page that has already seen it", async ({
    page,
  }) => {
    await page.goto("/?seed=0&help=1");
    await page.getByTestId("help-overlay-dismiss").click();
    await page.goto("/?seed=0&help=1");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("help-overlay")).toHaveCount(0);
  });

  test("survives a ui-prefs reset", async ({ page }) => {
    // AN INVARIANT, NOT THE SAP-2991 REGRESSION GUARD — and worth being
    // explicit about, because the two look alike. This spec passes against
    // the pre-fix code too: the old flag had its own key
    // (`sapiom-harness-help-seen`), so clearing `ui-prefs` never touched it.
    // The port-dependent bug is unprovable in a fixture served from one
    // stable origin; `rest.test.ts`'s re-read assertion is what fails without
    // the change, and a real two-port restart is what proved it.
    //
    // What this pins down is the REASON the fact is not a `ui-prefs` field.
    // `ui-prefs` is the UI's arrangement — folds, filing, pane widths — and it
    // is a blob a user may reasonably throw away. Having been taught what a
    // project is must not come back when the arrangement does, so a later
    // "just fold it into ui-prefs" simplification has to fail here.
    await page.goto("/?seed=0&help=1");
    await page.getByTestId("help-overlay-dismiss").click();
    await expect(page.getByTestId("help-overlay")).toHaveCount(0);

    await page.evaluate(() =>
      window.localStorage.removeItem("sapiom-harness-ui-prefs"),
    );
    await page.goto("/?seed=0&help=1");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("help-overlay")).toHaveCount(0);
  });
});
