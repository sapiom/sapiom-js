/**
 * The Group axis, rendered (SAP-2929).
 *
 * The unit tests in `lib/agent-groups.test.ts` pin the membership model — what a
 * drop means, what materializes, what serializes. What they cannot see is the
 * thing this ticket exists for: a persistence effect that ran on MOUNT and wrote
 * `groups: []` for a `groups: null` state, so the FIRST page load converted
 * "detection owns this" into "the user deleted everything", and from the second
 * load onward every agent fell into `Ungrouped`, in every project, permanently.
 * The bug was in a mount effect, not in the serializer, so a unit test on the
 * serializer is necessary and not sufficient — "loading the page twice leaves
 * the derived groups intact" is asserted here, through a real second load.
 *
 * Runs against `?mockFixtures=deep`, whose launch edges (MOCK_LAUNCH_EDGES in
 * `lib/api.ts`) produce every case at once: a three-member component named for
 * its head, a smaller second component, an edge to an agent this install lacks,
 * and agents no edge reaches at all.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const POLSIA = "workspace-group-polsia";
/** `polsia/services/workers` opened as its own project — a second scope. */
const WORKERS = "workspace-group-polsia/services/workers";

/** Switch the rail to the Group axis and wait for it to be editable. */
async function openGroupAxis(page: Page): Promise<void> {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("filing-group-by").selectOption("group");
  await page.keyboard.press("Escape");
  await expect(page.locator(".rail-header-label")).toHaveText("Groups");
  // The create row appears only once this project's stored arrangement AND the
  // launch edges have loaded, so it is the honest "ready" signal.
  await expect(page.getByTestId("group-create-polsia")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId(POLSIA)).toBeVisible();
  await openGroupAxis(page);
});

/** The group rows of one project, in DOM order. */
const groupLabels = (project: Locator): Promise<string[]> =>
  project.locator('[data-testid^="group-row-"] .tree-row-label').allInnerTexts();

/** The agent rows inside one group section, in DOM order. */
const agentsIn = (project: Locator, group: string): Promise<string[]> =>
  project
    .getByTestId(`group-section-${group}`)
    .locator('[data-testid^="group-agent-"] .tree-row-label')
    .allInnerTexts();

/**
 * The DISTINCT absolute paths the rail prints, sorted. Nothing a group edit does
 * may change this set: a group is a label OVER agents, so no drop can invent,
 * rename or remove a path.
 *
 * Distinct rather than a row count, because a COPY legitimately prints one agent
 * twice — the question is which paths exist on disk, not how many rows mention
 * one.
 */
async function pathsOnScreen(page: Page): Promise<string[]> {
  const titles = await page
    .locator(".rail-list [title]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") ?? ""));
  return [...new Set(titles.filter((title) => title.startsWith("/Users/demo")))].sort();
}

/** Every rail-state write the mock has served this page load. */
const railStateWrites = (page: Page): Promise<Array<{ root: string; raw: string | null }>> =>
  page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: { railStateWrites?: unknown } }).__HARNESS_TEST__
        ?.railStateWrites as Array<{ root: string; raw: string | null }> | undefined,
  ).then((writes) => writes ?? []);

/**
 * One HTML5 drag, driven through real `DragEvent`s over ONE `DataTransfer`.
 *
 * `page.dragTo` moves a mouse; it does not carry a dataTransfer, and this
 * feature's whole payload rides there — the ticket's own note is that a
 * state-held payload reads as null exactly when the drop needs it. So the events
 * are dispatched with a shared DataTransfer, which is what a browser does and
 * what the handlers read.
 */
async function dragAgent(
  page: Page,
  source: Locator,
  target: Locator,
  options: { alt?: boolean } = {},
): Promise<void> {
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  expect(sourceHandle, "drag source is on screen").not.toBeNull();
  expect(targetHandle, "drop target is on screen").not.toBeNull();
  await page.evaluate(
    ([from, to, alt]) => {
      const transfer = new DataTransfer();
      const init = { dataTransfer: transfer, bubbles: true, cancelable: true, altKey: alt === true };
      (from as Element).dispatchEvent(new DragEvent("dragstart", init));
      (to as Element).dispatchEvent(new DragEvent("dragover", init));
      (to as Element).dispatchEvent(new DragEvent("drop", init));
      (from as Element).dispatchEvent(new DragEvent("dragend", init));
    },
    [sourceHandle, targetHandle, options.alt === true] as const,
  );
}

test.describe("derivation", () => {
  test("launch-connected agents form one group named for its HEAD, with Ungrouped last", async ({
    page,
  }) => {
    const project = page.getByTestId(POLSIA);
    // `gateway` launches `queue` and `ads-worker`; nothing launches `gateway`,
    // so the component is named for it. Biggest component first — a derived
    // group has no author to have arranged it.
    expect(await groupLabels(project)).toEqual(["gateway", "mailer", "Ungrouped"]);
    expect(await agentsIn(project, "gateway")).toEqual(["gateway", "ads-worker", "queue"]);
    expect(await agentsIn(project, "mailer")).toEqual(["mailer", "sender"]);

    // Ungrouped is NAMED and LAST. Most agents in a real repo launch nothing, so
    // hiding them would make the axis lie by omission.
    const rows = await groupLabels(project);
    expect(rows[rows.length - 1]).toBe("Ungrouped");
    expect(await agentsIn(project, "Ungrouped")).toEqual(["ads", "outreach", "rollup"]);
  });

  test("an edge to an agent this install LACKS forms no group", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    // `outreach` launches `ghost-agent`, which is not in the registry. That is
    // not a group of one plus a ghost; it is not an edge you can draw.
    expect(await groupLabels(project)).not.toContain("outreach");
    expect(await agentsIn(project, "Ungrouped")).toContain("outreach");
  });

  test("`Ungrouped` offers neither rename nor delete", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    // Both affordances DROP rather than being disabled: a greyed-out control
    // still says "this is a thing you could do here", and renaming the absence
    // of membership would name something that is not there.
    await expect(project.getByTestId("group-rename-Ungrouped")).toHaveCount(0);
    await expect(project.getByTestId("group-delete-Ungrouped")).toHaveCount(0);
    // A real group has both.
    await expect(project.getByTestId("group-rename-gateway")).toHaveCount(1);
    await expect(project.getByTestId("group-delete-gateway")).toHaveCount(1);
    // Double-clicking Ungrouped's label opens no field either.
    await project.getByTestId("group-row-Ungrouped").locator(".workspace-row-main").dblclick();
    await expect(project.getByTestId("group-rename-input")).toHaveCount(0);
  });

  test("groups cannot span projects: a second scope derives its own", async ({ page }) => {
    // `polsia/services/workers` holds `ads-worker` and `queue`, and the edges
    // that connect them both come from `gateway`, which lives in the OTHER
    // project. So this scope has no group at all — which is exactly what
    // project-scoped persistence implies.
    const workers = page.getByTestId(WORKERS);
    expect(await groupLabels(workers)).toEqual(["Ungrouped"]);
    expect(await agentsIn(workers, "Ungrouped")).toEqual(["ads-worker", "queue"]);
  });

  test("a project with one agent shows no group row at all", async ({ page }) => {
    // A group is a RELATIONSHIP, and one agent has none. `dashboard-keeper` is a
    // root that IS an agent, so it keeps the Project axis's merged single row
    // rather than growing a header plus an identically-named child underneath a
    // group called Ungrouped.
    const solo = page.getByTestId("workspace-group-dashboard-keeper");
    await expect(solo.locator(".workspace-row")).toHaveCount(1);
    await expect(solo.locator(".workspace-row")).toHaveAttribute(
      "data-testid",
      "workflow-dashboard-keeper",
    );
    expect(await groupLabels(solo)).toEqual([]);
  });

  test("the left icon is the ONE disclosure control, and it folds the group", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    const row = project.getByTestId("group-row-gateway");
    // No second disclosure idiom: exactly one control, and it LEADS the row.
    expect(
      await row.evaluate((element) => {
        const disclosures = element.querySelectorAll(":scope > .row-disclosure");
        return {
          count: disclosures.length,
          leads: disclosures[0] === element.firstElementChild,
        };
      }),
    ).toEqual({ count: 1, leads: true });
    await expect(page.locator(".rail-list .workspace-caret")).toHaveCount(0);

    await project.getByTestId("group-disclosure-gateway").click();
    expect(await agentsIn(project, "gateway")).toEqual([]);
    await project.getByTestId("group-disclosure-gateway").click();
    expect(await agentsIn(project, "gateway")).toEqual(["gateway", "ads-worker", "queue"]);
  });
});

test.describe("persistence", () => {
  test("LOADING THE PAGE TWICE leaves the derived groups intact", async ({ page }) => {
    // THE regression. A mount effect serialized the un-materialized state as
    // `groups: []` — "the user deleted every group" — so the second load put
    // every agent in Ungrouped, forever. Two real loads, and nothing written.
    const project = page.getByTestId(POLSIA);
    expect(await groupLabels(project)).toEqual(["gateway", "mailer", "Ungrouped"]);
    expect(await railStateWrites(page), "a plain load writes nothing").toEqual([]);

    await page.reload();
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();
    expect(await groupLabels(page.getByTestId(POLSIA))).toEqual([
      "gateway",
      "mailer",
      "Ungrouped",
    ]);
    expect(await railStateWrites(page)).toEqual([]);

    // A third, for the same reason a second was not enough for the prototype.
    await page.reload();
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();
    expect(await groupLabels(page.getByTestId(POLSIA))).toEqual([
      "gateway",
      "mailer",
      "Ungrouped",
    ]);
    expect(await agentsIn(page.getByTestId(POLSIA), "gateway")).toEqual([
      "gateway",
      "ads-worker",
      "queue",
    ]);
    expect(await railStateWrites(page)).toEqual([]);
  });

  test("a group edit survives reload and changes NOTHING on disk", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    const before = await pathsOnScreen(page);

    // Option-drag COPIES: a shared subagent belongs everywhere it is used.
    await dragAgent(
      page,
      project.getByTestId("group-section-gateway").getByTestId("group-agent-queue"),
      project.getByTestId("group-row-mailer"),
      { alt: true },
    );
    // Rows inside a group are PATH-ordered, not arrival-ordered: `WorkflowInfo`
    // carries no timestamp, so an agent row has nothing to be "recent" by.
    await expect
      .poll(() => agentsIn(project, "mailer"))
      .toEqual(["mailer", "sender", "queue"]);
    expect(await agentsIn(project, "gateway")).toEqual(["gateway", "ads-worker", "queue"]);

    // Not one path moved: a group is a label over agents.
    expect(await pathsOnScreen(page)).toEqual(before);

    await page.reload();
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();
    const reloaded = page.getByTestId(POLSIA);
    expect(await agentsIn(reloaded, "mailer")).toEqual(["mailer", "sender", "queue"]);
    expect(await agentsIn(reloaded, "gateway")).toEqual(["gateway", "ads-worker", "queue"]);
    expect(await pathsOnScreen(page)).toEqual(before);

    // The stored file names only paths that already existed, and only membership.
    const stored = await page.evaluate(
      () => window.localStorage.getItem("sapiom-mock-studio-rail:/Users/demo/polsia") ?? "",
    );
    const parsed = JSON.parse(stored);
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed).sort()).toEqual(["groups", "renames", "version"]);
    for (const member of parsed.groups.flatMap((group: { members: string[] }) => group.members)) {
      expect(before).toContain(member);
    }
  });

  test("the axis choice itself survives a reload", async ({ page }) => {
    await page.reload();
    await expect(page.locator(".rail-header-label")).toHaveText("Groups");
    await page.getByTestId("history-trigger").click();
    await expect(page.getByTestId("filing-group-by")).toHaveValue("group");
  });
});

test.describe("drag semantics", () => {
  test("a plain drag MOVES: joins the target, leaves the source", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    const before = await pathsOnScreen(page);

    await dragAgent(
      page,
      project.getByTestId("group-section-mailer").getByTestId("group-agent-sender"),
      project.getByTestId("group-row-gateway"),
    );

    await expect
      .poll(() => agentsIn(project, "gateway"))
      .toEqual(["sender", "gateway", "ads-worker", "queue"]);
    expect(await agentsIn(project, "mailer")).toEqual(["mailer"]);
    // GROUP-AXIS DRAG MOVES NOTHING ON DISK.
    expect(await pathsOnScreen(page)).toEqual(before);
  });

  test("Option-drag COPIES, so one agent sits in two groups", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    await dragAgent(
      page,
      project.getByTestId("group-section-gateway").getByTestId("group-agent-ads-worker"),
      project.getByTestId("group-row-mailer"),
      { alt: true },
    );
    await expect
      .poll(() => agentsIn(project, "mailer"))
      .toEqual(["mailer", "sender", "ads-worker"]);
    expect(await agentsIn(project, "gateway")).toContain("ads-worker");
  });

  test("adding the same agent to one group twice is a NO-OP, not a second row", async ({
    page,
  }) => {
    const project = page.getByTestId(POLSIA);
    const section = project.getByTestId("group-section-gateway");
    // Dropping an agent back where it already is. Two identical rows in one
    // group are unresolvable by looking at them.
    await dragAgent(
      page,
      section.getByTestId("group-agent-queue"),
      project.getByTestId("group-row-gateway"),
    );
    await expect(section.getByTestId("group-agent-queue")).toHaveCount(1);
    expect(await agentsIn(project, "gateway")).toEqual(["gateway", "ads-worker", "queue"]);
  });

  test("dropping on `Ungrouped` leaves EVERY group", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    // First put `queue` in two groups, so "leaves every group" is a claim with
    // something to prove.
    await dragAgent(
      page,
      project.getByTestId("group-section-gateway").getByTestId("group-agent-queue"),
      project.getByTestId("group-row-mailer"),
      { alt: true },
    );
    await expect.poll(() => agentsIn(project, "mailer")).toContain("queue");

    await dragAgent(
      page,
      project.getByTestId("group-section-mailer").getByTestId("group-agent-queue"),
      project.getByTestId("group-row-Ungrouped"),
    );
    await expect.poll(() => agentsIn(project, "Ungrouped")).toContain("queue");
    expect(await agentsIn(project, "gateway")).not.toContain("queue");
    expect(await agentsIn(project, "mailer")).not.toContain("queue");
  });

  test("the payload rides in dataTransfer, and the hover highlight keys on `types`", async ({
    page,
  }) => {
    const project = page.getByTestId(POLSIA);
    const source = project
      .getByTestId("group-section-gateway")
      .getByTestId("group-agent-queue");
    await expect(source).toHaveAttribute("draggable", "true");

    // What `dragstart` actually puts on the transfer — and that `dragover`
    // alone, with no drop, highlights the row it is over.
    const payload = await page.evaluate(
      ([from, to]) => {
        const transfer = new DataTransfer();
        const init = { dataTransfer: transfer, bubbles: true, cancelable: true };
        (from as Element).dispatchEvent(new DragEvent("dragstart", init));
        const carried = {
          agent: transfer.getData("application/x-sapiom-agent"),
          group: transfer.getData("application/x-sapiom-group"),
        };
        (to as Element).dispatchEvent(new DragEvent("dragover", init));
        return carried;
      },
      [
        await source.elementHandle(),
        await project.getByTestId("group-row-mailer").elementHandle(),
      ] as const,
    );
    expect(payload.agent).toBe("/Users/demo/polsia/services/workers/queue");
    expect(payload.group).toBe("group:/Users/demo/polsia/services/gateway");
    await expect(project.getByTestId("group-row-mailer")).toHaveClass(/is-drop-target/);
  });

  test("a drop from ANOTHER project is REFUSED: groups cannot span projects", async ({ page }) => {
    // The arrangement lives in one project's `.sapiom/`, so a group holding a
    // neighbour's agent would be a group with nowhere to be stored.
    //
    // `sender` is inside `polsia` and NOT inside `polsia/services/workers`, so
    // it is genuinely another project's agent. (`queue` would not do: it sits
    // under both open roots, and an agent files under every root that holds it —
    // dragging it between those two scopes is a legitimate edit.)
    const workers = page.getByTestId(WORKERS);
    const polsia = page.getByTestId(POLSIA);
    await workers.getByTestId("group-create-polsia/services/workers").click();
    await workers.getByTestId("group-rename-input").fill("workers only");
    await workers.getByTestId("group-rename-input").press("Enter");
    await expect(workers.getByTestId("group-section-workers only")).toBeVisible();

    await dragAgent(
      page,
      polsia.getByTestId("group-section-mailer").getByTestId("group-agent-sender"),
      workers.getByTestId("group-row-workers only"),
    );
    // A NEGATIVE assertion passes when nothing happened at all, including when
    // the drop machinery is broken — so a legitimate drop onto the same row
    // follows, and it is that arrival which is waited on. Whatever the refused
    // drop was going to do has certainly happened by then.
    await dragAgent(
      page,
      workers.getByTestId("group-section-Ungrouped").getByTestId("group-agent-ads-worker"),
      workers.getByTestId("group-row-workers only"),
    );
    await expect.poll(() => agentsIn(workers, "workers only")).toEqual(["ads-worker"]);

    // `sender` never joined, and it never left the group it was dragged from.
    expect(await agentsIn(workers, "workers only")).not.toContain("sender");
    expect(await agentsIn(polsia, "mailer")).toEqual(["mailer", "sender"]);
    // …and no write was ever aimed at `polsia`.
    expect(
      (await railStateWrites(page)).filter((write) => write.root === "/Users/demo/polsia"),
    ).toEqual([]);
  });
});

test.describe("create and rename", () => {
  test("creating a group opens straight into its NAME FIELD", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    await project.getByTestId("group-create-polsia").click();

    // A group is created before it is named, so without this the user's first
    // sight of it is the placeholder label — the exact "every group reads New
    // group" problem naming is meant to solve. And the field must survive the
    // focus restore that closing the create affordance triggers: a blur nothing
    // typed has not earned is ignored once.
    const input = project.getByTestId("group-rename-input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("New group");
    await expect(project.getByTestId("group-row-New group")).toBeVisible();
  });

  test("an empty or whitespace-only name is DISCARDED", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    await project.getByTestId("group-create-polsia").click();
    const input = project.getByTestId("group-rename-input");
    await expect(input).toBeFocused();

    await input.fill("");
    await input.press("Enter");
    // The group keeps the name it had: a nameless row is unreadable, and
    // reaching it by pressing Enter on an empty field would leave a row you
    // cannot find in order to fix.
    await expect(project.getByTestId("group-row-New group")).toBeVisible();

    await project.getByTestId("group-rename-New group").click();
    await project.getByTestId("group-rename-input").fill("    ");
    await project.getByTestId("group-rename-input").press("Enter");
    await expect(project.getByTestId("group-row-New group")).toBeVisible();

    // A real name commits, trimmed.
    await project.getByTestId("group-rename-New group").click();
    await project.getByTestId("group-rename-input").fill("  trend loop  ");
    await project.getByTestId("group-rename-input").press("Enter");
    await expect(project.getByTestId("group-row-trend loop")).toBeVisible();
    await expect(project.getByTestId("group-row-New group")).toHaveCount(0);
  });

  test("Escape abandons a rename instead of committing it", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    await project.getByTestId("group-rename-gateway").click();
    const input = project.getByTestId("group-rename-input");
    await input.fill("something else");
    await input.press("Escape");
    await expect(project.getByTestId("group-row-gateway")).toBeVisible();
    await expect(project.getByTestId("group-row-something else")).toHaveCount(0);
  });

  test("a new group is a place to drag into, and deleting it keeps the agents", async ({
    page,
  }) => {
    const project = page.getByTestId(POLSIA);
    await project.getByTestId("group-create-polsia").click();
    await project.getByTestId("group-rename-input").fill("shared");
    await project.getByTestId("group-rename-input").press("Enter");

    const section = project.getByTestId("group-section-shared");
    // An empty group says what to do rather than looking like a render failure.
    await expect(section.locator(".workspace-group-empty")).toHaveText("Drag agents here");

    await dragAgent(
      page,
      project.getByTestId("group-section-gateway").getByTestId("group-agent-queue"),
      project.getByTestId("group-row-shared"),
      { alt: true },
    );
    await expect.poll(() => agentsIn(project, "shared")).toEqual(["queue"]);

    // Delete removes the LABEL, not the agents: `queue` is still in `gateway`,
    // and still on screen.
    await project.getByTestId("group-delete-shared").click();
    await expect(project.getByTestId("group-section-shared")).toHaveCount(0);
    await expect(project.getByTestId("workflow-queue")).toHaveCount(1);
  });
});

test.describe("reset to detected", () => {
  test("absent while derived, present once stored, and it restores detection", async ({ page }) => {
    const project = page.getByTestId(POLSIA);
    // A control that does nothing reads as a broken one, so on a purely derived
    // state it is not offered at all.
    await expect(project.getByTestId("group-reset-polsia")).toHaveCount(0);

    // One edit materializes, and the reset appears — WITH the groups still
    // holding real work. A reset that only showed up after you had deleted
    // everything would ask people to destroy their groups to find it.
    await dragAgent(
      page,
      project.getByTestId("group-section-gateway").getByTestId("group-agent-queue"),
      project.getByTestId("group-row-mailer"),
    );
    const reset = project.getByTestId("group-reset-polsia");
    await expect(reset).toBeVisible();
    // The cost is in the COPY, not paid for by hiding the control.
    await expect(reset.locator(".rail-add-row-cost")).toHaveText("Discards 2 groups");
    expect(await agentsIn(project, "mailer")).toEqual(["mailer", "sender", "queue"]);

    // Armed, then performed: it discards work, so it says so first.
    await reset.click();
    await expect(reset.locator(".tree-row-label")).toHaveText("Confirm reset");
    await reset.click();

    await expect.poll(() => groupLabels(project)).toEqual(["gateway", "mailer", "Ungrouped"]);
    expect(await agentsIn(project, "gateway")).toEqual(["gateway", "ads-worker", "queue"]);
    expect(await agentsIn(project, "mailer")).toEqual(["mailer", "sender"]);
    // Back to derived, so the control withdraws again.
    await expect(project.getByTestId("group-reset-polsia")).toHaveCount(0);
  });

  test("the reset SURVIVES a reload — it erases the file rather than ignoring it", async ({
    page,
  }) => {
    const project = page.getByTestId(POLSIA);
    await dragAgent(
      page,
      project.getByTestId("group-section-gateway").getByTestId("group-agent-queue"),
      project.getByTestId("group-row-mailer"),
    );
    await expect(project.getByTestId("group-reset-polsia")).toBeVisible();

    const reset = project.getByTestId("group-reset-polsia");
    await reset.click();
    await expect(reset.locator(".tree-row-label")).toHaveText("Confirm reset");
    await reset.click();
    await expect.poll(() => groupLabels(project)).toEqual(["gateway", "mailer", "Ungrouped"]);

    // The file is GONE, not rewritten as `groups: []` — which would mean "the
    // user deleted every group" and put the rail straight back where the reset
    // rescued it from.
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem("sapiom-mock-studio-rail:/Users/demo/polsia"),
        ),
      )
      .toBeNull();

    await page.reload();
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();
    const reloaded = page.getByTestId(POLSIA);
    expect(await groupLabels(reloaded)).toEqual(["gateway", "mailer", "Ungrouped"]);
    expect(await agentsIn(reloaded, "mailer")).toEqual(["mailer", "sender"]);
    await expect(reloaded.getByTestId("group-reset-polsia")).toHaveCount(0);
  });

  test("it rescues the stuck state: every group deleted, everything Ungrouped", async ({
    page,
  }) => {
    const project = page.getByTestId(POLSIA);
    await project.getByTestId("group-delete-gateway").click();
    await expect.poll(() => groupLabels(project)).toEqual(["mailer", "Ungrouped"]);
    await project.getByTestId("group-delete-mailer").click();
    await expect.poll(() => groupLabels(project)).toEqual(["Ungrouped"]);
    // Materialized with nothing in it: every agent falls to Ungrouped and no
    // amount of editing gets detection back, because every edit works on the
    // stored set that IS the problem.
    expect(await agentsIn(project, "Ungrouped")).toHaveLength(8);

    const reset = project.getByTestId("group-reset-polsia");
    await expect(reset.locator(".rail-add-row-cost")).toHaveText(
      "Restores the launch-edge grouping",
    );
    await reset.click();
    await reset.click();
    await expect.poll(() => groupLabels(project)).toEqual(["gateway", "mailer", "Ungrouped"]);
  });
});

test("the group rail renders", async ({ page }) => {
  await page.screenshot({ path: "web/e2e/screenshots/group-axis.png", fullPage: true });

  // The two list-end rows are below the fold on a 720px viewport, and they are
  // the affordances that read as missing when they are wrong — so they get their
  // own frame. An edit first, so the reset row is on screen at all.
  const project = page.getByTestId(POLSIA);
  await dragAgent(
    page,
    project.getByTestId("group-section-gateway").getByTestId("group-agent-queue"),
    project.getByTestId("group-row-mailer"),
  );
  await expect(project.getByTestId("group-reset-polsia")).toBeVisible();
  await project.getByTestId("group-reset-polsia").scrollIntoViewIfNeeded();
  await page
    .locator(".rail-workflows")
    .screenshot({ path: "web/e2e/screenshots/group-axis-list-end.png" });
});
