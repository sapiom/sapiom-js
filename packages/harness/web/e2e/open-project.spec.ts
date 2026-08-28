/**
 * A project is a folder you CHOSE — round 2, defect 1.
 *
 * Round 1's rail header `+` called `setStartOpen(true)`, which opened the
 * AGENT-DETECTION dialog. So "add a project" was gated behind finding an agent
 * in the folder: point it at an empty one and the ink button stayed disabled,
 * nothing was remembered, and no row appeared. On the user's real install that
 * made the single most basic act in the rail impossible.
 *
 * The design's thesis is the opposite (§ Goals: "A project is something you
 * **chose**"). You open a project in order to build the FIRST agent in it, so
 * whether it currently holds one is not the question being asked.
 *
 * "Add a project" and "find agents under here" stay two different CONTROLS —
 * the header `+` and the nav row — pointing at one picker with the primary
 * flipped, because the folder question is genuinely one question and two
 * folder browsers would be the thing the "one `+` per question" rule is
 * against.
 *
 * `/Users/demo/scratch` is the mock filesystem's plain, agent-free folder.
 */
import { expect, test } from "@playwright/test";

/* A folder that is NOTHING yet: no agent, no session, no recentDirs entry.
   `scratch` cannot play this part — it is the fixture's bare-session project,
   so it is already a row before the dialog opens. */
const BLANK = "/Users/demo/blank-slate";

const projectRows = (
  page: import("@playwright/test").Page,
): Promise<string[]> =>
  page
    .locator('.rail-list [data-testid^="project-row-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid") ?? ""),
    );

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test.describe("the header + opens a project", () => {
  test("a folder with NO agent in it becomes a project row, and survives a reload", async ({
    page,
  }) => {
    await expect(page.getByTestId("project-row-blank-slate")).toHaveCount(0);

    await page.getByTestId("rail-add-project").click();
    await expect(page.locator(".modal-start-title")).toHaveText(
      "Add a project",
    );
    await page.getByTestId("dir-picker-input").fill(BLANK);

    // Detection still RUNS and still says what it found — it just no longer
    // decides whether the folder can be opened.
    await expect(page.getByTestId("aw-result")).toContainText(
      "No agent directly inside this folder",
    );
    await expect(page.getByTestId("open-project")).toBeEnabled();
    await page.getByTestId("open-project").click();

    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
    // The settings mutation refreshes the server-issued scope catalog in place:
    // a just-opened empty project is graphable immediately, without a reload.
    await page.getByTestId("project-select-blank-slate").click();
    await expect(page.getByTestId("system-graph-empty")).toBeVisible();
    // The row is REMEMBERED, not just rendered: `recentDirs` is the harness's
    // one workspace list, and the whole rail re-derives from it when the axis
    // changes. (A cross-RELOAD assertion belongs against a real server — the
    // mock holds settings in memory for one page load — and was run against
    // one; see `real_mode_evidence` in the report.)
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
  });

  test("an empty project offers the one thing you opened it for", async ({
    page,
  }) => {
    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("dir-picker-input").fill(BLANK);
    await page.getByTestId("open-project").click();

    const empty = page.getByTestId("project-empty-blank-slate");
    await expect(empty).toBeVisible();
    // And it is a CONTROL, not a label: the whole reason to open a folder with
    // no agent in it is to put the first one there, so the row that states the
    // emptiness is the row that offers to end it.
    await expect(empty).toHaveText("Create the first agent here");
    await expect(empty).toBeEnabled();
    await expect(empty).toHaveAttribute(
      "data-tooltip",
      "Start an agent in /Users/demo/blank-slate",
    );
    // NOT the rail-wide empty state leaking down: that one says "No agents
    // yet" and only exists when the rail has nothing at all.
    await expect(page.locator(".rail-empty")).toHaveCount(0);
  });

  test("the empty row does NOT appear under a merged root-agent project", async ({
    page,
  }) => {
    // `rfq-agent` is a root that IS an agent — `projectIsEmpty` consults
    // `rootAgent` precisely so its row does not get "no agents" printed under
    // the agent it is showing.
    await expect(page.getByTestId("workflow-rfq")).toBeVisible();
    await expect(page.getByTestId("project-empty-rfq-agent")).toHaveCount(0);
  });

  test("opening a folder that IS an agent project registers the agent too", async ({
    page,
  }) => {
    // One press, because "open this folder" and "show me what's in it" is not
    // a decision worth asking twice.
    await page.getByTestId("rail-add-project").click();
    await page
      .getByTestId("dir-picker-input")
      .fill("/Users/demo/acme-app/leasing");
    await expect(page.getByTestId("aw-result")).toContainText(
      "This is an agent project",
    );
    await page.getByTestId("open-project").click();
    /* AN AGENT'S OWN FOLDER DOES NOT BECOME A PROJECT, so the agent stays the
       ONE row it already was under `acme-app`. This asserted 2 before: opening
       `leasing` minted a second root for the agent's own directory and the same
       agent appeared twice, once nested and once at top level, because an agent
       is deliberately filed under every root that contains it. That pairing was
       the accumulation itself, and on a real install it had produced three
       agents on screen twice over. `projectRoots` now drops an agent-rooted
       entry a project already shows. */
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(1);
    await expect(page.getByTestId("project-row-leasing")).toHaveCount(0);
  });
});

test.describe("the two questions stay two controls", () => {
  test("the nav row still asks the DETECTION question, with its own primary", async ({
    page,
  }) => {
    await page.getByTestId("add-existing-agents").click();
    await expect(page.locator(".modal-start-title")).toHaveText(
      "Add existing agents",
    );
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");
    // Round 1's primary, unchanged.
    await expect(page.getByTestId("aw-add")).toBeVisible();
    await expect(page.getByTestId("open-project")).toHaveCount(0);
  });

  test("a no-agent folder in the detection flow is no longer a dead end", async ({
    page,
  }) => {
    await page.getByTestId("add-existing-agents").click();
    await page.getByTestId("dir-picker-input").fill(BLANK);
    // The immediate-child probe has nothing to register, so its button is gone
    // rather than sitting there disabled.
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    // But the other question is one press away rather than a closed dialog.
    await expect(page.getByTestId("open-project")).toBeEnabled();
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
  });

  test("a container of agents offers BOTH: open the folder, or add what is under it", async ({
    page,
  }) => {
    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    await expect(page.getByTestId("open-project")).toBeEnabled();
    await expect(page.getByTestId("aw-add-all")).toContainText(
      "Add every agent under this folder",
    );
  });
});

test.describe("round trip: removed, then back", () => {
  /**
   * THE DATA-LOSS SHAPE. `hiddenByClosedProject` deliberately refuses to let an
   * EQUAL open entry un-close a root — otherwise the next boot's re-recorded
   * cwd would silently undo every removal. Without a deliberate reopen path,
   * that means a removed project can never come back, and its agents are hidden
   * with no row anywhere in the rail.
   */
  test("remove a project, then open the same folder — the project and its agents come back", async ({
    page,
  }) => {
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();
    const before = await projectRows(page);
    expect(before).toContain("project-row-acme-app");

    await page.getByTestId("project-remove-acme-app").click({ force: true });
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("project-row-acme-app")).toHaveCount(0);
    // Removal takes the SUBTREE, agents included — it is not a relocation.
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(0);

    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    await page.getByTestId("open-project").click();

    await expect(page.getByTestId("project-row-acme-app")).toBeVisible();
    await expect(page.getByTestId("workflow-leasing")).toBeVisible();
    // And it STAYS back: the TOMBSTONE is cleared, not merely out-voted by this
    // render. It is the one part of a removal that outlives the page, so a
    // stale entry would bring the project back only until the next reload.
    expect(
      await page.evaluate(
        () =>
          (
            JSON.parse(
              localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}",
            ) as {
              closedProjects?: string[];
            }
          ).closedProjects ?? [],
      ),
    ).toEqual([]);
  });

  /**
   * THE HOLE THE EQUAL-ENTRY RULE LEAVES. Remove `~/demo/acme-app`, then open
   * `~/demo` ABOVE it. `~/demo` is not itself closed so its row renders, and
   * the nested-project rescue does not apply (it needs an open root STRICTLY
   * INSIDE the closed one) — so `leasing` sits inside a project the user has
   * open and is rendered nowhere at all. `openProject` therefore drops every
   * tombstone inside the folder being opened: you cannot open a folder as a
   * project and keep part of it removed.
   */
  test("opening a folder ABOVE a removed project un-hides what is inside it", async ({
    page,
  }) => {
    await page.getByTestId("project-remove-acme-app").click({ force: true });
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(0);

    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("dir-picker-input").fill("/Users/demo");
    await page.getByTestId("open-project").click();

    await expect(page.getByTestId("project-row-demo")).toBeVisible();
    /* ONE row, and the hole is still closed. The invariant this test exists for
       is that `leasing` is rendered SOMEWHERE once `~/demo` is open, and it is:
       under `~/demo`.
       It asserted 2 before, on the rule that an agent files under every root
       that contains it. That rule is intact, but it takes two CHOSEN roots, and
       after the removal above `acme-app` is not one: the user closed it, and it
       survives only as the cwd of some exited sessions. Rendering it again as a
       project would resurrect a folder they just removed, and print its agent
       twice to do it. */
    await expect(page.getByTestId("workflow-leasing")).toHaveCount(1);
    expect(
      await page.evaluate(
        () =>
          (
            JSON.parse(
              localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}",
            ) as {
              closedProjects?: string[];
            }
          ).closedProjects ?? [],
      ),
    ).toEqual([]);
  });
});
