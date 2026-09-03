/**
 * SAP-2982 — the rail's grammar, and the card that names the two nouns.
 *
 * The rail must keep four different actions legible:
 *
 *   1. The project-row `+` starts a coding-agent SESSION at that root. It is a
 *      frequent shortcut, not another way to scaffold a Sapiom agent.
 *   2. The `⋮` holds explicitly named PROJECT management actions and the
 *      legacy-server create-agent compatibility action.
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

import { openProjectMenu } from "./mock-navigation";

const ROW = (page: Page, label: string) =>
  page
    .getByTestId(`workspace-group-${label}`)
    .locator(":scope > .workspace-row");

test.describe("legacy-server project row grammar", () => {
  test.beforeEach(async ({ page }) => {
    // Direct create/scaffold controls survive only for older server payloads
    // that do not include the durable Studio project catalog.
    await page.goto("/?seed=0&mockStudioProjects=absent");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
  });

  test("a session shortcut sits immediately before the named project menu", async ({
    page,
  }) => {
    const row = ROW(page, "acme-app");
    // The frequent session action is one click away. Destructive project
    // management remains behind the named overflow menu instead of returning
    // as an adjacent `×`.
    const actions = row.locator(".workspace-row-action");
    await expect(actions).toHaveCount(2);
    await expect(actions.nth(0)).toHaveAttribute(
      "data-testid",
      "project-start-session-acme-app",
    );
    await expect(actions.nth(0)).toHaveAttribute(
      "aria-label",
      "Start a session in acme-app",
    );
    await expect(actions.nth(1)).toHaveAttribute(
      "data-testid",
      "project-menu-acme-app",
    );

    // And the actions themselves state their subject in words.
    await openProjectMenu(page, "acme-app");
    await expect(page.getByTestId("project-create-agent-acme-app")).toHaveText(
      "Create an agent in acme-app",
    );
    await expect(page.getByTestId("project-remove-acme-app")).toHaveText(
      "Remove acme-app from the rail",
    );
  });

  test("a bare project's session shortcut stays distinct from scaffolding", async ({
    page,
  }) => {
    // `scratch` has live sessions and no Sapiom agent. The row `+` can start
    // another coding session; the legacy scaffold operation remains named in
    // the menu so the two operations do not masquerade as one another.
    const row = ROW(page, "scratch");
    await expect(row.locator(".workspace-row-action")).toHaveCount(2);
    await expect(
      page.getByTestId("project-start-session-scratch"),
    ).toBeVisible();
    await openProjectMenu(page, "scratch");
    await expect(page.getByTestId("workspace-scaffold-scratch")).toHaveText(
      "Scaffold an agent in scratch",
    );
    await expect(page.getByTestId("project-remove-scratch")).toBeVisible();
  });

  test("creating from the menu creates IN that project, and only then talks", async ({
    page,
  }) => {
    // The menu changed what the control SAYS; SAP-2981 changed what it does —
    // it opens the create dialog instead of starting a pty and asking the
    // coding agent, in English, to scaffold. What must not change is the
    // SUBJECT: the project named on the row is the project it creates in, and
    // the session that follows is rooted there.
    //
    // THE REQUEST, not a tab count. This spec first counted
    // `[data-testid^='session-tab-']` and was worthless: `/?seed=0` renders two
    // session tabs plus `session-tab-new` before anything is clicked, so the
    // assertion held with the handler stubbed to a no-op — a spec that cannot
    // fail, guarding the one behaviour this PR promises it did not change.
    const order = (): Promise<string[]> =>
      page.evaluate(
        () =>
          ((
            window as unknown as {
              __HARNESS_TEST__?: { createOrder?: string[] };
            }
          ).__HARNESS_TEST__?.createOrder ?? []) as string[],
      );

    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-create-agent-acme-app").click();
    await expect(page.getByTestId("project-menu-card-acme-app")).toHaveCount(0);
    await expect(page.getByTestId("create-agent-project")).toHaveText(
      "acme-app",
    );
    // Nothing has started yet — the old handler started a pty on this click.
    expect(await order()).toEqual([]);

    await page.getByTestId("create-agent-name").fill("menu-made");
    await page.getByTestId("create-agent-submit").click();
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
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();

    await label.dblclick();
    await expect(row).toHaveClass(/is-collapsed/);
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(0);

    await label.dblclick();
    await expect(row).not.toHaveClass(/is-collapsed/);
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();
  });

  test("it does not fight the single click: the project is still selected", async ({
    page,
  }) => {
    // A double-click fires two clicks underneath. Both of this row's clicks
    // are idempotent — selecting the already-selected project is the same
    // state twice — so the row must end up BOTH selected and folded, never one
    // at the cost of the other.
    const row = ROW(page, "acme-app");
    await page.getByTestId("project-select-acme-app").dblclick();
    await expect(row).toHaveClass(/is-collapsed/);
    await expect(row).toHaveClass(/is-selected/);
  });
});

test.describe("double-click on a folder row", () => {
  // THE DEEP FIXTURE, because the default mock has no branching directory row
  // and this spec used to `test.skip` on it unconditionally. A permanent skip
  // is not a pending test, it is an absent one — and the third-toggle trick is
  // the subtlest thing in this change, with the quietest failure mode: nothing
  // happens. `?mockFixtures=deep` is the same fixture `project-axis.spec.ts`
  // uses, and it carries `polsia/services` as a real branch point.
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockFixtures=deep");
    await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
  });

  test("a folder row's double-click lands where its single click does", async ({
    page,
  }) => {
    // Two clicks toggled twice and cancelled out, so double-clicking a folder
    // did visibly nothing — the same absent convention, one level down.
    const dirRow = page.getByTestId("dir-row-services");
    await expect(dirRow).not.toHaveClass(/is-collapsed/);
    await dirRow.locator(".workspace-row-main").dblclick();
    await expect(dirRow).toHaveClass(/is-collapsed/);
    await dirRow.locator(".workspace-row-main").dblclick();
    await expect(dirRow).not.toHaveClass(/is-collapsed/);
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
