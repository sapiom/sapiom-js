/**
 * The accumulation guard, and Remove project (SAP-2932).
 *
 * WHICH TEST COVERS WHAT — stated here because the ticket is explicit that
 * getting this wrong is how a future audit reads coverage that does not exist:
 *
 *  - **THE SYMPTOM is covered here**, by `describe("SYMPTOM …")` below: it
 *    sweeps every fixture in a browser for a project row that is a single
 *    agent wearing its own folder's name. It is the observable invariant, and
 *    it does NOT exercise `connectWorkflow` at all — it would pass on a build
 *    where the containment gate had been deleted.
 *  - **THE CAUSE is covered in `src/lib/project-membership.test.ts`**, by
 *    `describe("agentNeedsOwnProject: THE CAUSE …")`: the containment decision
 *    `connectWorkflow` makes before it remembers anything.
 *
 * The removal specs below are render assertions on purpose. Everything they
 * check is only true on screen — a control that appears on hover, a confirm
 * that names a count, a row that is gone and stays gone across a reload — and
 * three things in the reference prototype were reported met while broken
 * because the code existed and had never been exercised.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { openProjectMenu } from "./mock-navigation";

const ACME = "/Users/demo/acme-app";

/** Every fixture the mock can serve, so "across every fixture" is literal. */
const FIXTURES = [
  // `mockStudioProjects=absent` on every one. THE SHIPPED PLAN-FIRST RAIL FAILS
  // THIS SWEEP, and it does so by design elsewhere: `project-axis.spec.ts`'s "a
  // root agent is a separate target below the pinned Agent Map" specifies the
  // project header, the pinned map row and the agent row as THREE rows, which is
  // exactly the "project row that is a single agent wearing its own folder's
  // name" this sweep forbids. The two specs contradict each other and neither
  // could see it: one only ever ran on the opt-in payload, the other only on the
  // default. Which one is right is a product decision, so this file states the
  // conflict rather than picking a winner by editing an assertion.
  { name: "default", url: "/?mockStudioProjects=absent" },
  { name: "deep rail tree", url: "/?mockFixtures=deep&mockStudioProjects=absent" },
  { name: "search shapes", url: "/?mockFixtures=search&mockStudioProjects=absent" },
  // A brand-new install: the empty case, kept in the sweep so the guard is
  // known to hold at zero rows rather than assumed to.
  { name: "fresh install", url: "/?mockState=fresh&mockStudioProjects=absent" },
];

/**
 * Every project row that prints the same name as an agent row inside it.
 *
 * That stutter — the folder said `dashboard-keeper` and the only thing in it
 * said `dashboard-keeper` again — was 15 of one real install's 40 rows. The
 * project row a merged root agent OWNS is excluded, because it IS that agent's
 * row: it carries the agent's `workflow-<name>` testid deliberately, and one
 * row saying one thing is the fix, not the defect.
 */
async function stutteringRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".rail-list > .workspace-group")).flatMap((group) => {
      const testid = group.getAttribute("data-testid") ?? "";
      const label = testid.replace(/^workspace-group-/, "");
      // The label of a project opened inside another is a path
      // (`polsia/services/workers`); what a stutter would repeat is its last
      // segment.
      const leaf = label.split("/").pop() ?? label;
      // The pinned Agent Map row is also a direct `.workspace-row` child.
      const header = group.querySelector(":scope > .workspace-row:not(.is-nested)");
      return Array.from(group.querySelectorAll("[data-testid^='workflow-']"))
        .filter((row) => row !== header && row.classList.contains("workflow-item"))
        .map((row) => (row.getAttribute("data-testid") ?? "").replace(/^workflow-/, ""))
        .filter((name) => name === leaf)
        .map((name) => `${label} > ${name}`);
    }),
  );
}

test.describe("SYMPTOM: no project row is a single agent wearing its own folder's name", () => {
  for (const fixture of FIXTURES) {
    test(`holds across the ${fixture.name} fixture`, async ({ page }) => {
      await page.goto(fixture.url);
      await expect(page.locator(".rail-workflows")).toBeVisible();
      expect(await stutteringRows(page)).toEqual([]);
    });
  }

  test("a root that IS an agent renders as ONE row, not a header plus a twin", async ({ page }) => {
    // The positive half of the sweep. An empty result above is also what a
    // rail with no rows at all returns, so this pins the mechanism that
    // actually prevents the stutter: the root agent is MERGED into the project
    // row, which then carries its testid and its focus behaviour.
    await page.goto("/?mockFixtures=deep&mockStudioProjects=absent");
    const group = page.getByTestId("workspace-group-dashboard-keeper");
    await expect(group).toBeVisible();
    await expect(group.getByTestId("workflow-dashboard-keeper")).toHaveCount(1);
    await expect(
      group.locator(":scope > .workspace-row[data-testid='workflow-dashboard-keeper']"),
    ).toHaveCount(1);
  });
});

test.describe("Remove project", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?mockStudioProjects=absent");
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
  });

  test("the controls are hover-revealed on the row, and reachable by keyboard", async ({ page }) => {
    // A destructive action standing at full strength on every project row
    // would be the loudest thing in the rail; invisible even to the keyboard
    // would be worse. Both halves are CSS, so both are asserted on screen.
    // Remove lives inside the row's ⋮ (SAP-2982); the session shortcut sits
    // beside that menu and shares the same row-owned reveal contract.
    // `:not(.is-nested)` because a plan-first group has a SECOND direct
    // `.workspace-row` child, the pinned Agent Map row — unqualified this is a
    // strict-mode violation there rather than the project header.
    const row = page
      .getByTestId("workspace-group-acme-app")
      .locator(":scope > .workspace-row:not(.is-nested)");
    const actions = row.locator(":scope > .workspace-row-action");
    const opacities = (): Promise<string[]> =>
      actions.evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).opacity),
      );

    expect(await opacities()).toEqual(["0", "0"]);
    await row.hover();
    await expect.poll(opacities).toEqual(["1", "1"]);

    await page.mouse.move(0, 0);
    await expect.poll(opacities).toEqual(["0", "0"]);
    await actions.first().focus();
    await expect
      .poll(() =>
        actions.first().evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await actions.nth(1).focus();
    await expect
      .poll(() =>
        actions.nth(1).evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
  });

  test("an OPEN menu holds its trigger on screen after the pointer leaves", async ({ page }) => {
    // The popover is anchored to the ⋮. Letting the trigger fade back to
    // opacity 0 when the pointer leaves the row leaves a card floating beside
    // nothing — the anchor is invisible and the menu looks unmoored.
    const menu = page.getByTestId("project-menu-acme-app");
    await menu.click();
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("project-menu-card-acme-app")).toBeVisible();
    await expect
      .poll(() => menu.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
  });

  test("a COLLAPSED project row does not grow a standing ⋮", async ({ page }) => {
    // `.workspace-row.is-collapsed .workspace-row-action[aria-expanded]` tests
    // only that the attribute is PRESENT, and a menu trigger always carries
    // one — so without the exclusion in styles.css every collapsed project row
    // wore a permanent ⋮, which is exactly the standing control the rail's
    // hover-reveal exists to avoid.
    await page.getByTestId("project-disclosure-acme-app").click();
    const row = page.getByTestId("workspace-group-acme-app").locator(":scope > .workspace-row:not(.is-nested)");
    await expect(row).toHaveClass(/is-collapsed/);
    await page.mouse.move(0, 0);
    await expect
      .poll(() =>
        page
          .getByTestId("project-menu-acme-app")
          .evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("0");
  });

  test("the confirm NAMES the number of sessions it ends, and says nothing on disk is touched", async ({
    page,
  }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-remove-acme-app").click();
    const confirm = page.getByTestId("remove-project-confirm");
    await expect(confirm).toBeVisible();
    // The fixture has two live sessions in acme-app (sess-boot, sess-leasing-2)
    // and three exited ones. The count is about what will be KILLED.
    await expect(page.getByTestId("remove-project-confirm-count")).toHaveText(
      "Ends 2 running sessions.",
    );
    await expect(confirm).toContainText("Nothing on disk is touched");
    await expect(confirm).toContainText("no file is created, moved or deleted");
    await expect(confirm).toContainText(ACME);
  });

  test("says so plainly when there is nothing to end", async ({ page }) => {
    // rfq-agent has one exited session and no live one. An abstract warning
    // here would be a lie in the only direction that matters.
    await openProjectMenu(page, "rfq-agent");
    await page.getByTestId("project-remove-rfq-agent").click();
    await expect(page.getByTestId("remove-project-confirm-count")).toHaveText(
      "No running sessions to end.",
    );
  });

  test("Keep project changes nothing", async ({ page }) => {
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-remove-acme-app").click();
    await page.getByRole("button", { name: "Keep project" }).click();
    await expect(page.getByTestId("remove-project-confirm")).toHaveCount(0);
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();
  });

  test("removes the project and its agents, ends its live sessions, and does NOT come back on reload", async ({
    page,
  }) => {
    // Before: the project, the agent inside it, and its entry in the stored
    // directory list.
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();
    expect(await recentDirPaths(page)).toContain(ACME);

    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-remove-acme-app").click();
    await page.getByTestId("remove-project-confirm-btn").click();

    await expect(page.getByTestId("workspace-group-acme-app")).toHaveCount(0);
    // The agent inside it goes with it. Left behind it would reappear under
    // the unrooted-agents header, and a removal that only relocates its rows
    // has not removed anything.
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(0);
    // Its LIVE sessions were actually ended — the two the confirm counted, and
    // only those. `killSessionCalls` is the mock's record of the real DELETE.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            ((window as unknown as { __HARNESS_TEST__?: { killSessionCalls?: string[] } })
              .__HARNESS_TEST__?.killSessionCalls ?? []).slice().sort(),
        ),
      )
      .toEqual(["sess-boot", "sess-leasing-2"]);
    // Out of `recentDirs`, not merely out of the tree.
    expect(await recentDirPaths(page)).not.toContain(ACME);
    // Neighbours are untouched.
    await expect(page.getByTestId("workspace-group-rfq-agent")).toBeVisible();
    await expect(page.getByTestId("workspace-group-scratch")).toBeVisible();

    // AND IT STAYS GONE. The mock serves its fixture settings fresh on every
    // load — `recentDirs` names acme-app again, and three of its sessions are
    // still in the registry as exited, whose cwds are project roots too. This
    // is the reload the tombstone exists for.
    await page.reload();
    await expect(page.getByTestId("workspace-group-rfq-agent")).toBeVisible();
    await expect(page.getByTestId("workspace-group-acme-app")).toHaveCount(0);
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(0);
  });

  test("comes back when the folder is opened again — removal is not a blocklist", async ({
    page,
  }) => {
    // Nothing was deleted, so nothing has to be restored: registering the
    // agent that lives in the removed folder reopens the folder. Filing it
    // into a hidden project would leave an agent that exists and nothing
    // shows; giving it a root of its own would mint `acme-app/leasing`, which
    // is the accumulation this ticket closes.
    await openProjectMenu(page, "acme-app");
    await page.getByTestId("project-remove-acme-app").click();
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("workspace-group-acme-app")).toHaveCount(0);

    await page.getByTestId("add-existing-agents").click();
    await page.getByTestId("folder-field-input").fill(`${ACME}/leasing`);
    await page.getByTestId("aw-add").click();

    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();
    // And it came back as ONE project, not as a new `acme-app/leasing` row.
    await expect(page.getByTestId("workspace-group-acme-app/leasing")).toHaveCount(0);
  });

  test("a project opened INSIDE the removed one survives, with its agents", async ({ page }) => {
    // `~/polsia` and `~/polsia/services/workers` are two real contexts. The
    // inner one is not what the user closed.
    await page.goto("/?mockFixtures=deep&mockStudioProjects=absent");
    await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
    // Labelled by its path from the parent project while that parent is open,
    // so it cannot be confused with the `workers` subdirectory row inside it.
    await expect(page.getByTestId("workspace-group-polsia/services/workers")).toBeVisible();

    await openProjectMenu(page, "polsia");
    await page.getByTestId("project-remove-polsia").click();
    await page.getByTestId("remove-project-confirm-btn").click();

    await expect(page.getByTestId("workspace-group-polsia")).toHaveCount(0);
    // It survives — and narrows to its own basename, because the collision the
    // longer label existed to resolve went with the parent. Nothing to
    // disambiguate against, nothing spent disambiguating.
    const nested = page.getByTestId("workspace-group-workers");
    await expect(nested).toBeVisible();
    await expect(page.getByTestId("workspace-group-polsia/services/workers")).toHaveCount(0);
    // The nested project's own agents stay reachable...
    await expect(nested.getByTestId("workflow-queue")).toBeVisible();
    await expect(nested.getByTestId("workflow-ads-worker")).toBeVisible();
    // ...while agents that lived only under the closed root are gone, rather
    // than falling through to the unrooted-agents header.
    await expect(page.getByTestId("workflow-gateway")).toHaveCount(0);
    await expect(page.getByTestId("workflow-mailer")).toHaveCount(0);
    await expect(page.getByTestId("workflow-rollup")).toHaveCount(0);
  });
});

/**
 * The stored directory list, read through the only surface that renders it:
 * the palette's Files tab, which shows `recentDirs` and nothing else
 * (`FILTER_KINDS.files === ["recent"]`).
 */
async function recentDirPaths(page: Page): Promise<string[]> {
  await page.getByTestId("palette-trigger").click();
  await expect(page.getByTestId("command-palette-list")).toBeVisible();
  await page.getByTestId("command-palette-filter-files").click();
  const paths = await page.locator(".command-palette-item-meta").allInnerTexts();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette-list")).toHaveCount(0);
  return paths.map((path) => path.trim());
}
