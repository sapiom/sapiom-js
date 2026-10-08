/**
 * The rail's project headers, rendered (flow-navigation.md 4.1, design.md
 * §4.1: this spec is rewritten around Project › Sessions).
 *
 * The agent tree this file used to test is gone: agents live on the project's
 * map now (Q3), and the Group axis left with them (Q8). What survives is the
 * part of the old Project axis that was about PROJECTS: which folders are
 * projects, how they are ordered, how a header folds and stays folded, the
 * header's own chrome, and that a header's title is its absolute path.
 *
 * Runs against `?mockFixtures=deep`, which opens a nested project inside
 * another (`polsia/services/workers`) and a project whose root is itself an
 * agent (`dashboard-keeper`).
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openNewAgentInProject } from "./mock-navigation";

const ROOT = "/Users/demo/polsia";
/** `polsia/services/workers` opened as its own project. */
const NESTED_LABEL = "polsia/services/workers";
test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
});

const opacityOf = (locator: Locator): Promise<string> =>
  locator.evaluate((element) => getComputedStyle(element).opacity);

/** The project headers' labels, in rail order. */
const labels = (page: Page): Promise<string[]> =>
  page
    .locator(
      ".rail-list > .rail-project > .rail-project-row > .workspace-row-main > .tree-row-label",
    )
    .allInnerTexts();

test.describe("projects, not agents", () => {
  test("the rail lists project headers and sessions only: no agent rows, no directory rows", async ({
    page,
  }) => {
    await expect(page.locator(".rail-list [data-testid^='workflow-']")).toHaveCount(0);
    await expect(page.locator(".rail-list [data-testid^='dir-row-']")).toHaveCount(0);
    await expect(page.locator(".rail-list .workspace-subgroup")).toHaveCount(0);
    // A project whose root IS an agent is still one header, not a header
    // plus a twin agent row.
    await expect(
      page.getByTestId("rail-project-dashboard-keeper").locator(".rail-project-row"),
    ).toHaveCount(1);
  });

  test("a nested project reads parent/child, and folding it leaves its parent open", async ({
    page,
  }) => {
    const nested = page.getByTestId(`workspace-group-${NESTED_LABEL}`);
    await expect(nested.locator(".tree-row-label")).toHaveText(NESTED_LABEL);

    // `project:` keys are namespaced per root, so folding the nested project
    // never folds its parent.
    await page.getByTestId(`project-disclosure-${NESTED_LABEL}`).click();
    await expect(page.getByTestId(`project-disclosure-${NESTED_LABEL}`)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.getByTestId("project-disclosure-polsia")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

test.describe("project selection", () => {
  test("the label selects the project's map and does not fold it", async ({
    page,
  }) => {
    const map = page.getByTestId("project-select-dashboard-keeper");
    await expect(map).toHaveAccessibleName("Open Agent Map for dashboard-keeper");
    await map.click();
    await expect(map).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("project-map-pane")).toBeVisible();
    await expect(page.getByTestId("project-disclosure-dashboard-keeper")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Only the disclosure folds, and the map stays the centre.
    const disclosure = page.getByTestId("project-disclosure-dashboard-keeper");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("project-map-pane")).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  test("the project header carries no deploy glyph", async ({ page }) => {
    await expect(
      page.getByTestId("workspace-group-dashboard-keeper").locator(".workflow-status, .workflow-deployed-tag"),
    ).toHaveCount(0);
  });

  test("New agent lives in the project view's header", async ({ page }) => {
    await expect(page.locator(".rail-list [data-testid^='project-create-agent-']")).toHaveCount(0);
    await openNewAgentInProject(page, "dashboard-keeper");
  });

  test("a non-map destination clears the project selection", async ({ page }) => {
    const map = page.getByTestId("project-select-dashboard-keeper");
    await map.click();
    await expect(map).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("rail-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    await expect(map).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("row chrome", () => {
  test("hovering a header swaps its mark for a chevron, and NO row has a trailing one", async ({
    page,
  }) => {
    const row = page.getByTestId("workspace-group-polsia");
    const mark = row.locator(".row-disclosure-mark");
    const chevron = row.locator(".row-disclosure-chevron");

    // At rest the row shows its identity, not a control.
    await page.locator(".rail-header-label").hover();
    expect(await opacityOf(mark)).toBe("1");
    expect(await opacityOf(chevron)).toBe("0");

    // Re-hover inside the retry: a session event can reorder the rail
    // (sort by recent activity) and move the row out from under the pointer.
    await expect(async () => {
      await page.getByTestId("project-select-polsia").hover();
      expect(await opacityOf(chevron)).toBe("1");
    }, "chevron reveals on hover").toPass();
    expect(await opacityOf(mark)).toBe("0");

    // A COLLAPSED row keeps its chevron unhovered: "there is more here" must
    // never be invisible.
    await page.getByTestId("project-disclosure-polsia").click();
    await page.locator(".rail-header-label").hover();
    await expect
      .poll(() => opacityOf(chevron), {
        message: "a collapsed row keeps its chevron",
      })
      .toBe("1");

    await expect(page.locator(".rail-list .workspace-caret")).toHaveCount(0);
    const misplaced = await page
      .locator(".rail-list .rail-project-row")
      .evaluateAll(
        (rows) =>
          rows.filter((row) => {
            const disclosure = row.querySelector(":scope > .row-disclosure");
            return disclosure == null || disclosure !== row.firstElementChild;
          }).length,
      );
    expect(misplaced, "every disclosure is the header's LEADING element").toBe(0);
  });

  test("the section header is a title, not a control", async ({ page }) => {
    await expect(page.locator(".rail-header-label")).toHaveText("Projects");
    await expect(page.locator(".rail-header [aria-expanded]")).toHaveCount(1); // the sliders popover
    await expect(page.locator(".rail-header .row-disclosure")).toHaveCount(0);
    await expect(
      page.locator(".rail-header button[aria-expanded]"),
    ).toHaveAttribute("data-testid", "history-trigger");
  });

  test("the header's + sits LEFT OF the options glyph, and adds a PROJECT", async ({
    page,
  }) => {
    await expect(page.getByTestId("rail-add-project")).toHaveAttribute(
      "aria-label",
      "Add project",
    );

    // The LABEL owns the leading edge, then `+`, then the sort options last.
    const headerOrder = await page
      .locator(".rail-header")
      .evaluate((el) =>
        [...el.querySelectorAll("[data-testid], .rail-header-label")].map(
          (n) => n.getAttribute("data-testid") ?? "label",
        ),
      );
    expect(headerOrder).toEqual(["label", "rail-add-project", "history-trigger"]);

    const indents = await page.evaluate(() => ({
      header: Math.round(
        document.querySelector(".rail-header-label")!.getBoundingClientRect()
          .left,
      ),
      navRow: Math.round(
        document
          .querySelector('[data-testid="rail-templates"] span')!
          .getBoundingClientRect().left,
      ),
    }));
    expect(indents.header).toBeLessThan(indents.navRow);

    await page.getByTestId("rail-add-project").click();
    await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    // SLIDERS: the menu holds one subject, how the projects are ordered.
    const options = page.getByTestId("history-trigger");
    await expect(options.locator("svg.lucide-sliders-horizontal")).toHaveCount(1);
    await expect(options.locator("svg.lucide-ellipsis-vertical")).toHaveCount(0);
    await expect(page.locator(".rail-shell svg.lucide-ellipsis")).toHaveCount(0);
    await expect(options).toHaveAttribute("aria-label", "Sort projects");
    await options.click();
    await expect(page.getByTestId("sort-recent")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("sort-name")).toHaveAttribute("aria-checked", "false");
    // Group by left with the Group axis (Q8).
    await expect(page.getByTestId("filing-group-by")).toHaveCount(0);
    await expect(page.getByTestId("rail-options-menu")).not.toContainText("Group");
  });

  test("Sort by actually reorders the projects, and the choice survives a reload", async ({
    page,
  }) => {
    // "recent" is the recentDirs MRU order, which is not alphabetical.
    expect(await labels(page)).toEqual([
      "acme-app",
      "rfq-agent",
      "onboarding-flow",
      "polsia",
      "polsia/services/workers",
      "dashboard-keeper",
      // `scratch` is a session cwd, not a recentDirs entry, so it ranks below
      // every folder the MRU list knows about.
      "scratch",
    ]);

    await page.getByTestId("history-trigger").click();
    await page.getByTestId("sort-name").click();
    await page.keyboard.press("Escape");
    expect(await labels(page)).toEqual([
      "acme-app",
      "dashboard-keeper",
      "onboarding-flow",
      "polsia",
      "rfq-agent",
      "scratch",
      // Sorted by BASENAME: a nested project's label is widened for
      // disambiguation, but `workers` is what it is called.
      "polsia/services/workers",
    ]);

    await page.reload();
    await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
    await page.getByTestId("history-trigger").click();
    await expect(page.getByTestId("sort-name")).toHaveAttribute("aria-checked", "true");
  });

  test("a folded project stays folded across a reload, and hides its sessions", async ({
    page,
  }) => {
    const sessions = page.getByTestId("rail-project-acme-app").locator(".rail-session-row");
    await expect(sessions.first()).toBeVisible();
    await page.getByTestId("project-disclosure-acme-app").click();
    await expect(sessions).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("workspace-group-polsia")).toBeVisible();
    await expect(page.getByTestId("project-disclosure-acme-app")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(sessions).toHaveCount(0);
  });
});

test.describe("legibility", () => {
  test("every header's title is its ABSOLUTE path", async ({ page }) => {
    await expect(
      page.getByTestId("project-select-polsia"),
    ).toHaveAttribute("title", ROOT);
    await expect(
      page.getByTestId("project-select-dashboard-keeper"),
    ).toHaveAttribute("title", "/Users/demo/dashboard-keeper");

    const bad = await page
      .locator(".rail-list .rail-project-row .workspace-row-main")
      .evaluateAll((mains) =>
        mains
          .filter(
            (main) =>
              !/^\/Users\/demo(\/|$)/.test(main.getAttribute("title") ?? ""),
          )
          .map(
            (main) =>
              `${main.textContent?.trim()} → ${main.getAttribute("title")}`,
          ),
      );
    expect(bad).toEqual([]);
  });
});

test("the deep rail renders", async ({ page }: { page: Page }) => {
  await page.screenshot({
    path: "web/e2e/screenshots/project-axis.png",
    fullPage: true,
  });
});
