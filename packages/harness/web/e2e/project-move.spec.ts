/**
 * Moving an agent on disk by dragging it on the Project axis (SAP-2930).
 *
 * `lib/agent-move.test.ts` pins the decision and `src/server/agent-move.test.ts`
 * pins the mover on a real filesystem. What neither can see is the thing this
 * ticket is actually about: whether the gesture REACHES either of them. In the
 * reference prototype a weak drag test looked green because it only counted
 * rows — and a count-only assertion ("the row count didn't grow") passes when
 * nothing happened at all. So every assertion here is about what CHANGED, or
 * about what was said, and the payload's own trip through `dataTransfer` is
 * read directly.
 *
 * This spec is MUTATION-TESTED: stubbing `onDropInto` in `WorkflowsRail.tsx` to
 * a no-op fails "a drag between directories moves the agent on disk" (and the
 * refusal and payload tests with it). See the ticket's report.
 *
 * Runs against `?mockFixtures=deep`, which is the only fixture that can reach
 * the name-collision branch at all: `backend/src/agents/ads` and
 * `services/workers/ads` share the directory basename `ads`, deliberately (see
 * `MOCK_DEEP_WORKFLOWS`). Every other fixture has globally unique basenames, so
 * that branch was unreachable through the UI.
 */
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const ROOT = "/Users/demo/polsia";
const POLSIA = "workspace-group-polsia";

/** The Project axis's own drag type — the marker that a drag OFFERS a move. */
const MOVE_MIME = "application/x-sapiom-agent-move";
/** The Group axis's, for the "a group drag moves nothing on disk" case. */
const GROUP_AGENT_MIME = "application/x-sapiom-agent";

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId(POLSIA)).toBeVisible();
});

/**
 * One HTML5 drag, driven through real `DragEvent`s over ONE `DataTransfer` —
 * the same helper `group-axis.spec.ts` uses, and for the same reason:
 * `page.dragTo` moves a mouse and carries no dataTransfer, which is where this
 * feature's whole payload lives.
 */
async function dragAgent(
  page: Page,
  source: Locator,
  target: Locator,
): Promise<void> {
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  expect(sourceHandle, "drag source is on screen").not.toBeNull();
  expect(targetHandle, "drop target is on screen").not.toBeNull();
  await page.evaluate(
    ([from, to]) => {
      const transfer = new DataTransfer();
      const init = { dataTransfer: transfer, bubbles: true, cancelable: true };
      (from as Element).dispatchEvent(new DragEvent("dragstart", init));
      (to as Element).dispatchEvent(new DragEvent("dragover", init));
      (to as Element).dispatchEvent(new DragEvent("drop", init));
      (from as Element).dispatchEvent(new DragEvent("dragend", init));
    },
    [sourceHandle, targetHandle] as const,
  );
}

/**
 * The DISTINCT absolute paths the rail prints, sorted.
 *
 * The honest question about a move is "which paths exist", not "how many rows
 * are there" — an agent files under every open root that holds it, so one path
 * can legitimately print twice. Every row's `title` is its absolute path (an
 * assertion `project-axis.spec.ts` owns), which is what makes this readable.
 */
async function pathsOnScreen(page: Page): Promise<string[]> {
  const titles = await page
    .locator(".rail-list [title]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("title") ?? ""),
    );
  return [
    ...new Set(titles.filter((title) => title.startsWith("/Users/demo"))),
  ].sort();
}

/** Every move the rail actually DISPATCHED to the mover this page load. */
const dispatchedMoves = (
  page: Page,
): Promise<Array<{ from: string; to: string }>> =>
  page
    .evaluate(
      () =>
        (window as unknown as { __HARNESS_TEST__?: { agentMoves?: unknown } })
          .__HARNESS_TEST__?.agentMoves as
          | Array<{ from: string; to: string }>
          | undefined,
    )
    .then((moves) => moves ?? []);

/** An agent row inside the `polsia` project — `ads-worker` and `queue` file
 *  under two open roots, so an unscoped testid matches twice. */
const rowIn = (page: Page, name: string): Locator =>
  page.getByTestId(POLSIA).getByTestId(`workflow-${name}`);

/** The element carrying the row's `title`, which IS its absolute path: the
 *  trigger button inside the row, not the row's own draggable container. */
const pathOf = (page: Page, name: string): Locator =>
  rowIn(page, name).locator(".workflow-item-trigger");

test.describe("a move", () => {
  test("dragging an agent between directories moves it on disk, and the tree re-derives from the new path", async ({
    page,
  }) => {
    const before = await pathsOnScreen(page);
    expect(before).toContain(`${ROOT}/scripts/tools/rollup`);
    // Its whole unbranched chain is compacted onto its own row as the prefix
    // `tools`, which is the context that has to CHANGE when it moves.
    await expect(
      page.getByTestId(
        "workflow-prefix-/Users/demo/polsia/scripts/tools/rollup",
      ),
    ).toHaveText("tools");

    await dragAgent(
      page,
      rowIn(page, "rollup"),
      page.getByTestId("dir-row-services"),
    );

    // The row now says it lives somewhere else — the `title` IS the path.
    await expect(pathOf(page, "rollup")).toHaveAttribute(
      "title",
      `${ROOT}/services/rollup`,
      {
        timeout: 5_000,
      },
    );
    // And the tree re-derived rather than relabelling: `services` owns its own
    // directory row, so the agent under it needs no prefix at all, and the
    // three-segment `scripts/tools` chain is simply gone from the rail.
    await expect(
      page.getByTestId(
        "workflow-prefix-/Users/demo/polsia/scripts/tools/rollup",
      ),
    ).toHaveCount(0);
    const after = await pathsOnScreen(page);
    expect(after).not.toContain(`${ROOT}/scripts/tools/rollup`);
    expect(after).toContain(`${ROOT}/services/rollup`);
    // Exactly one path changed. Nothing else moved, appeared or vanished.
    expect(after.filter((p) => !before.includes(p))).toEqual([
      `${ROOT}/services/rollup`,
    ]);
    expect(before.filter((p) => !after.includes(p))).toEqual([
      `${ROOT}/scripts/tools/rollup`,
    ]);

    // The mover was asked for exactly that move, once.
    expect(await dispatchedMoves(page)).toEqual([
      { from: `${ROOT}/scripts/tools/rollup`, to: `${ROOT}/services/rollup` },
    ]);
    // A successful move says nothing: the rail showing the new location IS the
    // feedback.
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });

  test("dropping onto the PROJECT row moves the agent to the project root", async ({
    page,
  }) => {
    // The root is a directory like any other, so it is a drop target too —
    // without it there is no way to drag an agent back out to the top level.
    await dragAgent(
      page,
      rowIn(page, "rollup"),
      page.getByTestId("project-row-polsia"),
    );
    await expect(pathOf(page, "rollup")).toHaveAttribute(
      "title",
      `${ROOT}/rollup`,
      {
        timeout: 5_000,
      },
    );
    expect(await pathsOnScreen(page)).toContain(`${ROOT}/rollup`);
  });
});

test.describe("a refusal", () => {
  test("a move onto an EXISTING name is refused with a reason, not a clobber", async ({
    page,
  }) => {
    // The branch no fixture could reach until one grew two `ads` directories.
    // `services/workers/ads` dragged into `backend/src/agents`, which already
    // holds an `ads`.
    const before = await pathsOnScreen(page);
    await dragAgent(
      page,
      rowIn(page, "ads-worker"),
      page.getByTestId("dir-row-backend/src/agents"),
    );

    await expect(page.getByTestId("toast")).toContainText(
      "agents already has an agent called ads.",
      { timeout: 5_000 },
    );
    // Refused, not attempted: the mover was never asked.
    expect(await dispatchedMoves(page)).toEqual([]);
    // And nothing was clobbered — both `ads` directories are still on screen.
    expect(await pathsOnScreen(page)).toEqual(before);
    expect(before).toContain(`${ROOT}/backend/src/agents/ads`);
    expect(before).toContain(`${ROOT}/services/workers/ads`);
  });

  test("a drop into the folder the agent ALREADY occupies changes nothing and says nothing", async ({
    page,
  }) => {
    const before = await pathsOnScreen(page);
    await dragAgent(
      page,
      rowIn(page, "ads"),
      page.getByTestId("dir-row-backend/src/agents"),
    );

    // Silence is the correct feedback: the user let go somewhere harmless.
    // Waited out rather than asserted instantly, so "no toast" cannot pass just
    // by being read before the toast would have rendered.
    await expect(pathOf(page, "ads")).toHaveAttribute(
      "title",
      `${ROOT}/backend/src/agents/ads`,
    );
    await expect(page.getByTestId("toast")).toHaveCount(0);
    expect(await dispatchedMoves(page)).toEqual([]);
    expect(await pathsOnScreen(page)).toEqual(before);
  });

  test("a move into the agent's OWN subtree is refused", async ({ page }) => {
    // `mv a a/b` relocates the destination along with the source and leaves
    // nothing behind. There is no such row to drop on, so the gesture is
    // synthesized straight onto the drop target with the agent's own path — the
    // same shape a keyboard move or a stale row would produce.
    const before = await pathsOnScreen(page);
    const target = await page
      .getByTestId("dir-row-backend/src/agents")
      .elementHandle();
    await page.evaluate(
      ([to, agentPath, mime]) => {
        const transfer = new DataTransfer();
        transfer.setData(mime as string, agentPath as string);
        const init = {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        };
        // The drop target is `backend/src/agents`, and the payload claims the
        // dragged agent IS that directory's parent chain — a drop inside itself.
        (to as Element).dispatchEvent(new DragEvent("drop", init));
      },
      [target, `${ROOT}/backend/src`, MOVE_MIME] as const,
    );
    await expect(page.getByTestId("toast")).toContainText("inside itself", {
      timeout: 5_000,
    });
    expect(await dispatchedMoves(page)).toEqual([]);
    expect(await pathsOnScreen(page)).toEqual(before);
  });
});

test.describe("the payload", () => {
  test("rides in dataTransfer, and the hover highlight keys on `types`", async ({
    page,
  }) => {
    const source = rowIn(page, "rollup");
    await expect(source).toHaveAttribute("draggable", "true");
    const target = page.getByTestId("dir-row-services");

    const carried = await page.evaluate(
      ([from, to, mime]) => {
        const transfer = new DataTransfer();
        const init = {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        };
        (from as Element).dispatchEvent(new DragEvent("dragstart", init));
        // Read on the transfer, not from any component state: `dragstart` and
        // `drop` can land in the same tick, and a state setter has not
        // re-rendered by then.
        const path = transfer.getData(mime as string);
        // `dragover` ALONE, with no drop, must highlight the row it is over.
        (to as Element).dispatchEvent(new DragEvent("dragover", init));
        return { path, types: [...transfer.types] };
      },
      [
        await source.elementHandle(),
        await target.elementHandle(),
        MOVE_MIME,
      ] as const,
    );

    expect(carried.path).toBe(`${ROOT}/scripts/tools/rollup`);
    expect(carried.types).toContain(MOVE_MIME);
    await expect(target).toHaveClass(/is-drop-target/);
  });

  test("a foreign drag highlights nothing and moves nothing", async ({
    page,
  }) => {
    // Without the type check, any dragged file or text selection would light up
    // the tree and imply a move the row cannot perform.
    const target = page.getByTestId("dir-row-services");
    await page.evaluate(
      ([to]) => {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", "/etc/passwd");
        const init = {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        };
        (to as Element).dispatchEvent(new DragEvent("dragover", init));
        (to as Element).dispatchEvent(new DragEvent("drop", init));
      },
      [await target.elementHandle()] as const,
    );
    await expect(target).not.toHaveClass(/is-drop-target/);
    expect(await dispatchedMoves(page)).toEqual([]);
  });
});

test.describe("the Group axis", () => {
  test("moves nothing on disk — its drag carries no move payload at all", async ({
    page,
  }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("filing-group-by").selectOption("group");
    await page.keyboard.press("Escape");
    // "Projects" on both axes. Rationale at group-axis.spec.ts's openGroupAxis.
    await expect(page.locator(".rail-header-label")).toHaveText("Projects");
    await expect(page.getByTestId("group-create-polsia")).toBeVisible();

    const before = await pathsOnScreen(page);
    const project = page.getByTestId(POLSIA);
    const source = project
      .getByTestId("group-section-gateway")
      .getByTestId("group-agent-queue");
    const target = project.getByTestId("group-row-mailer");

    // What its `dragstart` puts on the transfer: an agent and a source group,
    // and NOT the move marker. So a group drag cannot reach the mover even if
    // it landed on a directory row.
    const types = await page.evaluate(
      ([from]) => {
        const transfer = new DataTransfer();
        (from as Element).dispatchEvent(
          new DragEvent("dragstart", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
        return [...transfer.types];
      },
      [await source.elementHandle()] as const,
    );
    expect(types).toContain(GROUP_AGENT_MIME);
    expect(types).not.toContain(MOVE_MIME);

    await dragAgent(page, source, target);
    // The drop DID something — membership changed, so this is not a green test
    // over a drag that never happened.
    await expect(
      project
        .getByTestId("group-section-mailer")
        .getByTestId("group-agent-queue"),
    ).toBeVisible();
    // And nothing on disk moved.
    expect(await dispatchedMoves(page)).toEqual([]);
    expect(await pathsOnScreen(page)).toEqual(before);
  });
});
