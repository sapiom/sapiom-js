/**
 * "Outside your projects", rendered against the shape a real install has —
 * round 2, defect 3.
 *
 * Every assertion here would have PASSED against round 1's fixtures and failed
 * against the user's machine, which is the whole lesson of the round: the deep
 * fixture has nine agents with globally unique names and no unrooted section
 * worth the name, so the defects could not be reached from a browser at all.
 *
 * `?mockFixtures=flood` reproduces the measured shape: 24 unrooted agents, six
 * named `ari-grade-repo` and six `brain-agent` across sibling git worktrees
 * that share the immediate parent `ari`, plus two
 * `@sapiom/example-slack-notifier` one segment apart.
 *
 * The four failures, one describe each:
 *   (a) no absolute path reachable by hover
 *   (b) same-named rows indistinguishable, and sharing one testid
 *   (c) no route from "outside your projects" back to a project
 *   (d) the section unbounded, so it dominates the rail
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const ORCHESTRATION = "/Users/demo/design-eng/ari/orchestration";
const FIX_ORCHESTRATION = "/Users/demo/design-eng-fix/ari/orchestration";

/** Every unrooted row's testid, in DOM order. */
const unrootedTestids = (page: Page): Promise<string[]> =>
  page
    .locator('[data-testid^="unrooted-agent-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));

/** Every unrooted row's rendered label — prefix and name as the user reads it. */
const unrootedLabels = (page: Page): Promise<string[]> =>
  page.locator('[data-testid^="unrooted-agent-"]').evaluateAll((nodes) =>
    nodes.map(
      (node) =>
        `${node.querySelector(".tree-row-prefix")?.textContent ?? ""}/${
          node.querySelector(".tree-row-label")?.textContent ?? ""
        }`,
    ),
  );

const expand = async (page: Page): Promise<void> => {
  await page.getByTestId("unrooted-header").click();
  await expect(page.locator('[data-testid^="unrooted-agent-"]').first()).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=flood");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("unrooted-section")).toBeVisible();
});

test.describe("(d) the section is BOUNDED", () => {
  test("it is closed by default and names how many it is holding", async ({ page }) => {
    await expect(page.getByTestId("unrooted-count")).toHaveText("24");
    await expect(page.locator('[data-testid^="unrooted-agent-"]')).toHaveCount(0);
  });

  test("it renders LAST — after every project", async ({ page }) => {
    await expand(page);
    const order = await page
      .locator('.rail-list [data-testid^="project-row-"], .rail-list [data-testid="unrooted-section"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
    expect(order.length).toBeGreaterThan(1);
    expect(order[order.length - 1]).toBe("unrooted-section");
  });

  test("the fold survives a reload, in its own key namespace", async ({ page }) => {
    await expand(page);
    await page.reload();
    await expect(page.locator('[data-testid^="unrooted-agent-"]').first()).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}") as {
              collapsedKeys?: string[];
            }
          ).collapsedKeys ?? [],
      ),
    ).toContain("unrooted:expanded");
  });

  /**
   * DEFECT 2, stated as what the user actually saw: "switching the Group axis
   * doesn't do anything".
   *
   * The axis worked — `group-row-*` rendered and the launch-edges route
   * returned real data. What did not happen was anything ON SCREEN: with 24
   * unrooted rows open above the fold, every group row was below it, so the
   * only feedback the change produced was a header word. If nothing about the
   * VISIBLE rail changes when the axis changes, that is a bug regardless of
   * what the DOM contains further down — so this compares what is in the
   * viewport, not what is in the document.
   *
   * This is also why the flood fixture subsumes the deep one: the groups and
   * the flood have to be on screen together, which is the shape the real
   * install had and no round-1 fixture did.
   */
  test("switching to the Group axis changes the VISIBLE rail", async ({ page }) => {
    const visible = (): Promise<string[]> =>
      page.evaluate(() => {
        const list = document.querySelector(".rail-list");
        if (!list) return [];
        return [
          ...list.querySelectorAll(
            '.workflow-item, [data-testid^="project-row-"], [data-testid^="group-row-"]',
          ),
        ]
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top < window.innerHeight && rect.bottom > 0;
          })
          .map((row) => row.getAttribute("data-testid") ?? "");
      });

    const before = await visible();
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    // The title stays "Projects" on BOTH axes: the rail lists projects either
  // way and the axis only changes their arrangement, so swapping it announced
  // a subject that had not changed. The axis is stated on the Group-by control.
  await expect(page.locator(".rail-header-label")).toHaveText("Projects");
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();

    const after = await visible();
    expect(after).not.toEqual(before);
    expect(after.filter((id) => id.startsWith("group-row-")).length).toBeGreaterThan(0);
  });

  /**
   * F14: the same disambiguation, one axis over.
   *
   * The Group axis has no directory rows to carry context, so an agent row
   * there is the whole answer to "which agent is this". Round 1 passed it no
   * prefix, and `polsia`'s two `ingest` agents rendered as two identical rows
   * inside `Ungrouped` — the unrooted section's failure, in a different
   * section, from the same missing rule.
   */
  test("group-axis rows disambiguate two agents that share a name", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();

    const rows = page.locator(
      '[data-testid^="group-agent-"] [data-agent-path$="/ingest"] .tree-row-name',
    );
    await expect(rows).toHaveCount(2);
    const labels = await rows.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).innerText.replace(/\s+/g, "")),
    );
    expect(new Set(labels).size).toBe(2);
    // The immediate parent is enough here — `pipelines` vs `etl` — so the rule
    // stops at one segment, exactly as [SEEN] rule 1 wants.
    expect(labels.sort()).toEqual(["etl/ingest", "pipelines/ingest"]);
  });

  /** And the groups are ABOVE the unrooted overflow, never below it. */
  test("the group rows render above the unrooted section", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();
    const order = await page
      .locator('.rail-list [data-testid^="group-row-"], .rail-list [data-testid="unrooted-section"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
    expect(order.filter((id) => id.startsWith("group-row-")).length).toBeGreaterThan(0);
    expect(order[order.length - 1]).toBe("unrooted-section");
  });
});

test.describe("(a) every row's absolute path is reachable by HOVER", () => {
  test("the tooltip the app actually renders is the path, not 'Focus this agent'", async ({
    page,
  }) => {
    await expand(page);
    // The app has ONE tooltip layer and it reads `data-tooltip` FIRST, falling
    // back to the stashed native `title` — so a row carrying both shows the
    // data-tooltip and the path is unreachable. That is why round 1's `title`
    // was there and the user still reported "the hover doesn't show path".
    const row = page.getByTestId(`unrooted-agent-${ORCHESTRATION}`);
    // Scroll first, THEN hover: the tooltip layer hides on any scroll (capture
    // phase), so hovering a row Playwright has to scroll to would show and
    // immediately hide it.
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await row.locator(".workflow-item-trigger").hover();
    await expect(page.locator(".app-tooltip")).toHaveText(ORCHESTRATION);
  });

  test("and the title attribute is the absolute path on EVERY unrooted row", async ({ page }) => {
    await expand(page);
    const titles = await page
      .locator('[data-testid^="unrooted-agent-"] [title]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") ?? ""));
    expect(titles).toHaveLength(24);
    expect(titles.every((title) => title.startsWith("/Users/demo/"))).toBe(true);
  });
});

test.describe("(b) same-named rows are told apart", () => {
  test("24 rows, 24 distinct labels — the six worktrees grow leftward", async ({ page }) => {
    await expand(page);
    const labels = await unrootedLabels(page);
    expect(labels).toHaveLength(24);
    expect(new Set(labels).size).toBe(24);
    expect(labels).toContain("design-eng/ari/ari-grade-repo");
    expect(labels).toContain("design-eng-fix/ari/ari-grade-repo");
    expect(labels).toContain("design-agent-port-pin/ari/ari-grade-repo");
  });

  test("only the colliding rows pay: a unique name keeps ONE parent segment", async ({ page }) => {
    await expand(page);
    expect(await unrootedLabels(page)).toContain("pkg1/filler-1");
  });

  test("two rows one segment apart stop at one segment", async ({ page }) => {
    await expand(page);
    const labels = await unrootedLabels(page);
    expect(labels).toContain("team-tools/slack-notifier");
    expect(labels).toContain("other-tools/slack-notifier");
  });

  test("24 rows, 24 distinct testids — a test can address the row it means", async ({ page }) => {
    await expand(page);
    const ids = await unrootedTestids(page);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    // Round 1 gave all six `workflow-ari-grade-repo`, so `getByTestId` was
    // strict-mode-ambiguous or silently resolved to whichever came first.
    await expect(page.getByTestId(`unrooted-agent-${ORCHESTRATION}`)).toHaveCount(1);
    await expect(page.getByTestId(`unrooted-agent-${FIX_ORCHESTRATION}`)).toHaveCount(1);
  });

  test("the prefix and the name are ONE flex child, separator outside the truncating span", async ({
    page,
  }) => {
    // [SEEN] rule 2. A clipped prefix that loses its separator reads as one
    // word where there were two things.
    await expand(page);
    const row = page.getByTestId(`unrooted-agent-${ORCHESTRATION}`).locator(".tree-row-name");
    const shape = await row.evaluate((node) => [...node.children].map((child) => child.className));
    expect(shape).toEqual([
      "tree-row-prefix",
      // `-loose`: `ari-grade-repo` lives in a folder called `orchestration`, so
      // `ari/ari-grade-repo` would name a location that is not on disk. The
      // separator says "two things", not "one path". See `prefixIsPathTail`.
      "tree-row-sep tree-row-sep-loose",
      "tree-row-label",
    ]);
    await expect(row.locator(".tree-row-sep")).toHaveText("·");
  });

  /**
   * F17: the row must not compose a path that does not exist.
   *
   * The registry takes an agent's name from its `package.json`, so name-vs-folder
   * drift is the NORMAL case, and on the real install it was the dominant one.
   * `prefix/name` is only a real path tail when the agent's folder is named for
   * the agent — so the slash appears only then.
   */
  test("the separator is a slash ONLY when prefix + name is a real path", async ({ page }) => {
    await expand(page);
    // `slack-notifier` lives in a folder called `slack-notifier`: a real tail.
    await expect(
      page
        .getByTestId("unrooted-agent-/Users/demo/team-tools/slack-notifier")
        .locator(".tree-row-sep"),
    ).toHaveText("/");
    // `ari-grade-repo` lives in `orchestration`: not a path, so not a slash.
    await expect(
      page.getByTestId(`unrooted-agent-${ORCHESTRATION}`).locator(".tree-row-sep"),
    ).toHaveText("·");
  });
});

test.describe("(c) there is a way OUT", () => {
  test("the folder chooser names each candidate and how many agents it takes", async ({ page }) => {
    await expand(page);
    await page.getByTestId(`unrooted-open-${ORCHESTRATION}`).click();
    const choices = await page
      .locator('[data-testid^="unrooted-open-choice-"]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).innerText.replace(/\n/g, " ")));
    // The agent's OWN folder leads — the honest default, and the one
    // `projectRootForAgent` falls back to. The count is what makes the wider
    // choices decidable rather than a guess.
    expect(choices[0]).toContain("orchestration");
    expect(choices[0]).toContain("1 agent");
    expect(choices.some((choice) => choice.includes("design-eng") && choice.includes("2 agents"))).toBe(
      true,
    );
  });

  test("opening a folder files the agents under it and shrinks the section", async ({ page }) => {
    await expand(page);
    await expect(page.getByTestId("unrooted-count")).toHaveText("24");

    await page.getByTestId(`unrooted-open-${ORCHESTRATION}`).click();
    await page.getByTestId("unrooted-open-choice-/Users/demo/design-eng").click();

    await expect(page.getByTestId("project-row-design-eng")).toBeVisible();
    // `ari-grade-repo` AND `brain-agent` both live under `design-eng`, so both
    // leave the section — which is the point of choosing the wider folder.
    await expect(page.getByTestId("unrooted-count")).toHaveText("22");
    await expect(page.getByTestId(`unrooted-agent-${ORCHESTRATION}`)).toHaveCount(0);
  });

  /**
   * The folder is REMEMBERED, not just rendered — it goes into `recentDirs`,
   * which is the harness's one workspace list.
   *
   * Asserted here by re-deriving the whole rail (the axis switch rebuilds it
   * from `recentDirs`), because the mock API holds settings in memory for the
   * life of one page load: a reload resets them, so a cross-reload assertion in
   * mock mode would be asserting the fixture rather than the fix. The
   * persistence half is a real-server fact and was demonstrated against one —
   * see `real_mode_evidence` in the report.
   */
  test("the new project is remembered, not just rendered", async ({ page }) => {
    await expand(page);
    await page.getByTestId(`unrooted-open-${ORCHESTRATION}`).click();
    await page.getByTestId("unrooted-open-choice-/Users/demo/design-eng").click();
    await expect(page.getByTestId("project-row-design-eng")).toBeVisible();

    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-row-design-eng")).toBeVisible();
    await expect(page.getByTestId("unrooted-count")).toHaveText("22");
  });

  /**
   * THE FULL ROUND TRIP, both directions, in one test — "there is no way to
   * move from one state to the other" is the user's own description of the
   * defect, and a removal with no way back is a data-loss shape in the UI.
   */
  test("project → removed → outside your projects → project again", async ({ page }) => {
    await expand(page);
    await page.getByTestId(`unrooted-open-${ORCHESTRATION}`).click();
    await page.getByTestId("unrooted-open-choice-/Users/demo/design-eng").click();
    await expect(page.getByTestId("project-row-design-eng")).toBeVisible();
    await expect(page.getByTestId("unrooted-count")).toHaveText("22");

    // …and back out. Removal hides the subtree rather than relocating it (a
    // removal whose rows merely move somewhere else has renamed the project,
    // not removed it — `accumulation-guard.spec.ts` pins that), so the count
    // does NOT climb here.
    await page.getByTestId("project-remove-design-eng").click({ force: true });
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("project-row-design-eng")).toHaveCount(0);
    await expect(page.getByTestId("unrooted-count")).toHaveText("22");
    await expect(page.getByTestId(`unrooted-agent-${ORCHESTRATION}`)).toHaveCount(0);

    // …and back in, from the header `+` on the very folder that was removed.
    // This is the assertion that matters most: `hiddenByClosedProject` refuses
    // to let an EQUAL open entry un-close a root, so without a deliberate
    // reopen path the project could never come back at all.
    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("dir-picker-input").fill("/Users/demo/design-eng");
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("project-row-design-eng")).toBeVisible();
    // The TOMBSTONE is cleared, not merely out-voted by this render — it is the
    // one part of a removal that outlives the page, so a stale entry would
    // bring the project back only until the next reload.
    expect(
      await page.evaluate(
        () =>
          (
            JSON.parse(localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}") as {
              closedProjects?: string[];
            }
          ).closedProjects ?? [],
      ),
    ).toEqual([]);
  });
});
