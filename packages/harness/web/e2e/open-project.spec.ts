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
 * Under flow-creation.md rev 4 there is one folder question and one control
 * for it, the header's Add project (D28); a folder full of agents is added
 * the same way as an empty one, and detection is gone.
 *
 * `/Users/demo/scratch` is the mock filesystem's plain, agent-free folder.
 */
import { expect, test } from "@playwright/test";


/* A folder that is NOTHING yet: no agent, no session, no recentDirs entry.
   `scratch` cannot play this part — it is the fixture's bare-session project,
   so it is already a row before the dialog opens. */
const BLANK = "/Users/demo/blank-slate";

type Page = import("@playwright/test").Page;

/** The project headers the rail draws, as `workspace-group-<label>`. */
const projectRows = (page: Page): Promise<string[]> =>
  page
    .locator('.rail-list [data-testid^="workspace-group-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid") ?? ""),
    );

/** The project's agents are listed on its map (flow-navigation.md Q3): the
 *  mock draws no map, so they are cards there. */
const agentCardsOn = async (page: Page, project: string) => {
  await page.getByTestId(`project-select-${project}`).click();
  await expect(page.getByTestId("project-map-pane")).toBeVisible();
  return page.locator('[data-testid^="map-agent-"]:not([data-testid^="map-agent-panel"])');
};

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=agent-map");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test.describe("the header + opens a project", () => {
  test("a folder with NO agent in it becomes a project row, with no session and no screen", async ({
    page,
  }) => {
    await expect(page.getByTestId("workspace-group-blank-slate")).toHaveCount(0);

    await page.getByTestId("rail-add-project").click();
    const dialog = page.getByTestId("project-folder-dialog");
    await expect(dialog.locator(".modal-title")).toHaveText("Add project");
    await page.getByTestId("folder-field-input").fill(BLANK);

    /* ONE LINE, ONE ACTION. The dialog checks that the folder EXISTS, and
       nothing else: no detection, no readout of what it found, and the primary
       is the only thing in the footer (flow-creation.md §4.5, D28). */
    await expect(page.getByTestId("project-folder-hint")).toHaveText(
      "Choose a folder to work in. Any agents inside come with it.",
    );
    await expect(page.getByTestId("aw-result")).toHaveCount(0);
    await expect(page.getByTestId("aw-add-all")).toHaveCount(0);
    await expect(page.getByTestId("project-folder-continue")).toHaveText("Add project");
    await expect(page.getByTestId("project-folder-continue")).toBeEnabled();
    await page.getByTestId("project-folder-continue").click();

    const group = page.getByTestId("rail-project-blank-slate");
    await expect(page.getByTestId("workspace-group-blank-slate")).toBeVisible();
    // The project header owns its read-only Agent Map destination, and the
    // map is the centre once the folder opens.
    await expect(
      group.getByTestId("project-select-blank-slate"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("project-map-pane")).toBeVisible();
    // A project with no sessions shows its header and + only (4.6.1).
    await expect(group.locator(".rail-session-row")).toHaveCount(0);
    await expect(page.getByTestId("project-new-chat-blank-slate")).toBeVisible();
    // NOTHING FOLLOWS (flow-creation.md rev 4 §4.1 step 3, Q5): no automatic
    // first session, no "Plan Agents" tab, no new-agent screen. The user types
    // first.
    await page.waitForTimeout(300);
    await expect(group.locator(".rail-session-row")).toHaveCount(0);
    await expect(page.getByText("Plan Agents", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: { createSessionCalls?: unknown[] };
            }
          ).__HARNESS_TEST__?.createSessionCalls?.length ?? 0,
      ),
    ).toBe(0);
  });

  test("a Studio project opens on its map with no session started for it", async ({
    page,
  }) => {
    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("folder-field-input").fill(BLANK);
    await page.getByTestId("project-folder-continue").click();

    await expect(page.getByTestId("project-map-pane")).toBeVisible();
    // No pty was spawned for it: the map is a view, not a session.
    await expect(page.locator(".harness-terminal .xterm")).toHaveCount(0);

    // The header's verbs: New chat at rest, Remove on hover (flow Q11).
    // New agent is the project view's header verb, not the row's.
    await expect(page.getByTestId("project-new-chat-blank-slate")).toHaveAttribute(
      "aria-label",
      "New chat in blank-slate",
    );
    await expect(page.getByTestId("project-create-agent-blank-slate")).toHaveCount(0);
    await expect(page.getByTestId("project-map-new-agent")).toBeVisible();
    await expect(page.getByTestId("project-remove-blank-slate")).toBeAttached();

    // NOT the rail-wide empty state leaking down: that one only exists when
    // the rail has nothing at all.
    await expect(page.locator(".rail-empty")).toHaveCount(0);
  });

  test("opening a folder that IS an agent project registers the agent too", async ({
    page,
  }) => {
    // One press, because "open this folder" and "show me what's in it" is not
    // a decision worth asking twice.
    await page.getByTestId("rail-add-project").click();
    await page
      .getByTestId("folder-field-input")
      .fill("/Users/demo/acme-app/leasing");
    await page.getByTestId("project-folder-continue").click();
    /* AN AGENT'S OWN FOLDER DOES NOT BECOME A PROJECT, so the agent stays the
       ONE row it already was under `acme-app`. This asserted 2 before: opening
       `leasing` minted a second root for the agent's own directory and the same
       agent appeared twice, once nested and once at top level, because an agent
       is deliberately filed under every root that contains it. That pairing was
       the accumulation itself, and on a real install it had produced three
       agents on screen twice over. `projectRoots` now drops an agent-rooted
       entry a project already shows. */
    await expect(page.getByTestId("workspace-group-leasing")).toHaveCount(0);
    /* AND THE PRESS DID SOMETHING. Opening an agent's own folder opens the
       folder that HOLDS it (`openProject` in use-harness-state), so the project
       here is `acme-app`. Without that the button was a silent no-op: the
       picker said "This is an agent project", the user pressed Open, and the
       rail was unchanged, which is also what would have made the row removal
       irreversible for exactly these folders. */
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(await agentCardsOn(page, "acme-app")).toHaveCount(1);
  });
});

test.describe("Add project is one question", () => {
  /**
   * THE COMPETING BUTTON IS GONE, and it was a duplicate rather than a choice.
   * "Add a project" used to offer BOTH "Add every agent under this folder" and
   * "Open project", with nothing on screen saying how they differed — because
   * they did not: `openProject` (use-harness-state) scans the whole tree after
   * remembering the root, so the folder's agents arrive either way.
   */
  test("Add project offers ONE action, and it still brings the agents", async ({
    page,
  }) => {
    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("folder-field-input").fill("/Users/demo/acme-app");
    await expect(page.getByTestId("aw-add-all")).toHaveCount(0);
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    await expect(page.getByTestId("project-folder-continue")).toBeEnabled();

    await page.getByTestId("project-folder-continue").click();
    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("map-agent-leasing")).toBeVisible();
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
    await expect(page.getByTestId("rail-session-sess-boot")).toBeVisible();
    const before = await projectRows(page);
    expect(before).toContain("workspace-group-acme-app");

    await page.getByTestId("project-remove-acme-app").click();
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("workspace-group-acme-app")).toHaveCount(0);
    // Removal takes the SUBTREE, sessions included — it is not a relocation.
    await expect(page.getByTestId("rail-session-sess-boot")).toHaveCount(0);

    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("folder-field-input").fill("/Users/demo/acme-app");
    await page.getByTestId("project-folder-continue").click();

    await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
    await expect(page.getByTestId("map-agent-leasing")).toBeVisible();
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
    await page.getByTestId("project-remove-acme-app").click();
    await page.getByTestId("remove-project-confirm-btn").click();
    await expect(page.getByTestId("workspace-group-acme-app")).toHaveCount(0);

    await page.getByTestId("rail-add-project").click();
    await page.getByTestId("folder-field-input").fill("/Users/demo");
    await page.getByTestId("project-folder-continue").click();

    await expect(page.getByTestId("workspace-group-demo")).toBeVisible();
    /* ONE row, and the hole is still closed. The invariant this test exists for
       is that `leasing` is rendered SOMEWHERE once `~/demo` is open, and it is:
       under `~/demo`.
       It asserted 2 before, on the rule that an agent files under every root
       that contains it. That rule is intact, but it takes two CHOSEN roots, and
       after the removal above `acme-app` is not one: the user closed it, and it
       survives only as the cwd of some exited sessions. Rendering it again as a
       project would resurrect a folder they just removed, and print its agent
       twice to do it. */
    await expect(
      (await agentCardsOn(page, "demo")).filter({ hasText: "/Users/demo/acme-app/leasing" }),
    ).toHaveCount(1);
    await expect(page.getByTestId("workspace-group-acme-app")).toHaveCount(0);
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
